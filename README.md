# dsh-plugin-hermes-loop

把 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的 Learning Loop 移植到 dsh：对话收尾后自动复盘，把有价值的经验蒸馏成可复用的 skill。

> ✅ **v0.1 已实现**（最小闭环：触发 → review → 写入 → 可见）。设计文档：[docs/design-dsh.md](docs/design-dsh.md)（v2.1）· [docs/research-hermes.md](docs/research-hermes.md)（Hermes 机制源码级调研）。

## 运行机制（v0.1）

```
session/event（进程内全部会话）
  │  turn/end(completed) → 每会话计数器（completed turn 数 / tool call 数）
  │  阈值（默认 10 turn 或 10 tool）+ 冷却（30 分钟）+ 排除（自身 review 会话、
  │  全部 subagent 会话、aborted turn）
  ▼
review runner（全局串行队列；同 session 前台新 turn 丢弃排队/取消在跑；300s 超时）
  │  转写尾部（保尾截断 ~12K 字符）
  │  skill 目录快照 ctx.skills.snapshot({ cwd })
  │  疑似相关 skill：关键词匹配 top-3，注入全文 + baseHash
  ▼
零工具 review agent（agents.create + agentPreset 'standard' + origin 'subagent'
  │  + tools.restrict({allow: []})；可路由便宜模型）
  ▼
fenced JSON 结论 { action: nothing | create | patch, ... }（解析失败 fail-closed 丢弃）
  ▼
skill writer（插件代码执行，agent 不落盘）
  │  patch → CAS 重读比对 baseHash → 临时文件 + 原子 rename
  │  mode=auto → $DSH_HOME/skills/<name>/SKILL.md
  │  mode=approval → $DSH_HOME/hermes-loop/pending/<id>.json（手动处理）
  │  mode=log-only → 仅 ctx.logger.info
  ▼
chokidar watcher 自动失效 registry → 下一个新会话的 available_skills 即可见
```

## 安装

宿主面插件。安装包后由 `cordis.patch.yml` 挂载，或在 profile patch 层直接指向源码路径：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: hermes-loop
      name: '/absolute/path/to/dsh-plugins/hermes-loop/src/index.js'
```

安装后需重启 dsh server（宿主插件不热加载）。

## 配置（ctx.settings 命名空间 `hermes-loop`，zod 校验）

| key | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（每事件实时读取） |
| `mode` | `auto` | `auto` 写入 / `approval` 进 pending（无审批 UI，手动处理）/ `log-only` 只记日志 |
| `provider` / `model` | `""` | review 模型路由，空=跟随部署默认（建议配便宜模型） |
| `turnInterval` | `10` | completed turn 阈值 |
| `toolCallInterval` | `10` | 同窗口 tool/call 计数（第二触发线，turn 尾结算） |
| `cooldownMinutes` | `30` | 同会话两次 review 最小间隔 |
| `maxTranscriptChars` | `12000` | 转写尾部预算 |
| `reviewTimeoutSec` | `300` | review 硬超时 |
| `catalogDescriptionMax` | `500` | 目录 description 截断（对齐 dsh 渲染） |
| `suspectsTopN` | `3` | 注入全文的疑似 skill 数 |

## 守卫

- **fail-closed 解析**：非法 action / 坏 name / 空 body / patch 缺 baseHash → 记日志丢弃；
- **patch CAS**：写入前重读目标文件比对 sha256，漂移即拒绝（rename 只防半写读，ABA 由 CAS 解决）；
- **create 不覆盖**：目标已存在 → 降级 nothing + warn（合并留给 v3 Curator）；
- **v0.1 只 patch 全局库**（`$DSH_HOME/skills`），目标在别处 → 拒绝并记日志；
- review 会话用完即弃：不 flush 会话库，结论解析后 dispose；监听/队列/在跑 agent 全部经 `ctx.effect` 清理。

## 开发

```sh
npm install
npm test        # node --test —— 纯函数 + 假 services 端到端（触发/排除/冷却/写入/CAS）
npm run check
```

## 要解决的问题（背景）

Hermes 能做到"每次对话完成后自动总结、形成 skill"，其机制拆解后是四层：

1. **触发**：每轮回复交付后按计数器触发后台 review（不是会话结束钩子）；
2. **评估**：fork 的 review agent 按固定 prompt 自主判断"值不值得存"（主动倾向 + 正向信号 + 负面清单）；
3. **写入**：四级优先序（patch 优先于 create）+ class-level 命名纪律 + read-before-write 代码守卫，防 skill 库碎片化；
4. **信任**：可选的 write_approval 审批通道 + 变更审计账本。

dsh 侧的现状：hermes-prompt 插件只注入了"收尾沉淀纪律"，靠模型自觉执行，无守卫、无审批、无防碎片化。hermes-loop 把这条纪律落成**具体可调用的端点 + 有守卫的写入管道**。

- **触发与 Hermes 同构**：宿主插件 `ctx.on('session/event')` 订阅所有会话的 `turn/end`（completed），按阈值 + 冷却触发——不需要 prompt 自报，不需要平台改动；
- **review agent 零工具**：`agents.create` + `tools.restrict({allow: []})`，输入 = 既有 skill 目录快照 + 疑似相关 skill 全文 + 会话转写尾部，输出 = 结构化 JSON 结论，写入由插件代码执行（CAS 与审批都是代码级守卫）；
- **写入即可见**：直接写 `$DSH_HOME/skills/`（全局库；经评审决定不做项目级写入），chokidar watcher 自动失效 registry 缓存，下一会话的 available_skills 目录即出现；
- 已完成（v0.2）：客户端面板（对话区 Hermes Loop tab）、模式切换、结论回显到来源会话、in-session patch 纪律 section；审批 UI 与项目级写入经评审取消 → v0.3：Curator 防碎片化、信号加速触发；候选：memory 通道。
