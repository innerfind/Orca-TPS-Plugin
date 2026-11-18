# Changelog

All notable changes to this project will be documented in this file.

## [1.6.0] - 2026-11-18

### Added
- **战况天梯 (Battle Leaderboard)**: a new sidebar panel ranks users by token totals for the current calendar **day**, **month** and **year**, showing the Top 100 plus your own exact rank, percentile, and the gap to the player above and to the Top 100 — including when you are outside the Top 100. Both **含缓存总量** (real total) and **净输入+输出** (net) metrics are available. Existing 对话 TPS panel and layout are unchanged.
- **Opt-in, sanitized sync**: synchronization is off by default. After joining, only per-day aggregated counters (`realTokens`, `netTokens`, `requests`) keyed by an opaque source scope leave the machine. Prompts, replies, project names, paths and session IDs are never uploaded.
- **Anonymous join with recovery code** (`ORCA-XXXXXXXXXXXX`) and **GitHub OAuth Device Flow** login; credentials live in Orca's encrypted `secrets:own` store, never in plain storage.
- **Multi-device and remote dedup**: source scopes are `local:<hash>` per desktop and `remote:<hash>` per SSH endpoint, and the server upserts on `(user, scope, day)`, so several desktops scanning the same remote host count it once while their local usage still adds up.
- **Bundled leaderboard server** (`server/leaderboard-server.mjs`): zero external dependencies (`node:http` + `node:sqlite`), with `--seed-demo` for local testing. The ranked board needs this server (or your own deployment); local day/month/year totals work without it.
- New `secrets:own` and `settings:own` capabilities, plus three plugin settings (enable sync, server URL, anonymous mode).

### Fixed
- **Orca storage 1024-key limit**: the usage index wrote one `usage:unit:<sha256>` key per session file, which began failing with `storage exceeds the 1024-key limit` once a machine had more than ~1000 historical sessions, silently dropping monthly/yearly totals. Units are now compacted into 64 hashed buckets (`usage:b:00`…`usage:b:63`); legacy keys are deleted before the consolidated buckets are written, so migration succeeds even at the limit.

## [Unreleased]

### Fixed
- **Orca 1.4.255+ Active Conversation Tracking**: Adapted to Orca's split state storage (`profile_state_document_parts` and `profile_state_document_parts_meta`), resolving an issue where the sidebar and status bar stayed frozen on an older session after switching channels/tabs. Falls back seamlessly to monolithic `profile_state_documents` on earlier Orca versions.

### Changed
- **Sub-Second Active Tab Polling (250ms)**: Lowered focus poll interval from 1000ms to 250ms with a lightweight revision stamp check (`workspaceStamp`), avoiding full-tree re-parsing when the workspace state is unchanged, reducing channel switch latency to 0.7~1.5s.

### Added
- **Antigravity CLI support** (`antigravity` agent): token counts and cache hit rate come from the live `brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (rotated copies are ignored). `input_tokens` is treated as excluding cache reads.
- Antigravity model, TTFT, and request latency come from its native store `conversations/<conversation-id>.db`, read-only and limited to step and generation metadata. Model priority: generation display name, then the latest `Model Selection` change, then the family name. Without the native store only tokens and cache are shown.
- **Usage totals panel and yearly heatmap**: 当日战况, 近一周战况 and 近一月战况 at the top of the panel, showing total tokens (new input, output, cache writes and cache reads, matching CC Switch's real total), cache hit rate and request counts, with a per-agent and per-model breakdown. A GitHub-style heatmap of the last year shows daily totals on hover. Totals come from an incremental background index of local session files (Codex, Claude Code including subagents, Pi, OpenCode sessions, and Antigravity conversations). Each file is read once and re-read only when it changes (large, still-growing files at most every 10 minutes); Codex rollouts stream through the incremental parser; identical Codex rollouts copied into Orca's managed home are counted once.
- **Model average speed ranking** (模型均速): inside the 用量统计 group, models are ranked by their mean per-request output speed (tokens/s) over the selected 当日 / 近一周 / 近一月 window, fastest first. Agents are merged per model; a model needs at least 5 requests in the window to be ranked, and models whose samples are mostly log estimates are marked `≈`. Speeds come from the same local session logs as the totals, so CC Switch proxy speeds are not included. Index units written by earlier versions are re-read once to fill in the speed counters.

## [1.3.0] - 2026-11-07

### Changed
- **Per-Request Calculation Engine (CC Switch Parity)**: Replaced whole-turn wall-clock timing with per-API-request timing across Claude Code, Codex, OpenCode (v1 & v2), and Pi so local tool execution, shell commands, and permission approval pauses are excluded from request duration.
- **Claude Code Importer**: Merged multi-block streaming records by `message.id`, traversed `parentUuid` across `attachment` nodes to resolve accurate request start timestamps, inferred time-to-first-token (`firstTokenMs`) from `thinkingDurationMs`, and included `isSidechain` plus `<SESSION_ID>/subagents/*.jsonl` and `<SESSION_ID>/subagents/workflows/*/*.jsonl` subagent logs.
- **Codex Importer**: Implemented `RequestTimer` state machine with `token_usage_record` / model-output end boundaries, `item_completed` (`Reasoning` / `AgentMessage`) `started_at_ms` TTFT extraction, `limit_id` snapshot signature deduplication, and `normalizeCodexModel` cleanup.
- **OpenCode v1 & v2 Importer**: Counted `tokens.output + tokens.reasoning` together, prioritized `time.streamed - time.created` over `time.completed` to exclude tool execution duration, and added v2 `compaction` row support.
- **Pi Importer**: Extracted explicit `duration` or `entry.timestamp - message.timestamp` per assistant request and unpacked official `subagent` `toolResult` usage without skewing latency.
- **Strict Noise Thresholds & Formatting**: Aligned speed gates with CC Switch (`>= 200` output tokens and `>= 1000ms` duration for session-log estimated speed `≈`; `>= 100` output tokens and `>= 100ms` post-TTFT generation window for exact proxy speed), integer rounding for `TPS >= 1`, and `100%` display at `>= 99.95%` cache hit rate.

### Added
- **Read-Only CC Switch Local Proxy Integration**: Automatically upgrades matching session records (`request_id` or `±600s` semantic match) to exact post-TTFT generation speed when `~/.cc-switch/cc-switch.db` contains `2xx` `proxy` logs.
- **Panel UI Enhancements**: Added TTFT indicator (`· 首字 ≈1.8s` / `· 首字 1.2s`), `子代理` and `代理` badges, `≈` estimated duration markers, and detailed threshold reason tooltips.
- **Marketplace Metadata & CI**: Added plugin icon, 16:10 cover banner, dark/light workspace screenshots, `orca-catalog.json`, bilingual documentation, and cross-platform GitHub Actions CI.

## [1.2.0] - 2026-11-06

### Added
- Custom HTML sidebar panel (`src/panel.html`) with automatic light/dark Orca theme adaptation and compact responsive cards.
- Automatic active terminal pane tracking via read-only `profile-state.db` (`workspaceSession`) with terminal-reuse quarantine protection.
- Bottom status bar integration (`statusBar.update`) and cross-platform Linux / Windows installer scripts.
