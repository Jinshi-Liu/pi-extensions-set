# Changelog

## [0.4.0]

- 将 Plan Mode 更新为 Discuss Plan，新增 `/discuss` 和 `/implement`，支持只读讨论后直接实施，或先保存计划再实施。
- `/plan` 进入持续计划模式，计划保存在 `.pi/plans/<session-id>.md`，支持显式克隆、清空和会话隔离。
- 移除旧 `make`、`execute`、`steer`、`status` 子命令；这些词现在作为普通提示词处理。旧 `.pi/plan.md` 仅可显式克隆，不自动采用。
- 将扩展路径从 `extensions/plan-mode/` 改为 `extensions/discuss-plan/`；自定义路径或资源过滤规则需要同步更新。
- 同步停止、排队消息、并发、恢复及计划快照保护的回归测试，测试依赖更新为 Pi 1.5.0。
- 保留 Memory、Codex Usage Status、Questionnaire 和 Subagent 的现有实现，不改动个人配置或记忆资料。

## [0.3.0]

- 增加默认关闭的 Memory 扩展、维护规则、设计说明和回归测试。

## [0.2.0]

- 仓库改名为 `pi-extensions-set`，统一整理 Codex Usage Status、Plan Mode、Questionnaire 和 Subagent。
