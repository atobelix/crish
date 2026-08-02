# Crish 架构（产品真相）

> 本文与根目录 `README.md` 为当前产品架构真相；`README` 面向公众做简述，本文是架构细节的唯一真相。
> 重写过渡期的阶段方案与审计记录见 `docs/rust-rewrite/`（`00-master-plan.md` 为总纲）。
> 其余根目录历史规划文档已归档至 `docs/archive/legacy/`，仅作历史参考。

## 总览

**Crish** 是本地优先的桌面 AI Agent 工作台：**Tauri 2 壳（Rust）+ React 19 桌面 UI + Rust 引擎**。
引擎与 UI 同进程，通过 Tauri IPC（invoke 命令 + event 事件）通信；不再存在独立的 Node/WS daemon 链路。

```text
┌───────────────────────────────────────────────────────────────┐
│ 引擎契约面（后端，Rust 进程内）—— web/gui/tui 三端共用          │
│   core_* 命令（run/control/approve/session/event/status/config）│
│   workbench-run-event 事件通道（sequence + runId 注入）         │
│   CoreError 统一错误协议 + conex-telemetry 全链路可观测         │
└───────────────┬────────────────────────────┬───────────────────┘
        ┌───────▼────────┐           ┌───────▼────────┐
        │ GUI (React)    │           │ TUI (规划)     │
        │ 渲染适配层       │           │ 渲染适配层      │
        │ workbench_*    │           │ 仅依赖契约面    │
        │ 仅 GUI 桌面能力 │           │                │
        └────────────────┘           └────────────────┘
```

- **引擎契约面** = `core_*` + `config_*` + `session_*` + `workbench-run-event` + `CoreError`，三端共用。
- **GUI 专属** = `workbench_*`（fs / pty / process / power / host 等桌面能力）。
- **Web 形态** = 同一契约面的 HTTP/WS 适配（可后续由网关暴露，本轮只保证契约纯净）。
- **TUI 形态** = 直接消费契约面（命令 + 事件通道），渲染层独立。

来源：`docs/rust-rewrite/23-architecture-hardening-plan.md` §2（目标架构三端图）。

## 组件与目录

| 组件     | 路径                             | 角色                                                                                                                                                 |
| -------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产品 UI  | `apps/crish-desktop`             | React 19 + zustand；聊天、侧栏、设置、布局、xterm 终端；Vite（dev 5174）                                                                             |
| 桌面壳   | `apps/agent-workbench/src-tauri` | Tauri 2 窗口（1320×880，无边框）、IPC 命令注册、CSP、updater 配置；`frontendDist` → `../../crish-desktop/dist`                                       |
| 引擎编排 | `crates/orchestrator`            | 会话 / 运行生命周期、事件存储、审批状态机                                                                                                            |
| 会话循环 | `crates/session-loop`            | 单会话执行状态机与 steering（continue / soft_inject / cooperative_stop / force_cancel）                                                              |
| Provider | `crates/agent-provider`          | OpenAI 兼容 / Anthropic / Gemini / Ollama（reqwest + SSE），重试与错误分类                                                                           |
| 工具     | `crates/agent-tools`             | fs / shell / search 工具执行                                                                                                                         |
| 沙箱门禁 | `crates/conex-sandbox`           | `CommandPolicy` 三层管线（语句切分 → token 化 → 策略匹配），动态内容升级审批                                                                         |
| 基础设施 | `crates/conex-*`                 | db（SQLite 会话/事件）、ipc（协议）、types（错误码/类型）、telemetry（tracing/日志脱敏）、markdown（渲染）、diff、fs、search、compaction、test-utils |
| 共享包   | `packages/`                      | decision-engine、logger、plugin-sdk、shared-types、shared-utils、telemetry、test-utils（TS 侧辅助）                                                  |

## 传输与壳

- **Tauri IPC**：UI 通过 invoke 调 `core_*` / `workbench_*` 命令；引擎经 `workbench-run-event` 事件通道推送运行事件（流式文本、工具 intermediate/terminal、审批请求等）。
- **开发**：`npm run dev:workbench` 起壳并指向 `crish-desktop` 的 devUrl（5174）；生产构建产物为 `crish-desktop/dist`。
- **CSP**：`tauri.conf.json` 已配置（`default-src 'self'`，脚本禁 inline/unsafe-eval；connect-src 仅本机 IPC/localhost）。

## 安全基线

- 全部 Rust crate、Tauri 壳与前端改动必须满足 `docs/rust-rewrite/31-security-baseline.md` 十条基线（B1–B10）：
  命令门禁（B1）、路径校验（B2）、凭据处理与日志脱敏（B3/B4）、IPC 暴露面（B5）、MCP 配置（B6）、
  SQL 参数化（B7）、panic 面（B8）、依赖安全（B9）、webview 注入面（B10）。
- 密钥存储走 Rust 侧 DPAPI（Windows）等系统凭据库；前端仅持有 last4 展示。

## 数据流（用户可见真相）

- 消息正文与本地会话列表以 `crish-desktop` 本地状态 / 持久化为用户可见真相；
- 引擎侧会话元数据、运行事件经事件通道投影到 UI（补标题 / id / 审批 / 工具卡片），
  不覆盖本地消息正文；
- 流式热路径：助手正文 / thinking 与工具 intermediate 进 `streamingStore`；工具 terminal 与终态消息写 session。

## 重写过渡状态（2026-08-02）

- **已完成（Phase A–E）**：TS 后端包（`agent-daemon` / `agent-orchestrator` / `agent-runtime` / `agent-core` /
  `agent-model` 等）已删除，引擎全部 Rust 化并进程内运行；IPC 单路径；流式 markdown 增量渲染接线；
  可观测性（conex-telemetry）与安全加固基线发布。
- **清理中**：`apps/agent-workbench/src` 内旧 CLI / 命令注册表 TS 文件仍引用已删除包，
  属遗留路径（以代码为准，勿按旧计划整目录操作）；npm workspaces 已收敛为现存 9 个包。
- 阶段方案、审计与执行记录：`docs/rust-rewrite/`（`00-master-plan.md` → `23-architecture-hardening-plan.md`
  → `31-security-baseline.md` → `34-cleanup-closure.md`）。

## 开发与校验入口

见根 `package.json` 与 `Cargo.toml`：`dev:desktop`、`dev:workbench`、`check:desktop`、
`cargo build/test/clippy --workspace`、CI 三层（`.github/workflows/`：ci.yml 快层 / ci-mid.yml 中层 /
ci-slow.yml 慢层 / perf-test.yml 性能）。
