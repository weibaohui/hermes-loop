# dsh-plugin-hermes-loop

把 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的 Learning Loop 移植到 dsh：对话收尾后自动复盘，把有价值的经验蒸馏成可复用的 skill。

> 📚 现阶段是**研究与设计**阶段，尚未实现。先读文档：
>
> - [docs/research-hermes.md](docs/research-hermes.md) — Hermes 机制调研（源码级，含关键 prompt 原文）
> - [docs/design-dsh.md](docs/design-dsh.md) — dsh 插件设计方案（触发选型、架构、分阶段计划）

## 要解决的问题

Hermes 能做到"每次对话完成后自动总结、形成 skill"，其机制拆解后是四层：

1. **触发**：每轮回复交付后按计数器触发后台 review（不是会话结束钩子）；
2. **评估**：fork 的 review agent 按固定 prompt 自主判断"值不值得存"（主动倾向 + 正向信号 + 负面清单）；
3. **写入**：四级优先序（patch 优先于 create）+ class-level 命名纪律 + read-before-write 代码守卫，防 skill 库碎片化；
4. **信任**：可选的 write_approval 审批通道 + 变更审计账本。

dsh 侧的现状：hermes-prompt 插件只注入了"收尾沉淀纪律"，靠模型自觉执行，无守卫、无审批、无防碎片化。hermes-loop 把这条纪律落成**具体可调用的端点 + 有守卫的写入管道**。

## 设计要点（v2，经平台源码实证，详见 design 文档）

- **触发与 Hermes 同构**：宿主插件 `ctx.on('session/event')` 订阅所有会话的 `turn/end`（completed），按阈值（默认每 10 turn）+ 冷却触发——不需要 prompt 自报，不需要平台改动；
- **review agent 零工具**：`agents.create` + `tools.restrict({allow: []})`，输入 = 既有 skill 目录快照 + 会话转写尾部，输出 = 结构化 JSON 结论（nothing/create/patch），写入由插件代码执行（read-before-write 与审批都是代码级守卫）；
- **写入即可见**：直接写 `~/.dsh/skills/`（全局）或 `<projectRoot>/.dsh/skills/`（workspace 级），chokidar watcher 自动失效 registry 缓存，下一会话的 available_skills 目录即出现；
- 三阶段实现：v0.1 最小闭环 → v0.2 审批与客户端 UI → v0.3 Curator 防碎片化。
