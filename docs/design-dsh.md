# hermes-loop — dsh 插件设计文档（v2，经平台源码实证修订）

> 把 Hermes 的 Learning Loop 移植成 dsh 插件：对话收尾后自动复盘，把有价值的经验蒸馏成可复用的 skill。
> 前置阅读：[research-hermes.md](./research-hermes.md)（Hermes 机制调研）。
>
> **v2 修订说明**：对 dsh 平台源码（~/projects/ts/deepseek-harness）做了实证调研，结论推翻了 v1 的两个核心假设——
> ① dsh 宿主插件**可以**订阅所有会话的 turn 结束事件（v1 以为没有）；
> ② skill 写入**不需要**跨插件 invalidate（chokidar watcher 自动失效）。
> 因此触发方案从"主 agent 自报端点"升级为**与 Hermes 同构的 session/event 订阅**，prompt 自报降级为兜底。
>
> **v2.1 修订说明（2026-08-28 设计评审）**：① suspects 全文注入在 §2/§4.1/§6 三处对齐；② hermes-prompt 补 `ctx.provide('hermesPrompt')` 服务标记，探测由不可行的"隐式探测"改为 `ctx.get('hermesPrompt', false)`；③ 输出协议补 `baseHash`/`baseDescription` 字段，read-before-write 升级为两步（CAS + 原子 rename）；④ pending 路径对齐 `DSH_HOME`；⑤ 补 log-only 模式行为、生命周期清理、abort 链路伪代码、触发计数语义、skills-management rank 脚注。

## 0. 对等性结论：能，且保真度比 v1 方案高

| Hermes 机制 | dsh 对应物 | 对等性 |
|---|---|---|
| turn 尾部触发（turn_finalizer） | 宿主插件 `ctx.on('session/event', (session, event) => event.type === 'turn/end')`，无标签 ctx 收到**所有会话**（含前台 UI 会话）的事件 | ✅ 完全对等，甚至更干净（不需要改 agent 运行时） |
| fork 重放全量对话 | `session.deriveMessages()` 拿完整消息转写 → 截断/摘要后作为 review agent 输入 | ✅ 对等（差异：dsh 无 prefix cache 复用，成本靠截断与阈值控制） |
| fork 工具白名单（只有写入口） | `agents.create({ setup: (agentCtx) => agentCtx.tools.restrict({ allow: [...] }) })` | ✅ 对等，比 Hermes 的运行时拒绝更早生效 |
| fork 不污染会话库 | review agent 用独立 sessionId + `meta: { origin: 'subagent' }`，且 dsh 侧它本来就是独立会话 | ✅ 对等（Hermes 用 `_persist_disabled`，dsh 靠进程隔离天然成立） |
| 前台优先、review 可中断 | `agents.create({ signal: AbortSignal })`；新 turn/start 到来时 abort 旧 review | ✅ 对等 |
| `skill_manage` 写入 + read-before-write 守卫 | 插件代码直接写 skill 目录 + 自研守卫（见 §6） | ✅ 对等 |
| skill 写入即对后续会话可见 | skill-filesystem 的 chokidar watcher（~200ms 稳定阈值）自动 invalidate registry，下一个 pre-step 重新 snapshot，digest 变化即发布新目录消息 | ✅ 对等，**无需跨插件 invalidate**（实证：skill-filesystem/src/index.ts:528-588） |
| MEMORY.md/USER.md | v1 不做（见 §7 范围） | ➖ 后续 |
| Curator 定时维护 | `ctx.effect` + setInterval（scheduled-items 模式） | ✅ v3 |
| write_approval 审批 | pending 目录（已实现；**审批 UI 经评审决定不做**——Hermes 侧也只有 CLI 斜杠命令没有 GUI，dsh 侧 pending JSON 可直接手批） | ✅ 宿主侧 v0.1 / UI 取消 |

**结论：dsh 插件机制可以对等实现 Hermes Loop 的全部核心功能，且不需要任何 dsh 平台改动。**

## 1. 平台实证要点（设计所依赖的证据）

以下均已在 deepseek-harness 源码中核实（文件:行号）：

1. **事件作用域**：cordis 全进程共享一张监听表（vendor/cordis/src/context.ts:80、events.ts:165-175），分发时按载体 filter 过滤——**无标签的宿主插件 ctx 放行全部事件**；scope 标签只用于"事件沿 scope 链向上流"。权威用例：apiproxy 用 `ctx.on('session/event', ...)` 处理 turn/end（packages/host/apiproxy/src/api-proxy.ts:3412-3421）、`ctx.on('agent/status', ...)`（:3497）。
2. **turn/end 是会话日志事件**，不是 cordis 事件名：载荷 `{ turn, reason }`（packages/core/session/src/types.ts:252），reason ∈ completed/aborted/blocked/error/max-tokens/interrupted（:145-166）。监听器第一参数就是 session 对象，`session.id` 即会话 ID。
3. **转写读取**：`session.deriveMessages()`（session/src/index.ts:726-750，缓存+深冻结）拿 LLM 消息历史；`session.events` 拿全量事件日志。turn 边界不等待 flush——读内存 events 即可。
4. **agents.create**：`{ sessionId, meta: { cwd, agentPreset, origin }, agentOptions: { provider, model }, signal, setup }`（packages/core/agent/src/index.ts:405, types :80-133）；`followup(message)` source.kind 合法值 user/plugin/model/tool（llm/src/message.ts:100-105）；`whenIdle()`（runtime-types.ts:87-93）。
5. **工具白名单**：`setup(agentCtx) => agentCtx.tools.restrict({ allow })`（packages/core/tools/src/index.ts:680-686；范例 subagent/src/child-agent.ts:157-176）。多条 restrict 相交。
6. **skill 可见性**：`<available_skills>` 目录不是 system prompt，而是每个 agent pre-step 注入的 user message，description 归一化上限 **500 字符**（packages/skill/tool-skill/src/index.ts:27,390-394——不是 Hermes 的 60）；sha256 digest 对比，变化即替换目录消息（:220-236,279-311）。
7. **skill 目录 rank**（skill-filesystem/src/index.ts:36-43,241-261）：项目 `<root>/.dsh/skills`(100) / `<root>/.agents/skills`(200) / custom(300) / 用户 `~/.dsh/skills`(400) / bundled(600)，项目级遮蔽用户级——**per-workspace skill 目录天然存在**（项目根按 cwd 向上找 .git 解析）。⚠️ 脚注：skills-management 插件对**同一个用户目录**（installedDir）注册了 rank=100 的 ntd-skills provider（skills-management/src/index.js:28），会遮蔽内置 user-dsh 的 rank=400 条目——同一 skill 出现双条目时以 rank 100 者为准。hermes-loop 只要写入的**目录路径正确**（`~/.dsh/skills/`，尊重 `DSH_HOME`），两个 provider 都能扫到，无需关心谁遮蔽谁。
8. **frontmatter 校验**：必填 name（kebab-case `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`）+ description 非空（skill/src/index.ts:20,34-36；skill-filesystem :810-819）；**没有 description 长度上限**（500 只是目录渲染截断）；不合法 warn 跳过、静默不可见。
9. **systemPrompt section**：按 order 稳定排序，同 order 共存（core/system-prompt/src/index.ts:504）；同层同名 section 注册**抛错**（:316-318）——hermes-loop 的 section 名必须与 hermes-prompt 的 `hermes:discipline` 不同。
10. **插件互通**：同一根层挂载的插件互相 `ctx.inject` 服务可用（无 isolate 调用，vendor/cordis/src/service.ts:61-63）；根层服务对 agent 子树可见，反之不可见（preset/mount.ts:14-16 的审计守卫）。
11. **客户端**：web 客户端**没有**对话完成事件的转发白名单（api/remotes/src/remote-events.ts:24-37），只有 `composerPhase` 响应式快照——客户端不适合做触发源（但不影响本设计，触发在宿主侧）。

## 2. 架构（v2）

```
宿主插件 apply(ctx)
  ctx.on('session/event', onSessionEvent)
      │  event.type === 'turn/end' && event.data.reason === 'completed'
      │  过滤：跳过自己 review 产生的会话（sessionId 前缀 / meta.origin）
      │  计数器：该 session 自上次 review 以来的 turn 数 / 工具调用数
      ▼  达到阈值（或 digest 启发式命中信号词）
review runner（串行队列，防堆积）
      │  transcript = session.deriveMessages()（末尾 N 条 + 截断）
      │  catalog   = ctx.skills.snapshot({ cwd: session.header.cwd })
      │             （name + description 清单；cwd 必传——不传拿不到项目级 skill）
      │  suspects  = catalog 中与 transcript 关键词匹配的 top-N skill，
      │             读全文注入（patch 质量的前提，见 §4.1/§8.1）
      │  agents.create({ sessionId: 'hermes-loop-review-'+uuid,
      │                  meta: { agentPreset: 'standard', origin: 'subagent' },
      │                  agentOptions: { provider, model },   // 可路由便宜模型
      │                  signal })
      │  setup: agentCtx.tools.restrict({ allow: [] })   // 纯分析，零工具
      │  followup(reviewPrompt + catalog + transcriptTail)
      │  await whenIdle()，事件泵收集最终 assistant/message
      ▼  解析结构化结论 { action: nothing|create|patch, ... }
skill writer
      │  CAS 守卫：patch 前重读目标文件比对 baseHash（§6 两步守卫①）
      │  临时文件 + 原子 rename 写入（守卫②）
      │  frontmatter 校验（kebab-case name、非空 description、≤500 字符）
      │  mode=auto → 写入目标目录；mode=approval → stage 到 pending/；
      │  mode=log-only → 仅 ctx.logger.info 输出结论，不落盘
      ▼
可见性：chokidar watcher 自动 invalidate（~200ms）→ 下一会话 pre-step 可见
```

**与 Hermes 的关键差异（有意为之）**：
- **review agent 零工具**（Hermes 给它 memory+skill_manage 两个写入口）。dsh 侧改为：既有 skill 清单经 `ctx.skills.snapshot()` 注入 prompt，review agent 只输出结构化 JSON 结论，写入由插件代码执行。守卫更硬、审批更容易做，代价是失去 Hermes 的"review 中多轮检索 skill 全文"能力（v1 接受；v3 可给 review agent 只读的 skill 工具）。
- **触发阈值由代码实现**（Hermes 也是代码触发 + LLM 评估，这一点同构）。

## 3. 触发策略（对齐 Hermes turn_finalizer）

订阅 `session/event`，对 `event.type === 'turn/end' && data.reason === 'completed'` 的每个事件：

1. **排除自身**：sessionId 以 `hermes-loop-` 开头、或 `meta.origin === 'subagent'` 的会话不触发（防自反馈，对应 Hermes 的 cron 会话排除）；
2. **排除 aborted/interrupted**：被中断的 turn 不复盘（Hermes 同款规则）；
3. **计数触发**（阈值可配，默认对齐 Hermes）：
   - `turnInterval`（默认 10）：该会话自上次 review 以来累计的 completed turn 数。**重置时机**：review 进入执行（进入 runner）即重置——被 abort 的 review 同样视为已消耗该窗口，不因 abort 而立刻重触发同一批 turn；
   - `toolCallInterval`（默认 10，可选）：**自上次 review 以来的窗口累计** tool/call 事件数，与 turnInterval 平行、任一达标即触发。⚠️ 与 Hermes 原版有意差异：Hermes 是"单 turn 内工具迭代数"（turn_finalizer 单点决策），本设计改为窗口累计——事件订阅模型下没有单点收尾位置，窗口累计语义更稳定；
4. **信号加速**（Hermes 没有、dsh 侧补的廉价启发式，可选）：窗口内的 tool/call 出现过高失败率、或 assistant 文本命中用户纠正词表（"不对/别这样/too verbose"等），可把阈值打折——v2 再做，v1 只用纯计数；
5. **冷却**：同 session 两次 review 最小间隔 `cooldownMinutes`（默认 30）；
6. **全局串行 + 前台取消**（并发逻辑，落地时最易写错，伪代码钉死）：

   ```
   perSession: Map<sessionId, { queuedTask?, controller? }>   // 每会话至多一条记录
   running:    controller | null                              // 全局串行

   turn/end(completed) → 达阈值：
     若 running 为空 → 出队执行(sessionId)
     否则 → 入队（覆盖该 session 旧的 queuedTask，每 session 至多排一个）
   turn/start(sessionId)：
     perSession.get(sessionId)?.controller?.abort()   // 取消运行中的该 session review
     丢弃 perSession.get(sessionId)?.queuedTask        // 只动本 session，不碰其他会话
   review 结束（完成/abort/超时）：
     controller 从 perSession 摘除 → 出队下一个 queuedTask
   ```

   对齐 Hermes 的 2 秒取消语义——dsh 侧排队任务直接丢弃即可，运行中的靠 AbortSignal；
7. **生命周期清理**：session/event 监听、review 队列、perSession map、每个在跑 review 的 AbortController 全部挂进 `ctx.effect()` 返回的清理函数（对齐 scheduled-items / skills-management 的做法），dispose 时 abort 全部在跑 review 并清空队列，防止热重载泄漏监听与后台 agent。

成本核算：单次 review 输入 = 末尾 N 条消息（截断到 `maxTranscriptChars`，默认 ~12K 字符）+ skill 清单（几十条 × ≤500 字符）≈ 5-10K token；触发频率 = 每 10 turn 一次。比 Hermes 的全量重放（30K+）便宜。

## 4. Review agent 设计

### 输入（followup 一条消息）

1. **Review prompt**（移植 Hermes `_SKILL_REVIEW_PROMPT` 精髓，见 research §2）：
   - 主动倾向："多数对话至少值得一次小更新，什么都不做不是中性结果"；
   - 正向信号四条：用户纠正（FIRST-CLASS）、工作流纠正、非平凡技巧/修复/绕过、既有 skill 有缺陷 → PATCH IT NOW；
   - 负面清单五条：环境故障、对工具的负面断言、已自愈的暂时错误、一次性任务叙事、未解决的失败；
   - 四级优先序：PATCH 会话内已加载的 → PATCH 既有 umbrella → umbrella 下加 references → 才 CREATE；
   - 命名纪律：class-level，禁止 PR 号/错误串/一次性代号；"名字只对今天的任务有意义就是错的"；
   - memory/skill 分工：流程进 skill；用户画像类本轮不沉淀（v1 不做 memory）。
2. **既有 skill 清单**：`ctx.skills.snapshot()` 渲染为 `- name: description` 列表（这正是模型在会话里看到的同一份目录，判定"该 patch 谁"的依据）。
3. **疑似相关 skill 全文**（patch 可行性的前提）：runner 从清单中按转写关键词/名称相似度匹配 top-N（默认 3）疑似相关 skill，读取其 SKILL.md 全文注入。patch 动作要求结论里的 `body` 基于目标正文修改，看不到全文就写不出正确的 patch——§2 架构图、本节、§6 守卫三处共享同一次读取（读取时同步计算 `baseHash` 供 writer 做 CAS，见 §6）。
4. **会话转写尾部**：`session.deriveMessages()` 末尾 N 条，超长按 `maxTranscriptChars` 截断（保尾不保头——结论和纠正通常在尾部）。

### 输出协议（fenced JSON）

```json
{ "action": "nothing" | "create" | "patch",
  "skill": "kebab-case-name",          // create/patch 必填
  "description": "≤500 字符",           // create 必填
  "body": "完整 SKILL.md body（不含 frontmatter）",  // create/patch 必填
  "baseHash": "sha256(注入时的目标 SKILL.md 全文)",  // patch 必填——CAS 用（§6），runner 注入 suspects 全文时同步计算并随 prompt 给出
  "baseDescription": "注入时的目标 description 快照", // patch 必填——writer 校验 frontmatter 未被改过
  "rationale": "为什么值得/不值得存" }
```

解析失败 / 非法 action / name 不合 kebab-case → 记日志丢弃（fail-closed）。

### 硬化措施

- `tools.restrict({ allow: [] })`：review agent 无任何工具，纯文本进出；
- 独立 sessionId 命名空间 + `origin: 'subagent'`：不出现在用户会话列表的根层；
- `signal`：全局 dispose / 队列超时（`reviewTimeoutSec` 默认 300）时 abort；
- 不调用 `sessions.flush` 持久化 review 会话，用完即弃（内存态）。

## 5. systemPrompt 触发纪律（辅助，非依赖）

与 v1 不同，**触发不依赖 prompt**。但保留一个 order 51 的轻量 section（名字用 `hermes:loop-aware`，避免与 hermes-prompt 的 `hermes:discipline` 同名冲突——同层同名会抛错，system-prompt/src/index.ts:316-318）：

> 收尾时若发现已加载的 skill 有错/缺步骤，直接用你的工具当场修正它，不要等后台复盘。

这条的作用是让主 agent 具备 Hermes 的"in-session patch"能力（Hermes 的四级优先序第一条）。其余沉淀动作全部交给后台 loop，避免两套纪律打架。

**hermes-prompt 探测（已落地）**：hermes-prompt 原本只注册 `systemPrompt.section`、不暴露任何服务（systemPrompt 服务也没有"查询已注册 section"的 API，隐式探测不可行）。已在 hermes-prompt/src/index.js 的 apply 中补一行 `ctx.provide('hermesPrompt', { version })`（cordis 服务暴露必须用 `ctx.provide`——`ctx.set` 未先 provide 会抛错，vendor/cordis/src/reflect.ts:254-261）。hermes-loop 运行时经 `ctx.get('hermesPrompt', false)` 探测（strict 默认 true，未提供会抛错，必须显式传 false），取到即视为 hermes-prompt 已安装、跳过本 section；取不到则注册。

## 6. Skill 写入路径

- **目标目录**（rank 语义，见实证 §1.7）：
  - 全局经验 → `~/.dsh/skills/<name>/SKILL.md`（rank 400，与 skills-management installedDir 相同，两边都能看到对方的刷新）；
  - ~~workspace 特有经验 → `<projectRoot>/.dsh/skills/<name>/SKILL.md`~~（**2026-08-29 经评审取消**：依赖"cwd 向上找 .git"推导项目根，边界不稳定——非仓库目录、子模块、多根工作区都会导致写错位置或回退，收益不抵复杂度。**统一只写全局** `~/.dsh/skills/`；项目私货由用户手动放项目目录或用 `disable-model-invocation` 管理）；
- **写入格式**：目录 + SKILL.md；frontmatter `name`（kebab-case）+ `description`（非空，建议 ≤500 字符对齐目录渲染截断；Hermes 的 60 字符是它自家索引的限制，dsh 不适用）；body 章节规范 When to Use / Prerequisites / Procedure / Pitfalls / Verification（对齐 Hermes，同时喂给 dsh 的 skill 工具加载习惯）；
- **read-before-write 守卫（两步，缺一不可）**：patch 动作要求 review 输入里包含目标 skill 的当前 body（runner 在构造 prompt 时读取并注入，同步计算 `baseHash`，见 §4 输入第 3 条）；
  - **① CAS 比对**：writer 写入前**再读一次**目标文件，计算 sha256 与结论里的 `baseHash` 比对，不一致（review 期间被改过）→ 拒绝并重排 review；同时校验 `baseDescription` 与当前 frontmatter 一致。写入是插件进程内同步执行的，再读一次即可，无需文件锁；
  - **② 原子写入**：临时文件 + 原子 rename，防并发读到半写入的文件（rename 不解决 ABA 覆盖问题，ABA 由①解决，见 §8.3）；
- **防覆盖**：create 时目标已存在 → 降级为 nothing + 日志（避免静默覆盖用户手写的 skill；合并留给 v3 Curator）；
- **mode 行为**：
  - `auto`：写入目标目录，即刻生效；
  - `approval`：写入 pending 目录，等用户审批（无审批 UI——经 2026-08-29 评审决定不做，批 = 手动把 pending JSON 里的内容落到目标路径，或改用 auto 模式）；
  - `log-only`：**既不写 skill 目录也不写 pending**，review 结论 JSON 仅经 `ctx.logger.info` 输出——用于调试触发阈值与 prompt 质量，观察期默认值建议用它；
- **approval 模式**：写入 pending 目录 `<pendingDir>/<id>.json`（含拟写入的完整文件 + diff）。**不做审批 UI**（2026-08-29 评审决议：Hermes 自身也只有 `/skills approve` 式 CLI 命令而无 GUI，dsh 侧手动处理 pending JSON 已够用）。**pendingDir 解析对齐 skills-management installedDir 的逻辑**（skills-management/src/index.js:516）：`process.env.DSH_HOME ? join(DSH_HOME, 'hermes-loop', 'pending') : join(homedir(), '.dsh', 'hermes-loop', 'pending')`——否则设了 `DSH_HOME` 的用户里 pending 与 skill 会落在两个不同的根下；
- **可见性**：无需任何 invalidate 动作——chokidar watcher ~200ms 后自动失效 registry 缓存，下一 pre-step 重新 snapshot（实证 §1.6/§1.7）。**v1 的开放问题已解决**。唯一例外：watch 被关闭的环境才需要手动失效，运行时探测 `watch` 配置即可。

## 7. 范围与配置

**v1 范围**：skill 沉淀全链路（触发→review→写入→可见）。**不做**：memory 层（dsh 的 memory 机制另行调研）、FTS 会话回查、Curator、审批 UI。

配置（ctx.settings + zod，对齐 Hermes config_defaults）：

```yaml
hermes-loop:
  enabled: true
  mode: auto              # auto（写入）| approval（进 pending）| log-only（仅日志，不落盘）
  provider: ""            # review agent 模型覆盖（"便宜模型"位），空=跟随默认
  model: ""
  turnInterval: 10        # 每 N 个 completed turn 触发一次
  toolCallInterval: 10    # 同窗口 tool/call 计数的平行触发线
  cooldownMinutes: 30
  maxTranscriptChars: 12000
  reviewTimeoutSec: 300
  catalogDescriptionMax: 500   # 对齐 dsh 目录渲染截断
  # ── Curator（§10，v0.3）──
  curatorEnabled: true
  curatorStaleDays: 30
  curatorArchiveDays: 90
  curatorIntervalHours: 24
```

## 8. 风险与残余问题

1. **review agent 无工具的检索局限**：它只能看到注入的 skill 清单（name+description），看不到 skill 全文，patch 的内容可能与既有正文脱节。缓解：runner 在构造 prompt 时把"疑似相关 skill（名称/描述与转写关键词匹配）"的全文一并注入。v3 给 review agent 只读工具（`tools.restrict({ allow: ['skill'] })`，dsh 的 skill 工具正好是只读加载器）。
2. **转写截断的偏差**：保尾截断可能丢掉早段的关键踩坑。缓解：阈值触发时窗口本来就是近 10 个 turn；`maxTranscriptChars` 可调；v2 可改为"每个 turn 存增量摘要，review 时拼接"。
3. **多开 profile / 多 worker**：事件是进程内的，每个 dsh 进程各自跑 loop，写同一目录可能并发冲突。**原子 rename 只能防"读到半写入的文件"，防不了两个进程读同一 skill → 各自修改 → 后写覆盖前写的 ABA 问题**——ABA 由 §6 守卫①（写入前重读文件比对 baseHash 的 CAS）解决，rename 负责半写读，两步配合才完整。同 skill 冲突概率低（class-level 命名），CAS 失败走重排 review，v1 接受。
4. **dsh 版本耦合**：`session/event`、`tools.restrict`、watcher 行为都是当前 monorepo 的实现细节，升级需回归（在 README 标注已验证的 dsh 版本）。
5. **skills-management 双 provider 重名仲裁**：它自己的 ntd-skills provider 与 harness 的 user-dsh root 扫同一目录，重名由 registry 按 rank+注册顺序仲裁（skill/src/index.ts:807-811）。hermes-loop 写入的 skill 会被两边同时看到——正常现象，但 UI 上可能出现双条目，v2 验证。

## 9. 分阶段实现计划（v2 修订）

- **v0.1（最小闭环）**：`session/event` 订阅 + 阈值/冷却/排除逻辑（含 perSession abort 链路，§3.6 伪代码）+ review runner（agents.create + restrict + whenIdle + 事件泵，复用 skills-management 的 runShareInProcess 模式）+ JSON 结论解析 + auto 写入 `~/.dsh/skills` + CAS 守卫（§6 两步）+ settings + ctx.effect 生命周期清理。验收：跑 10+ turn 的真实会话，确认 review 触发、skill 落盘、**下一个新会话的 available_skills 目录里出现该 skill**；
- **v0.2（信任与体验）——已完结**：approval 模式 + pending 目录 ✅（~~待审 UI~~ 经评审取消，Hermes 亦无 GUI）；~~疑似相关 skill 全文注入~~ 提前至 v0.1 ✅；order 51 in-session patch 纪律 section ✅（7e151d3）；review 结论回显到来源会话 ✅（`session.append('user/message')` + plugin notice）；~~项目级 skill 目录写入~~ 经评审取消（不稳定，统一写全局）。
- **v2 线追加交付（2026-08-29，均在 v0.3 设计之外提前落地）**：
  - **客户端面板**：conversation.view 第 5 个 tab（c31b510 起）——模式切换、阈值进度条、冷却倒计时、沉淀技能（本对话/本插件子 tab）、复盘总结（status.reviews 聚合，后应用户要求移除 UI 保留 API）；
  - **手动"立即复盘"**：POST /api/review-now + 面板按钮 + review 运行中实时输出预览（d619090/368aac3）；
  - **技能使用统计**：tool/call 按技能计数 + skill-catalog 曝光计数，usage.json 持久化，面板统计卡（d821532）——僵尸识别（曝光多零调用）为 Curator 供数；
  - **可见性治理**：采用原生 frontmatter 键 `disable-model-invocation`（公开契约，docs/subsystems/skills.md）；patch 写入保留未知键（mergeFrontmatter）；skills-management 详情页开关 + 卡片"已隐藏"标记/隐藏按钮；usage 表状态列 + 悬停图例（98beaeb→d5e4040）；
  - **附带修复**：市场库存 6600+ 条不再灌入模型目录（skills-management 49c3a41）；settings 迁移 schemastery + 命名空间合规（token 持久化修复，58e7231/c27bddb）。
- **v0.3（防碎片化）**：~~疑似相关 skill 全文注入~~（提前至 v0.1 完成）；**Curator 纯代码退休 pass ✅（设计见 §10）**——墙钟差值 + 惰性求值的三态状态机（active↔stale→archived；归档=翻 `disable-model-invocation`，永不删除）；信号加速触发（失败率/纠正词表）。候选新增：**memory 通道**（dsh 无原生 memory 机制；Hermes 原版 review 本就 memory+skill 合体，触发/守卫全复用；待出设计补充——载体 `~/.dsh/memory/MEMORY.md`、双结论协议、systemPrompt 注入）。

## 10. Curator 设计（v0.3 补充，2026-08-29）

> 范围：hermes-loop 自己写入（`created`）的 skill。纯代码状态机，无 LLM pass；Hermes 原版的伞形合并（consolidate）本身就是默认关闭的 opt-in，同样不进本期（见 §10.7）。

### 10.1 原理（对齐 agent/curator.py，分析见 research-hermes.md §6）

复盘回路的哲学是"主动倾向"——每轮尽量沉淀，长此以往必然产生碎片。Curator 是配重的"减法"：按最后使用时间跑三态状态机 `active ↔ stale → archived`，**只归档永不删除**（"Archiving is the maximum destructive action"）。原版参数：stale 30 天 / 归档 90 天 / 巡检间隔 168 小时；pinned 与 cron 引用的技能豁免。

### 10.2 时间问题：墙钟差值 + 惰性求值（与原版的核心差异）

"距最后使用 ≥ N 天"是 `now − lastUsedAt` 的**墙钟差值——时间流逝不依赖进程存活**。必须持久化的只有事件时间戳（v0.2 的 usage.json 已按技能记录 `lastUsedAt`），评估改为惰性触发：

| 触发点 | 作用 |
|---|---|
| usage.json 加载完成后（apply 内） | 主路径：停机期间"到期"的转移在这里补齐 |
| 每次 skill 使用事件 | 用到即复活：stale → active（反正要写统计） |
| 面板"立即巡检"按钮 | POST /api/curator/run，等价 `hermes curator run` |
| setInterval（12h） | 加速器；距上次巡检不足 intervalHours 则跳过。正确性不依赖它 |

残余缺口是**事件覆盖率不是时间正确性**：插件未加载的窗口内发生的 skill 调用看不见，停机期间被用过的技能可能被误判。缓解按成本排序：① anchor 兜底 + 零调用宽限（§10.3 规则 1）；② 归档只是翻 `disable-model-invocation`，破坏性为零且面板一键可恢复；③ （后续可选）加载时经 sessions 服务回读停机窗口内的 tool/call 回填 lastUsedAt——取决于 sessions API 的查询能力，本期不做。

### 10.3 状态机（纯函数，单测覆盖）

**纳管集**：dispatch 侧 `applyConclusion` 返回 `created` 时登记（`patch` 的目标是既有技能，归属不明不纳管）。记录持久化在 usage.json 的 `curator` 节：`skills: { <name>: { createdAt, state, lastRestoredAt? } }`；使用数据（count/lastUsedAt）仍在同文件 `usage` 节，不重复存。

对每个纳管技能（staleCutoff = now − staleDays，archiveCutoff = now − archiveDays）：

```
anchor    = max(usage.lastUsedAt, lastRestoredAt, createdAt)  // 恢复也算一次"活动"
neverUsed = !(usage[name]?.count > 0)
1. neverUsed && anchor > staleCutoff → 不动（"没用过"是证据缺失，不是过时证据；若状态为 stale 则回 active）
2. anchor ≤ archiveCutoff && state ≠ archived → archived
3. anchor ≤ staleCutoff && state = active → stale
4. anchor > staleCutoff && state = stale → active（复活）
5. archived 无自动出口——恢复只能走面板（归档件对模型不可见，不会被调用，没有自愈路径）
```

状态动作：

- **stale**：仅状态标记（面板黄标），文件不动、仍模型可见——先观察一个周期再动手；
- **archived**：翻 SKILL.md frontmatter `disable-model-invocation: true`（复用 skills-management 已验证的 setModelInvocable 语义：false=移除键、其余键原样保留、临时文件+rename 原子写）。宿主 Chokidar 盯着技能根目录，**外部进程的改写也会触发 skills/change 失效**（docs/subsystems/skills.md:81）——无需调用任何 invalidate，与 v0.1 写入新技能立即可见是同一条通路；
- **恢复**：state → active + 移除治理键 + 记 `lastRestoredAt`（把 anchor 提到恢复时刻，防止下一轮巡检立即再归档）；
- 技能文件已不存在（用户手删）→ 移出纳管集。

### 10.4 崩溃安全（对齐原版）

巡检**先**落盘 `lastRunAt`（崩在半路也不会重启后反复重跑，curator.py:1594 同款纪律）→ 逐技能应用（单技能失败不中断整轮）→ 落盘终态 + 一行摘要。usage.json 全程原子写。

### 10.5 配置与 API

```yaml
curatorEnabled: true      # 总开关
curatorStaleDays: 30
curatorArchiveDays: 90
curatorIntervalHours: 24  # 自动巡检的最小间隔；手动按钮不受限
```

- status 快照新增 `curator` 节：`{ enabled, staleDays, archiveDays, lastRunAt, runCount, lastSummary, skills: [{ skill, state, createdAt, useCount, lastUsedAt, modelInvocable }] }`；
- `POST /hermes-loop/api/curator/run` → 立即巡检，返回本次转移报告；
- `POST /hermes-loop/api/curator/restore { name }` → 归档恢复。

### 10.6 面板

使用统计卡之后新增"技能库维护（Curator）"卡：摘要行（上次巡检时间/各状态计数）、"立即巡检"按钮、纳管技能表（状态徽标、调用数、最后使用；archived 行带"恢复"按钮）。

### 10.7 明确不做

- **LLM 伞形合并**（MERGE INTO UMBRELLA / DEMOTE TO references）：原版默认关闭；等纯代码退休跑稳、纳管集出现真实碎片后再评估；
- **tar.gz 全量快照**：原版做快照是因为它有 LLM pass 可以大面积重写文件；我们的归档动作完全可逆（翻键 + 面板恢复），无破坏性，不需要回滚介质；
- **pinned/豁免清单**：纳管集本身就只有自写技能，范围已最小化。
