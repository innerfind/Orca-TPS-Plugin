# Orca 远程项目 TPS

## 统计范围

Orca 打开一个远程项目频道时，插件汇总该频道内能识别的终端会话。侧栏显示最近 100 条请求，底部状态栏显示最新一条。请求的 TPS 和缓存命中率沿用现有算法。

此次改动覆盖 Orca 管理的 SSH 远程项目和已配对的远程 Orca 项目。本地项目里手动建立的 SSH 会话、全局用量和热力图独立于这次频道统计。

## Orca 接口

| 接口 | 用途 |
| --- | --- |
| `workspace.readContext`、`workspace.list` | 确认当前频道、工作区和执行主机。用 Orca 给出的工作区标识启动采集，避免同路径的两台机器被混在一起。 |
| `terminal.create` | 通过 Orca 已有的连接，在目标工作区启动插件专用的后台采集终端。 |
| `terminal.sendText`、`terminal.read` | 与采集程序交换有大小限制的请求和统计结果。所有输入都发送到插件自己创建的终端。 |
| `terminal.close` | 停止并关闭插件创建的采集终端。 |

Orca 提供远程会话列表和工作区文件读取接口。会话列表返回会话级数据，`agent.read` 返回对话内容。计算单次 TPS 需要日志中的请求计时和输出 Token，而供应商日志通常位于远端用户目录。因此在远端运行现有解析器，回传统计结果。[会话列表](https://github.com/stablyai/orca/blob/main/src/main/ai-vault/runtime-hosts/runtime-session-scanner.ts) · [会话读取结果](https://github.com/stablyai/orca/blob/main/src/shared/agent-conversations/agent-conversation-contracts.ts) · [插件宿主接口](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-host-api.md)

## 数据流

1. **识别频道。** `src/active-conversation.mjs` 保留当前频道的 Orca 标识、执行主机和可核对的终端会话。`src/worker.mjs` 通过官方工作区接口验证当前频道与目标主机一致。频道切换时按主机和工作区区分数据。
2. **启动采集。** 新增 `src/remote-channel.mjs` 管理 Orca 后台终端。一条活动的远程频道复用一个采集进程。启动前检查 Orca 接口。进程启动后回报版本和就绪状态，确认连接可用且远端有支持 `node:sqlite` 的 Node.js 22.13 或更新版本。
3. **读取日志。** 新增 `src/remote-collector.mjs` 作为远端入口，复用 `src/data.mjs`、`src/data-paths.mjs` 和 `src/parsers.mjs`。在远端按项目工作目录查找会话，并加入 Orca 明确归到该频道的终端会话。工作目录用远端的路径规则匹配。日志和数据库只读，SQLite 在远端读取，保留现有扫描上限。
4. **回传结果。** 后台终端回传带请求标识的分块响应，只包含统计结果、会话来源和简短状态。聊天正文、提示词、日志路径和连接信息留在采集端。回传结果按现有规则去重、按时间排序，并通过 `src/controller.mjs` 更新面板和状态栏。
5. **停止与恢复。** 切换频道、停用插件或连接断开时停止旧采集。连接中断时当前频道保留最近一次成功的远端结果，并显示更新时间。重新连接或手动刷新后更新。旧频道的迟到响应丢弃。

## 部署和权限

- `orca-plugin.json` 声明所需的 `workspace:read`、`terminal:send` 和 `terminal:read`。若宿主缺少远程采集所需接口，打开远程项目时显示原因。本地统计仍可使用。
- 采集代码随插件发布。用短命令启动远端 Node 程序，再通过插件自己的终端分块发送采集代码。代码只在远端用户临时目录中解包，关闭时清理。项目目录、会话日志和用户 SSH 配置保持只读。
- 采集载荷是插件内置代码。来自频道或会话的路径作为结构化数据传输。响应有大小限制、请求标识和超时，采集输出不用作命令。插件只关闭自己创建的终端。

## 文件范围和验收

| 范围 | 验证方式 |
| --- | --- |
| `src/active-conversation.mjs`、`src/worker.mjs` | 测试两个主机有同名或同路径项目时只选中当前远程频道。涵盖远程主机不可用时的提示。 |
| 新增 `src/remote-channel.mjs`、`src/remote-collector.mjs`，复用现有文件解析 | 用模拟 Orca 宿主验证创建、读取、超时、关闭和重连。用合成日志验证一个远程频道的多个 CLI 会话和镜像日志去重。 |
| `src/controller.mjs`、`src/panel.html` | 验证切换频道时迟到的响应无法覆盖新频道，侧栏显示最新记录和远端连接状态。 |
| `orca-plugin.json`、`README.md`、`README.zh-CN.md` | 验证 Orca 能加载清单，并说明授权和远端 Node.js 要求。 |
| 端到端验收 | 在真实 Orca 远程项目里打开至少两个有统计记录的终端，然后切换到另一个项目。验证两条会话同屏、状态栏最新值正确、频道之间数据隔离。分别覆盖 Orca 管理的 SSH 项目和配对服务器项目。 |
