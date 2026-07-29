# Crish 架构（产品真相）

> 本文与根目录 `README.md` 为当前产品架构真相。其它标有废弃条的规划文仅作历史参考。

## 总览

**Crish** 是桌面 AI Agent 工作台。用户面是 React 桌面 UI；进程壳是 Tauri 2；业务执行落在 Node 侧 `agent-daemon`，再下沉到 `agent-orchestrator` 与 `agent-runtime`。

```text
crish-desktop (React UI)
    ↕ WS / Tauri invoke
agent-workbench/src-tauri (壳) + agent-daemon (Node)
    → agent-orchestrator / agent-runtime
```

| 组件 | 路径 | 角色 |
| --- | --- | --- |
| 产品 UI | `apps/crish-desktop` | React 19 + zustand；聊天、侧栏、设置、布局 |
| 桌面壳 | `apps/agent-workbench/src-tauri` | 窗口、sidecar 启停、文件系统 / 宿主 invoke；`frontendDist` → `../../crish-desktop/dist` |
| CLI | `apps/agent-workbench/src/cli` | 诊断与无 UI 跑批入口 |
| shared | `apps/agent-workbench/src/shared` | CLI / 工作台契约、任务控制器、配置解析等；**按 CLI 依赖图保留** |
| daemon | `packages/agent-daemon` | WebSocket 协议、会话元数据、运行处理、审批、工作流、provider 网关 |
| orchestrator | `packages/agent-orchestrator` | 会话树、事件存储、目标策略、状态机 |
| runtime | `packages/agent-runtime` | 模型流、工具、权限、上下文压缩、检查点、MCP 等内核 |

**不是产品路径：** `apps/web-ui`（已移除）、workbench Preact 旧 UI 描述、无框架前端叙述。Tauri **不**加载 workbench Preact。

## 传输与壳

- **WebSocket**：`crish-desktop` 通过 daemon 客户端与 `agent-daemon` 通信（会话、运行流、能力、配置同步等）。
- **Tauri invoke**：宿主能力（打开路径、部分 FS、进程 / sidecar 监督等）走 `src-tauri` 命令层。
- 开发：`npm run dev:workbench` 起壳并指向 `crish-desktop` 的 devUrl；生产构建产物为 `crish-desktop/dist`。

## 会话 UI 真相

- **消息正文与本地会话列表**：以 `crish-desktop` 本地状态 / 持久化为用户可见真相（见 `sessionDaemonSync`、`sessionPersistence` 等）。
- **引擎侧会话**：daemon 提供列表、元数据、运行事件；UI 做**尽力合并**（补标题 / id、登记仅远端存在的会话壳），**不以引擎空壳覆盖本地消息正文**。
- 运行中的流式内容、审批、工具卡片等来自 daemon 事件投影，与本地会话消息合成展示。
- **流式热路径**：助手正文 / thinking 与工具 **intermediate** 进 `streamingStore`（无 immer）；工具 **terminal** 与终态消息写 session。详见 `docs/plans/progress/wave4-6-perf-notes.md`。

## 控制面（Run Control）

运行意图分 L0–L3（`continue` / `soft_inject` / `cooperative_stop` / `force_cancel`），经 runtime `ControlBus` 与 **force / steer / followUp** 三环队列在安全点消费；UI Stop 默认 L2，Force 为 L3。协议与队列语义见 `docs/architecture/run-control.md`；中控进度见 `docs/plans/progress/system-control-ledger.md`。PTY 侧 Windows **Job Object** + exit **`kill_all`** 收口子进程，与 shell residual 计划对齐。

## providerProfiles

- 正式多服务商配置在 `apps/crish-desktop/src/api/providerProfiles.ts`：多组 profile（baseUrl / 密钥 / 模型列表）、活动 profile 与活动模型。
- 引擎同一时刻只生效一组配置；UI 通过 `update-config`（及启动时 `syncActiveProfileToEngine`）把活动 profile 推到 daemon / runtime。
- `clientApi` 内旧 localStorage mock 已标 deprecated；设置页与 ModelPicker 走 `providerProfiles`。

## CLI 与 shared

```text
cli (main / workbench-runner / goal-runner / runtime-factory)
    → shared (workbench-contract, task-controller, workbench-config, …)
    → packages/* （orchestrator / runtime 等）
```

- `dev:cli` / `check:workbench`（`cli:check`）覆盖该路径。
- **禁止**再按「整目录删除 `shared`」执行旧 P0 清理；删除范围必须以 CLI 真实 import 图为准。
- workbench 内 Preact 组件 / core UI 是否已删，以仓库代码为准，不以旧计划文档为准。

## 包边界（简）

- **agent-daemon**：产品后端进程；handlers 覆盖 session / run / approval / config / MCP / workflow 等。
- **agent-orchestrator**：运行编排与持久事件，不绑 UI 框架。
- **agent-runtime**：单会话执行内核（provider 流、工具、权限、压缩）。
- **shared-types / shared-utils / decision-engine**：跨包类型、工具函数与权限决策辅助。

## 开发与校验入口

见根 `package.json`：`dev:desktop`、`dev:workbench`、`dev:cli`、`build:product`、`check:core`、`check:desktop`。

专项设计与传输契约：`docs/architecture/`；阶段计划：`docs/plans/`。

**一页系统地图（人类导航）：** [`docs/architecture/system-map-clear.md`](docs/architecture/system-map-clear.md) — 进程拓扑、四控制面（CP-UI/SESS/RUN/HOST）、新建/发送/停机/工具 hook/外部导入主路径、禁止双路径清单、样式 token 落点与新功能放哪。去重杀单见 `docs/plans/progress/architecture-dedup-inventory.md`。
