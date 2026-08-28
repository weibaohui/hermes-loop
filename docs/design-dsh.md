# hermes-loop — dsh 插件设计文档

> 把 Hermes 的 Learning Loop 移植成 dsh 插件：对话收尾后自动复盘，把有价值的经验蒸馏成 skill。
> 前置阅读：[research-hermes.md](./research-hermes.md)（Hermes 机制调研）。

## 1. 目标与非目标

**目标**
- 对话收尾后，自动评估本轮对话是否产生了值得沉淀的经验（用户纠正、踩坑、非平凡工作流、既有 skill 的缺陷）；
- 有则自动生成/修补 skill（class-level 命名纪律、防碎片化），无则安静退出；
- 全程不阻塞、不干扰前台对话；成本可控（digest 输入、便宜的模型、触发阈值）；
- 可选的人工审批通道（stage → approve/reject）。

**非目标（v1）**
- 不做 memory 层（USER.md/MEMORY.md）——dsh 平台的 memory 机制另行调研；
- 不做 FTS5 式会话回查——依赖宿主自身的会话存储能力；
- 不做 Curator 的全量 LLM 合并 pass（v2 再说），v1 只做防碎片化的写入纪律。

## 2. 平台能力盘点与核心缺口

| Hermes 机制 | dsh 平台对应物 | 缺口 |
|---|---|---|
| turn 尾部钩子（turn_finalizer） | **无**。ctx 没有 session/turn/chat 事件可订阅 | ⚠️ 核心缺口，见 §3 |
| fork review agent（同进程、缓存复用、工具白名单） | `agents.create()` headless 起子会话（skills-management `runShareInProcess` 模式，src/index.js:403-447） | 无法复用主 agent 的 prefix cache（成本劣势）；工具白名单靠 agentPreset 控制 |
| `skill_manage` 写入口 | 文件系统直写用户库（`$DSH_HOME/skills`，即 skills-management 的 installedDir） | 写入后 skills-management 的 SkillRegistry provider 是否需要显式 invalidate 待验证，见 §6 |
| `memory` 写入口 | dsh 自有 memory 机制，v1 不做 | — |
| read-before-write 代码守卫 | 自研（review 循环是我们自己写的） | 无 |
| write_approval staging | 自研（pending 目录 + 审批 UI） | 无 |
| Curator 定时维护 | `ctx.effect` + setInterval（scheduled-items 模式） | 无 |
| 配置开关 | `ctx.inject(['settings'])` + zod schema（skills-management 模式） | 无 |

其他硬约束（来自既有经验，见 dsh-plugin-platform-gotchas）：
- `agents.create` 必须钉 `agentPreset: 'standard'`，否则继承用户默认导致缺工具；
- headless 子会话无流式，用 `agent.followup()` + `await agent.whenIdle()` + 300ms 事件泵收集输出；
- 宿主半端不能进 agent preset（cordis.patch.yml 的 HOST-PLANE 纪律）。

## 3. 触发方案选型（核心决策）

dsh 没有 turn 尾部钩子，四条路：

| 方案 | 思路 | 评价 |
|---|---|---|
| **A. 自报端点（推荐）** | system prompt 注入收尾纪律：完成非平凡任务后，把对话摘要 POST 到插件 HTTP 端点；端点起 review agent 复盘 | ✅ 事件来源由主 agent 判断（它最清楚这轮有没有干货）；Hermes 的"每 turn 自觉评估"精神不变，只是评估结果的表达从"直接调 skill_manage"变成"上报摘要"；成本低（不上报就零开销）；hermes-prompt 已有纪律注入的底子 |
| B. 客户端钩子 | 客户端模块监听对话完成事件后调端点 | ❓ 未验证 dsh 客户端是否有对话完成事件，作为开放问题；若有，可与 A 互补 |
| C. 轮询会话库 | 定时器轮询宿主会话存储，发现新完成的会话就复盘 | ❌ 侵入宿主数据、重复复盘难去重、延迟大，放弃 |
| D. 纯 prompt（现状） | hermes-prompt 让主 agent 自己写 skill | ❌ 依赖模型自觉，写出的 skill 质量无守卫、无审批、无防碎片化，这正是本插件要解决的 |

**选 A，D 作为 A 的降级**（review 服务不可用时，prompt 纪律仍然有效）。

### 方案 A 的数据流

```
主 agent（收尾，prompt 纪律触发）
   │  POST /hermes-loop/api/review
   │  { sessionPath?, digest, signals: [...], transcriptTail? }
   ▼
webServer handler（立即 202 返回，不阻塞主 agent）
   │  入队（防并发 review 堆积，同 session 冷却）
   ▼
review runner（队列消费）
   │  agents.create({ agentPreset:'standard', agentOptions:{provider,model} })
   │  followup(reviewPrompt + digest + signals + transcriptTail)
   │  whenIdle() + 事件泵收集 review 结论
   ▼
skill writer
   │  解析 review agent 的结构化结论（NOTHING / CREATE / PATCH <name> + 内容）
   │  read-before-write 校验 → 写入用户库（或 stage 到 pending）
   ▼
回显：logger + （可选）写回会话一条 plugin 通知
```

digest 由主 agent 生成（prompt 里给模板：任务目标 / 关键步骤 / 踩的坑 / 用户纠正 / 最终结果），**不重放全量对话**——这是与 Hermes 最大的差异（Hermes fork 重放全对话靠 prefix cache 便宜；dsh 没有这个条件，且宿主插件拿不到别人会话的完整消息数组，见 ntd-migration docs 已承认的"宿主插件能否读子会话"开放问题）。

## 4. Review agent 设计

### 工具面

review agent 起子会话后只发一条 followup，prompt 要求它**只输出结构化结论、不实际写文件**（写入由我们的 skill writer 执行，这样 read-before-write 守卫和审批 staging 都是代码级的，比 Hermes 的工具运行时拒绝更硬）。review agent 需要能**列出/读取既有 skill**来做四级优先序检索——v1 通过 prompt 内嵌"既有 skill 清单（name + description ≤60 字符）"注入，避免依赖工具；skill 多了再改。

### Review prompt 移植要点（全部来自 research §2/§3）

1. 主动倾向："多数对话至少值得一次小更新，什么都不做不是中性结果"；
2. 正向信号四条：用户纠正（风格/语气/格式/冗长度 = FIRST-CLASS signal）、工作流纠正、非平凡技巧/修复/绕过、既有 skill 有错 → PATCH IT NOW；
3. 负面清单五条：环境故障、对工具的负面断言、已自愈的暂时错误、一次性任务叙事、未解决的失败；
4. 四级优先序：PATCH 会话内已用过的 → PATCH 既有 umbrella → 在 umbrella 下加 references → 全无覆盖才 CREATE；
5. 命名纪律：class-level，禁止 PR 号/错误串/代号式命名；"名字只对今天的任务有意义就是错的"；
6. 输出格式： fenced JSON `{ action: 'nothing'|'create'|'patch', skill: name, description, body, rationale }`（JSON 比 Hermes 的直接调工具更适合我们的代码守卫模式）；
7. memory/skill 分工声明：流程进 skill，事实进 memory（v1 memory 不做，prompt 里明确"用户画像类信息本轮不沉淀"）。

### 防御

- review agent 的事件泵只收集文本输出，tool/call 仅记日志——它被 prompt 限制为纯分析，即使越权调用工具，产物也不落盘；
- 单次 review 的 followup 轮数=1、输入 = digest + 清单（几 K token），成本天然有界；
- 用户发新消息不影响 review（独立子会话）；插件 dispose 时中止队列并放弃未完成 job（ctx.effect 清理）。

## 5. 触发纪律的 prompt 注入

复用 hermes-prompt 的 `ctx.systemPrompt.section` 通道（order 50 已被 hermes-prompt 占用；本插件用 order 51 或协调合并——见开放问题 §8）：

> 收尾时自查：本轮是否出现①用户纠正（不满表达）②踩坑/绕过 ③非平凡多步工作流 ④已加载 skill 的缺陷？任一成立 → 调用沉淀：POST 到 `/hermes-loop/api/review`，body 按 digest 模板填写。都不成立 → 什么都不发。简单一次性任务不发。

注意与 hermes-prompt 的关系：hermes-prompt 是"纪律宣言"（存不存、存哪、先问用户），hermes-loop 把它落成"一个具体可调用的端点 + 有守卫的写入管道"。长期看 hermes-prompt 的沉淀章节应收敛到指向本插件的端点，避免两套纪律打架。

## 6. Skill 写入路径

- 目标目录：用户技能库（`$DSH_HOME/skills`，即 skills-management 的 installedDir，与 `~/.claude/skills` 等 15 个执行器目录无关）；
- 写入内容：`<name>/SKILL.md`（frontmatter：name 小写连字符、description ≤60 字符、version 0.x.0；body 章节参照 Hermes 规范：When to Use / Prerequisites / Procedure / Pitfalls / Verification）；
- **read-before-write 守卫（代码级）**：patch 动作要求 digest 附带"已读 skill 清单"或 review 前强制快照一次目标 skill，缺失即拒绝；
- **审批模式**（settings 切换）：
  - `auto`（默认）：直接落盘；
  - `approval`：写入 `~/.dsh/hermes-loop/pending/<id>.json`（含 diff），v0.2 在 skills-management 客户端加"待审 skill"列表 + approve/reject；
- **写入后可见性**：skills-management 的 SkillRegistry provider 若有缓存，需要 invalidate 才能进模型可见目录。⚠️ 开放问题：跨插件拿不到它的 providerControl。候选解：① 给 skills-management 加一个内部刷新端点（一行改动，POST 即 invalidate）；② 验证其 provider list() 是否每次重扫目录（若是则无需处理）。v0.1 先做实验确认。

## 7. 配置项（ctx.settings + zod）

```yaml
hermes-loop:
  enabled: true
  mode: auto            # auto | approval | off(只记日志不落盘)
  provider: ""          # review agent 模型覆盖，空=跟随默认（Hermes 的"便宜模型"位）
  model: ""
  cooldownMinutes: 30   # 同一 session 两次 review 的最小间隔
  minSignals: 1         # digest.signals 少于 N 条直接跳过（省 token 的第一道闸）
  descLimit: 60         # skill description 上限（对齐 Hermes 的 60 字符路由索引）
  maxDigestChars: 12000 # digest 超长截断
```

## 8. 开放问题

1. **skills-management provider 缓存语义**（阻塞 §6）：list() 是否重扫目录？决定要不要加刷新端点；
2. **order 51 的 systemPrompt section 是否与 hermes-prompt 冲突**：需要读 dsh systemPrompt 服务的排序/去重行为，或直接改 hermes-prompt 收编本插件的触发指令；
3. **dsh 客户端有没有对话完成事件**（方案 B）：若有，可替代/加固主 agent 自报（自报可能被忘、被格式写错）；客户端 hook 也承担 approve/reject UI；
4. **digest 可信度**：主 agent 可能美化过程（报喜不报忧）。缓解：prompt 强调"踩坑和纠正是最有价值的输入"；transcriptTail 兜底（末尾 N 条消息原文，若宿主允许取到）；
5. **多 workspace 场景**：skill 写入用户库是全局的，但 digest 里的坑可能是 workspace 特有的——Hermes 用项目级 `~/.hermes/skills/` 解决，dsh 是否有 per-workspace skill 目录待调研。

## 9. 分阶段实现计划

- **v0.1（最小闭环）**：HTTP 端点 + 队列 + review agent（结构化结论）+ auto 落盘 + read-before-write 守卫 + 触发纪律 prompt 注入 + settings；验证 §8.1 的缓存语义并打通"review 产出的 skill 对下一轮对话可见"；
- **v0.2（信任与可见）**：approval 模式 + skills-management 客户端"待审/已沉淀"列表（复用其 client 模式，注意 NO class component / NO createRoot）；review 结论回显到会话（plugin source followup，对齐 scheduled-items 的 `source:{kind:'plugin'}`）；
- **v0.3（防碎片化）**：Curator 定时 pass（stale 标记、归档不删除）、umbrella 检索增强（embedding 或关键词索引）、客户端开关"本 workspace 暂停沉淀"。
