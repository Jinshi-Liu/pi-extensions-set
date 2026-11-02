# Pi Extensions Set

个人维护的 [Pi](https://github.com/earendil-works/pi) 扩展集，基于 Pi 1.4.0 使用和验证。原仓库名为 `pi-minimal-extensions`，现统一整理为五个扩展。

## 扩展

| 扩展 | 功能 | 入口 |
| --- | --- | --- |
| [Codex Usage Status](extensions/codex-usage-status.ts) | 在状态栏显示 Codex 5 小时、每周剩余额度及重置时间 | `/codex-usage` |
| [Memory](extensions/memory/README.md) | 显式开关全局记忆索引上下文，正文按需读取 | `/memory` |
| [Plan Mode](extensions/plan-mode/README.md) | 讨论 → 编写计划 → 讨论 → 执行，支持任务进度和中途调整 | `/plan`、`/todos` |
| [Questionnaire](extensions/questionnaire.ts) | 单问题选项、多问题分页及自定义回答 | 模型调用 `questionnaire` 工具 |
| [Subagent](extensions/subagent/README.md) | 后台持久子代理、完成通知、四档模型配置 | `/subagent`、`/subagent-model` |

## 安装

```sh
pi install git:github.com/Jinshi-Liu/pi-extensions-set
```

安装后输入 `/reload`。Pi 提供运行依赖，无需分别安装五个扩展。

如果已安装旧仓库，先移除旧来源，再安装新来源：

```sh
pi remove git:github.com/Jinshi-Liu/pi-minimal-extensions
pi install git:github.com/Jinshi-Liu/pi-extensions-set
```

如果曾单独安装 `npm:pi-minimal-plan` / `npm:pi-minimal-subagent`，也应先移除对应旧包。若 `~/.pi/agent/extensions/` 中已有这些扩展的手动副本，请先移走或禁用，避免重复注册命令和工具。此仓库不再维护两个独立 npm 包的发布配置。

更新：

```sh
pi update git:github.com/Jinshi-Liu/pi-extensions-set
```

更新后输入 `/reload`。可用 `pi config` 按需启用或禁用扩展。

## 快速使用

### Codex 用量

先在 Pi 中登录 `openai-codex` 并选择该提供商的模型。扩展在会话启动、切换模型和任务结束时刷新，也可用 `/codex-usage` 手动刷新。切换到其他提供商时隐藏状态。

显示的是**剩余额度**，不是本次会话的 token 统计。通过现有 OAuth 登录信息访问 ChatGPT 用量接口；该接口变化或不可用时可能无法显示数据。仓库不包含账号、凭据或个人配置。

### Memory

`/memory` 切换记忆上下文，默认关闭；新建、恢复会话和重载后均重置为关闭。开启时注入 `~/.pi/agent/memory/index.md` 的最新正文，具体记忆文件按需读取；关闭时不注入记忆提示。

单一全局目录、Markdown 文件平铺存放，不创建子目录。维护规则随扩展分发，索引和实际资料不上传、不随包更新覆盖。没有新增工具、自动提取或数据库，也不提供文件访问隔离。首次使用需自行或明确让 agent 创建记忆目录及索引。详见 [Memory 的设计与使用说明](extensions/memory/README.md)。

### 规划与问答

1. `/plan`：进入讨论，配合 Questionnaire 澄清目标。
2. `/plan make`：授权编写或修订项目的 `.pi/plan.md`，完成后回到讨论。
3. `/plan execute`：明确授权执行保存的计划。
4. `/plan steer`：停止执行并回到讨论，保留计划和进度。
5. `/todos`：切换进度面板；`/todos all` 查看完整任务。

聊天中的“开始执行”或问卷中的确认不会自动切换阶段。规划流程启用期间阻止子代理委派；退出规划模式后恢复正常工具访问。详见 [Plan Mode 文档](extensions/plan-mode/README.md)。

Questionnaire 由模型按需调用，支持选项和自由输入，需要交互式 TUI；不适用于 print / JSON 等非交互模式。

### 后台子代理

用 `/subagent-model` 配置 `low`、`medium`、`high`、`max` 四档模型。未配置的档位跟随主代理模型，配置不会改变主代理模型。

主代理通过 `subagent` 工具分派任务；调用立即返回确认，完成结果随后通知。复用 `session` 可延续子代理上下文。`/subagent` 切换状态面板，隐藏面板不等于取消任务。

模型映射和子会话保存在用户的 `~/.pi/agent/` 下，不随仓库分发。详见 [Subagent 文档](extensions/subagent/README.md)。

## 目录

```text
extensions/
├── codex-usage-status.ts
├── memory/                # 实现、维护规则、设计说明和回归测试
├── plan-mode/             # 实现、使用说明和回归测试
├── questionnaire.ts
└── subagent/              # 实现、使用说明和回归测试
```

## 测试

使用支持 `node:module.stripTypeScriptTypes` 的 Node.js（建议 Node.js 22.13+）和已安装的 Pi 1.4.0：

```sh
npm test
```

测试默认查找用户目录下的 Pi 托管安装。其他安装位置可用 `PI_TEST_INSTALL` 指定包含 `@earendil-works` 和 `jiti` 的 `node_modules` 目录，例如 PowerShell：

```powershell
$env:PI_TEST_INSTALL = 'C:/path/to/pi/node_modules'
npm test
```

测试覆盖 Memory 的开关、索引注入及生命周期，Plan Mode 的工作流、任务面板，以及 Subagent 的模型选择、后台通知、持久会话和取消流程；默认使用模拟子进程，不调用真实模型、不消耗模型额度。Codex 用量接口和 Questionnaire 交互需在登录后的 TUI 中手动验证。

## 许可与来源

MIT License。Plan Mode、Subagent 基于 Pi 官方示例演进，保留原有 `LICENSE` 和 `NOTICE`。Questionnaire 基于 Pi 官方问卷示例；原作者版权声明见根目录 [LICENSE](LICENSE)。
