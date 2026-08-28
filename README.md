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

## 设计要点（详见 design 文档）

- 触发采用**主 agent 自报端点**方案：收尾纪律 prompt 指引主 agent 把对话 digest POST 到 `/hermes-loop/api/review`，插件起 headless review agent（`agentPreset: 'standard'`）产出结构化结论，由插件代码执行写入（read-before-write 与审批都是代码级守卫）；
- review agent 只输出结论不落盘——比 Hermes 的工具运行时白名单更硬；
- 三阶段实现：v0.1 最小闭环 → v0.2 审批与客户端 UI → v0.3 Curator 防碎片化。
