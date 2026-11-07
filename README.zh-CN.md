# Orca 软件 Tokens 统计插件

**[English Documentation (README.md)](./README.md)** | **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Orca Engine](https://img.shields.io/badge/Orca-%3E%3D1.4.251-blue.svg)](https://github.com/stablyai/orca)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933.svg)](https://nodejs.org/)
[![CI](https://github.com/jecyxyf/Orca-TPS-Plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/jecyxyf/Orca-TPS-Plugin/actions/workflows/ci.yml)

![Orca 软件 Tokens 统计插件封面](./assets/cover.png)

适用于 **Orca IDE 1.4.251+** 的实时 Tokens 用量、单次请求输出速度（TPS）、首字延迟（TTFT）与缓存命中率统计插件。采用与 [CC Switch](https://github.com/farion1231/cc-switch) 完全一致的**单次 API 请求级**计算引擎，自动剔除本地工具执行与权限等待耗时，零外部依赖，原生支持 **Linux** 与 **Windows**。

---

## 核心特性

- **底部状态栏实时跟随**：自动识别当前焦点工作区、页签与终端分屏，实时展示最新一次 API 请求的输出速度与缓存命中率（如 `🚀 ≈68 tokens/s · 🍪 命中 99.2%` 或代理精确模式 `🚀 86 tokens/s`），点击即可立即刷新。
- **侧栏请求级明细卡片**：在右侧活动栏打开「对话 TPS」，查看当前对话最近 100 次 API 请求的**模型名称、完成时间、首字延迟（TTFT）、输出 Token、请求耗时、输出速度与缓存命中率**，并自动标记 `子代理` 与 `代理` 来源。
- **严格剔除工具运行耗时**：不再用整轮挂钟时间充当分母，避免本地编译、测试脚本执行或权限确认弹窗拉低模型真实生成速度。
- **完整支持四大 CLI 与子代理**：原生解析本机终端中的 **Claude Code**（含 `<SESSION_ID>/subagents` 与 `workflows` 子代理）、**Codex CLI**、**OpenCode（v1 / v2）** 与 **Pi Agent**，并支持只读融合 `~/.cc-switch/cc-switch.db` 本地路由代理的精确首字记录。
- **隐私与只读安全设计**：零网络请求、不上传任何数据、不写入或修改任何会话文件与外部数据库；对话提示词（Prompt）与回复正文绝不离开解析器进入面板或日志。

---

## 界面预览

| 深色主题（Dark） | 浅色主题（Light） |
| :---: | :---: |
| ![Dark Screenshot](./assets/screenshot-dark.png) | ![Light Screenshot](./assets/screenshot-light.png) |

---

## 计算方式与规则（对齐 CC Switch）

### 1. 各提供方请求耗时与首字提取

| 提供方 | 单次请求起点 | 单次请求终点（剔除工具耗时） | 首字时间（TTFT）与 Token 规则 |
| :--- | :--- | :--- | :--- |
| **Claude Code** | 按 `message.id` 聚合多内容块，沿首块 `parentUuid` 跳过 `attachment` 向上回溯（最多 32 跳）至触发消息时间戳 | 同一 `message.id` 具有 `stop_reason` 时的最大块时间戳 | 首块为 `thinking` 且含 `thinkingDurationMs` 时推算估算首字；自动合并 `isSidechain`、`subagents/*.jsonl` 与 `subagents/workflows/*/*.jsonl` |
| **Codex CLI** | `RequestTimer` 状态机锁定首条模型输出前的最近边界（`turn_context`、用户消息、工具 `*_output`、前序 `token_count`） | 优先取匹配的 `token_usage_record` 时间戳或工具输出前的模型输出终点，否则取 `token_count` | 从 `item_completed`（`Reasoning` / `AgentMessage`）的 `started_at_ms` 提取估算首字；支持 `limit_id` 快照去重与模型名归一化 |
| **OpenCode v1 / v2** | 消息记录 `time.created`（缺省回退 `time_created`） | **优先取 `time.streamed`**（流式生成结束时刻，不含后续工具执行），缺省回退 `time.completed` | 输出量计为 `tokens.output + tokens.reasoning`；同时支持 v2 `compaction` 消息 |
| **Pi Agent** | 优先读取显式 `duration`，否则取 `message.timestamp` | `entry.timestamp` | 支持展开官方 `subagent` 工具调用结果的用量明细（不继承父工具完成耗时） |

### 2. 精确速度 vs 日志估算速度门槛

| 模式 | 数据来源 | 防噪门槛 | 计算公式 | 显示格式 |
| :--- | :--- | :--- | :--- | :--- |
| **本地代理精确速度** | `~/.cc-switch/cc-switch.db` 中匹配的 `2xx` `proxy` 记录（精确 ID 或 `±600s` 同模型同 Token 语义匹配） | `output_tokens >= 100` 且纯生成时间 `latency_ms - first_token_ms >= 100ms` | $\dfrac{\text{output\_tokens}}{(\text{latency\_ms} - \text{first\_token\_ms}) \div 1000}$ | 无前缀（如 `86`），卡片带 `代理` 标签 |
| **会话日志估算速度** | 各 CLI 本机 JSONL / SQLite 会话记录 | `output_tokens >= 200` 且合理耗时 `1000ms <= latency_ms <= 1h` | $\dfrac{\text{output\_tokens}}{\text{latency\_ms} \div 1000}$ | 带 `≈` 前缀（如 `≈68`）；未达门槛显示 `—`（悬停提示原因） |

- **数值舍入**：`TPS >= 1` 四舍五入为整数，`0 < TPS < 1` 保留 1 位小数。
- **缓存命中率**：统一归一化净新输入后按 $\text{cache\_read} \div (\text{fresh\_input} + \text{cache\_creation} + \text{cache\_read})$ 计算；`>= 99.95%` 显示 `100%`，其余保留 1 位小数。

---

## 安装指南

### 方式一：通过 Orca 插件目录 / Git 仓库安装

可在支持 Git / Catalog 源的 Orca（`>= 1.4.251`）中直接引用仓库地址安装：

```text
https://github.com/jecyxyf/Orca-TPS-Plugin.git
```

### 方式二：Linux 本地克隆加载

```sh
git clone https://github.com/jecyxyf/Orca-TPS-Plugin.git ~/Applications/orca-tps-plugin
cd ~/Applications/orca-tps-plugin
sh install-linux.sh
```

若 `orca` 不在默认 `PATH` 中，可显式指定路径：

```sh
ORCA_CLI="$HOME/.config/orca/linux-orca-cli-shim/orca" sh install-linux.sh
```

### 方式三：Windows 本地克隆加载（PowerShell）

```powershell
git clone https://github.com/jecyxyf/Orca-TPS-Plugin.git "$env:USERPROFILE\Applications\orca-tps-plugin"
Set-Location "$env:USERPROFILE\Applications\orca-tps-plugin"
./install-windows.ps1
```

> **提示**：本地开发目录加载后请保留克隆目录；关闭终端不会卸载插件。如需移除本地开发挂载，可执行 `orca plugin dev unload <目录路径>`。

---

## 默认数据扫描位置

| 数据源 | 默认位置 |
| :--- | :--- |
| **Codex** | `~/.codex/sessions`、Orca 托管 `codex-runtime-home/home/sessions` 及多账户目录 |
| **Claude** | `~/.claude/projects`（含 `<SESSION_ID>/subagents`）、Orca 托管 Claude 账户目录 |
| **OpenCode / OpenCode 2** | `~/.local/share/opencode/opencode.db`（支持 `OPENCODE_DB`、`XDG_DATA_HOME`） |
| **Pi** | `~/.pi/agent/sessions`（支持 `PI_CODING_AGENT_DIR`） |
| **CC Switch 代理库（可选）** | `~/.cc-switch/cc-switch.db`（支持 `CC_SWITCH_DB_PATH`） |

---

## 开发与测试

```sh
npm test
orca plugin validate .
orca plugin inspect .
orca plugin test .
```

## 开源许可

本项目基于 [MIT License](./LICENSE) 开源。详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
