# Hermes Learning Loop 机制调研

> 调研对象：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。
> 本调研基于直接克隆源码阅读（2026-08，克隆在 /tmp/hermes-agent），关键结论均标注源码文件，非二手文章转述。
> 目的：搞清 Hermes「每次对话完成后自动总结、形成 skill」到底怎么实现的，为 dsh 插件 `hermes-loop` 的设计提供依据。

## 0. 一句话结论

**Hermes 没有独立的"会话结束总结"步骤。** 它的核心是一条 Learning Loop：

1. 每轮回复交付之后，由一个 **fork 出来的后台 review agent**（同模型、复用父 agent 缓存的 system prompt）重放本轮对话；
2. review agent 的工具白名单**只有 `memory` 和 `skill_manage` 两个写入口**，它用固定 prompt 自行评估"这轮对话有没有值得沉淀的东西"，有就直接写盘；
3. 另有一个每 7 天空闲触发的后台 **Curator** 对 skill 库做合并去重，防止碎片化。

所以"每次对话完成后都能总结"不是靠会话结束钩子，而是**拆到了每个 turn 的尾部**，且由 LLM 按固定 prompt 自主判断，不是代码规则。

## 1. 触发时机与执行者

### 触发点：turn 尾部（`agent/turn_finalizer.py` ~777-800 行）

一轮对话（一条用户消息的完整回合）正常结束、响应已交付后，检查两个计数器：

| 触发 | 计数方式 | 默认阈值 |
|------|----------|----------|
| memory review | 用户 turn 计数（`agent/turn_context.py` 736-786） | 每 10 个 turn（`memory.nudge_interval`） |
| skill review | 本 turn 内的工具迭代次数（`agent/conversation_loop.py` 2099-2104，调用过 `skill_manage` 则归零） | 每 10 次迭代（`skills.creation_nudge_interval`） |

任一满足即 `_spawn_background_review(messages_snapshot, review_memory, review_skills)`。
被中断的 turn、cron 会话（`skip_background_review=True`，因为每次 fork 约 30K token）不触发。

### 执行者：同进程 fork 的 review agent（`agent/background_review.py`）

不是独立的"反思模型"，也不是主 agent 顺便做，而是 daemon 线程里 fork 的一个新 `AIAgent` 实例：

- **继承父 agent 的 provider/model**，并逐字节复用父 agent 已缓存的 system prompt 和 `tools[]`（`review_agent._cached_system_prompt = agent._cached_system_prompt`），使 fork 的首个请求命中同一个 warm prefix cache（注释称实测省 ~26% 成本）；
- **工具白名单只有 `memory` 和 `skill_manage`**（`set_thread_tool_whitelist`，其余工具运行时直接拒绝）；max_iterations=16，聚合输入 token 预算默认 600K；
- **`_persist_disabled=True / _session_db=None`：fork 绝不写会话数据库**。源码注释记录了一个真实事故：fork 曾把 review prompt 写进用户真实会话，导致下一轮主 agent"变成 curator"拒绝干活；
- **前台优先**：review 进行中用户发新消息，通过取消令牌 2 秒内中断它——review 永不阻塞、不干扰用户；
- 可路由到更便宜的模型（`auxiliary.background_review.provider: auto`，省 3-5x，此时用压缩 digest 代替全量重放）。

### 手动通道

- `/refine [focus]`：立即跑一次同样的 review，可带用户指定关注点（自动 fork 关闭时仍可用）；
- `/learn <描述>`：把"刚才一起走完的工作流"显式蒸馏成一个 skill，走前台正常 turn（`agent/learn_prompt.py`）。

## 2. "值不值得存"的评估标准

评估完全由 fork 的 LLM 按固定 prompt 判断（`background_review.py` 模块级常量 `_SKILL_REVIEW_PROMPT` 等，按 memory/skill/combined 三种触发组合选用），**没有代码层面的规则阈值**。prompt 的关键设计：

### 主动倾向（防"什么都不存"）

> "Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome."

`'Nothing to save.'` 是合法出口，但被明确定义为"不应是默认"。

### 正向信号（任一即行动）

1. **用户纠正风格/语气/格式/冗长度** —— "stop doing X" "too verbose" "just give me the answer" 等挫败表达是 **FIRST-CLASS skill signal**（不只是 memory 信号）；
2. 用户纠正工作流/步骤顺序；
3. 出现非平凡的技巧、修复、绕过、调试路径、工具用法；
4. 本会话加载过的 skill 被发现有错/缺步/过时 → **"Patch it NOW"**（当场修，不等收尾）。

### 负面清单（明确禁止沉淀，理由是"会变成咬自己几个月的自我强加约束"）

- 环境依赖故障（缺二进制、凭据未配置——用户能修的）；
- 对工具的负面断言（"X tool is broken" 会硬化成 agent 自我引用的永久拒绝）；
- 会话内已自行解决的暂时错误（该存的是重试模式，不是故障本身）；
- 一次性任务叙事（"总结今天行情"不构成一类工作）；
- **未解决的失败**——不能把没验证成功的死胡同包装成 "reliable workflow"。

### memory 与 skill 的分工

> "Memory captures 'who the user is and what the current situation and state of your operations are'; skills capture 'how to do this class of task for this user'."

memory prompt 只看用户画像（persona、偏好、对 agent 行为方式的期望）；流程性内容一律进 skill。

## 3. Skill 的生成做法

### 写入工具与防重复（四级优先序，prompt 引导 + 代码守卫）

fork 通过 `skill_manage` 工具（`tools/skill_manager_tool.py`）执行 create / edit / patch / write_file / remove_file / delete。create 还是 update 由 prompt 中的**四级优先序**引导（fork 会先 `skills_list` + `skill_view` 检索）：

1. PATCH 本会话已加载的 skill（仅限 curator-managed 的）；
2. PATCH 既有 class-level umbrella skill；
3. 在既有 umbrella 下加支持文件 `references/<topic>.md` / `templates/` / `scripts/`；
4. 全无覆盖才 CREATE 新 umbrella。

命名纪律："MUST NOT be a specific PR number, error string, feature codename … 'fix-X / debug-Y'"；"If the proposed name only makes sense for today's task, it's wrong — fall back to (1)(2)(3)。"

另有**代码级的 read-before-write 守卫**（`_background_review_read_before_write_guard`）：本次 review 中没对目标 skill 调过 `skill_view`，patch/edit 直接报错拒绝，"对话转写里引用过的内容不算数"。

### 文件格式（`agent/skill_utils.py` `_validate_frontmatter`）

- 一个 skill = 一个目录：`SKILL.md` + 可选 `references/ templates/ scripts/ assets/`；
- YAML frontmatter 必须有 `name`（小写连字符）和 `description`；**新建 skill 的 description 强制 ≤60 字符**（`SKILL_PROMPT_DESC_LIMIT = 60`，skill_utils.py:1175）——因为系统提示里的 skill 索引按 60 字符截断，超长即"静默丢失路由信号"；
- 可选 `version` / `author`（禁止从环境探测真实用户名，防隐私泄漏）/ `platforms` / `metadata.hermes.tags`；
- Body 章节规范：When to Use / Prerequisites / How to Run / Quick Reference / Procedure / Pitfalls / Verification；~100 行（简单）~200 行（复杂）；必须用 Hermes 自己的工具名表述（写 `read_file` 不写 cat/grep）；**严禁发明源码里没有的 flag/API**；
- 大语料源走 knowledge-base 形态：瘦 SKILL.md 索引 + 分章 `references/`；
- 内容上限 100K chars/文件，支持文件 1MiB。

### 存储位置与写权限

```
~/.hermes/skills/
├── my-skill/{SKILL.md, references/, ...}
└── category-name/another-skill/SKILL.md
```

多 tier 并存：bundled（随发行）、hub-installed、`skills.external_dirs`、项目级 `<root>/.hermes/skills/`（需 `hermes skills trust`）。**fork 只能写 curator-managed 的用户库**，bundled/hub/external/pinned/user-owned 一律拒绝。

### 写入审批（可选）

`skills.write_approval: true` 时 fork 的写入不落盘，stage 到 `~/.hermes/pending/skills/<id>.json`，用 `/skills pending`、`/skills diff <id>`、`/skills approve|reject <id>` 人工把关。另有 `skills.ledger: true` 记每次变更的 JSONL 审计账本。

## 4. 记忆分层与 SQLite+FTS5 的角色

| 层 | 位置 | 上限 | 作用 |
|----|------|------|------|
| MEMORY.md | `~/.hermes/memories/` | 2200 字符(~800 tok) | 环境/项目事实、约定、教训；§ 分隔条目 |
| USER.md | 同目录 | 1375 字符(~500 tok) | 用户画像、沟通偏好 |
| Skills | `~/.hermes/skills/` | 100K/文件 | 程序性记忆（"怎么做这类事"） |
| Session | `~/.hermes/state.db` (SQLite) | 全量 | 每条消息原文存 `messages` 表 |

- MEMORY.md/USER.md 在**会话开始时作为冻结快照注入 system prompt**（保持 prefix cache 稳定，会话中途写入下个会话才生效）；memory 工具只有 add/replace/remove、无 read，自动去重，写入前做提示注入/凭据外泄扫描；超限报错逼 agent 自己合并，**不自动压缩**。
- **SQLite+FTS5 只做跨会话回查，不做记忆抽取**：`messages_fts`（external-content FTS5）+ `messages_fts_trigram`（解决 CJK 子串检索），经 `session_search` 工具暴露，~20ms、零 LLM 成本。宣传语里的 "LLM summarization for cross-session recall" 主要在外部记忆 provider（Honcho/Mem0 等 8 个插件）的 recall 管道里。
- 所谓"会话结束时抽取新记忆"，实际就是第 1 节的 post-turn fork：每 10 turn 重放对话问"用户暴露了什么值得记的？"，fork 直接调 memory 工具写盘，成功后回显一行 `💾 Self-improvement review: ...` 摘要（`display.memory_notifications` 控制详细度）。

## 5. 关键 Prompt 原文摘录

**Memory review prompt**（background_review.py:465-474，完整）：

> "Review the conversation above and consider saving to memory if appropriate. Focus on: 1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering? 2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate? If something stands out, save it using the memory tool. If nothing is worth saving, just say 'Nothing to save.' and stop."

**Skill review prompt 开头**（:476-484）：

> "Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome. Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md and a `references/` directory for session-specific detail. Not a long flat list of narrow one-session-one-skill entries."

**Curator 整合 prompt**（agent/curator.py:432）核心：

> "You are running as Hermes' background skill CURATOR. This is an UMBRELLA-BUILDING consolidation pass… a collection of hundreds of narrow skills where each one captures one session's specific bug is a FAILURE of the library."

三种整合动作：MERGE INTO EXISTING UMBRELLA / CREATE NEW UMBRELLA / DEMOTE TO references-templates-scripts；且 **"DO NOT delete any skill. Archiving is the maximum destructive action"**。

## 6. Curator：后台库维护（`agent/curator.py`）

- 触发：每 7 天（`curator.interval_hours: 168`），且机器空闲 ≥2h；
- 动作：LLM 伞形合并 pass（`consolidate: false` 默认关闭，opt-in）、30 天未用标 stale、90 天未用归档（只归档不删除）；
- 手动：`hermes curator run [--consolidate|--dry-run]`。

## 7. 配置全景（`hermes_cli/config_defaults.py`）

```yaml
auxiliary:
  background_review:
    enabled: true            # false=关自动 post-turn fork；/refine 仍可用
    provider: auto           # 可路由到更便宜的模型（省 3-5x）
    model: ""
    max_input_tokens: 600000
memory:
  memory_enabled: true
  user_profile_enabled: true
  write_approval: false      # true=写入需人工批准
  memory_char_limit: 2200
  nudge_interval: 10
skills:
  creation_nudge_interval: 10
  write_approval: false
  guard_agent_created: false
  ledger: true               # 变更 JSONL 审计账本
curator:
  interval_hours: 168
  stale_after_days: 30
  archive_after_days: 90
  consolidate: false
display:
  memory_notifications: on   # off | on | verbose
```

## 8. 可移植到 dsh 的核心 insight

1. **"总结"发生在每个 turn 尾部，不是会话结束** —— 这恰好绕过了 dsh 平台"没有会话结束事件"的缺口（见 design 文档）；
2. **评估是 prompt 不是规则** —— 阈值只是触发器（省成本），"值不值得存"永远由 LLM 按固定 prompt 判断；
3. **fork 复用主 agent 的缓存与模型，但工具白名单收窄到只有写入口** —— review agent 能力最小化，写不坏会话；
4. **防碎片化靠四级优先序 + 命名纪律 + 代码级 read-before-write 守卫 + 后台 Curator** 四层防线；
5. **主动倾向 + 负面清单同样重要** —— 既要防"什么都不存"，也要防"把死胡同存成 workflow"、防"负面断言硬化成永久拒绝"；
6. **人工审批是可选项而不是默认** —— stage + approve/reject 的模式值得抄，但默认自动落盘。

## 来源

- 源码：/tmp/hermes-agent（GitHub: NousResearch/hermes-agent）
- [官方文档 Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Issue #429: Skill Lifecycle Quality](https://github.com/NousResearch/hermes-agent/issues/429)
- 中文分析（佐证，以源码为准）：[知乎：自改进学习循环详解](https://zhuanlan.zhihu.com/p/2028829290620305725)、[掘金：内置学习闭环深度解析](https://juejin.cn/post/7634760691857522698)、[InfoQ](https://www.infoq.cn/article/Xv0OsbvHjLT34YzWKc3J)
