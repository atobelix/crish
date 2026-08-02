# System Map / 系统地图（人类一页）

> 产品真相入口：根 [`ARCHITECTURE.md`](../../ARCHITECTURE.md)。去重杀单：[`architecture-dedup-inventory.md`](../plans/progress/architecture-dedup-inventory.md)。进度：[`system-control-ledger.md`](../plans/progress/system-control-ledger.md)。派发板：[`optimization-wave-board.md`](../plans/progress/optimization-wave-board.md)（**OPT-B/C/D complete · OPT-E product landings reflected · E0 still partial**）。

---

## 1. Process topology / 进程拓扑

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Tauri 进程（apps/agent-workbench/src-tauri）—— Rust 引擎同进程内嵌       │
│                                                                       │
│  crates/orchestrator    会话树 / run 状态机 / 事件存储 / 恢复           │
│  crates/session-loop    单会话状态机 + steering / control              │
│  crates/agent-provider  OpenAI 兼容 / Anthropic / Gemini / Ollama      │
│  crates/agent-tools     fs / shell / search 工具 + MCP 桥              │
│  crates/conex-*         db / types / net / stream / sandbox / …        │
│                                                                       │
│        │  Tauri IPC：invoke（core_* / workbench_* 命令）               │
│        │  事件：workbench-run-event（流式文本 / 工具 / 审批 / 终态）     │
└────────┼──────────────────────────────────────────────────────────────┘
         ▼
┌─────────────────────────────────────────┐
│ crish-desktop（React 19 + zustand）      │
│ WebView2（Vite dev 5174 / dist）         │
│ 本地消息正文 SoT                         │
└─────────────────────────────────────────┘
```

| 层 | 路径 | 职责 |
|----|------|------|
| **Desktop UI** | `apps/crish-desktop` | 聊天、侧栏、设置、布局；本地消息正文 SoT |
| **Tauri 壳** | `apps/agent-workbench/src-tauri` | 窗口、IPC 命令注册、事件桥、引擎初始化与恢复；**不**加载旧 Preact |
| **Orchestrator** | `crates/orchestrator` | 会话树、事件存储、目标策略、run 状态机、崩溃恢复 |
| **Session-loop** | `crates/session-loop` | provider 调用流、工具执行与审批门、steering / control |
| **Provider** | `crates/agent-provider` | provider 流、重试与错误分类 |
| **Tools** | `crates/agent-tools` | 工具执行、权限、MCP 桥 |

传输：业务/流/宿主能力 → **Tauri IPC**（invoke + `workbench-run-event` 事件通道）。开发 `dev:workbench`；产物 `crish-desktop/dist`。

---

## 2. Four control planes / 四条控制面

| ID | 名 | 拥有者 | 职责 | 禁止 |
|----|----|--------|------|------|
| **CP-UI** | 表现 | `crish-desktop` | 布局、焦点、空态、加载、composer UI | 自 mint 会话 id；猜 run 状态 |
| **CP-SESS** | 会话身份 | session store + 引擎 session meta | id、draft、侧栏列表、folder 绑定 | 草稿进 `sessions[]`；空壳当「新对话」 |
| **CP-RUN** | 运行 | orchestrator run SM + session-loop SM | start / turn / tool / stop L0–L3 | UI Stop 一律 Abort；L3 表达 AI 自主停 |
| **CP-HOST** | 宿主 | Tauri + `crates/*` | PTY、FS、md 渲染、IPC | UI 双 spawn PTY；与引擎工具双通道混写 |

命令入口：`apps/crish-desktop/src/app/compositionRoot.ts` facades：

| Facade | 用途（命令路径） |
|--------|------------------|
| `session` | enterDraft / openOrFocus / getState；**pin / unpin / archive / unarchive / branch**（OPT-G7；侧栏菜单等命令式写 — **不在** `layout`） |
| `shell` | openNewDraftTab / setShellReady / TabSurface |
| `layout` | sessions 同步、tabMode、**sidebar / planMode chrome**、**`setAppSettings` / `getAppSettings`** |
| `workspace` | legacy columns/cards（≠ shell） |
| `tree` | **thin** layout-tree：`getState` + `setLeafSessionId`（hydrate/bootstrap；UI 仍用 hooks） |
| `runControl` | L1 follow_up / L2 cooperativeStop / L3 forceCancel / dispatch |
| `pty` | killAll（exit / pagehide） |
| `metrics` | controlMetrics snapshot / record |

渲染订阅仍用 zustand 窄 selector，**不要**把 root 当 React DI。  
**OPT-E 命令收口（已落地）：** `layout.setAppSettings`（AppBootstrap 命令路径）；sidebar context menu / handlers → root session/shell；`api/openAgentPanel` + `workspaceChromeHooks` → root session/workspace/shell（组件勿散落 getState 开面板/chrome）。  
**OPT-G7（已落地）：** `session.pinSession` / `unpinSession` / `archiveSession` / `unarchiveSession` / `branchSession` — 侧栏 context menu 等经 `getCompositionRoot().session.*`；**勿**挂到 `layout` facade。Strip 等 residual getState 仍 open（kill #6 partial）。

---

## 3. Canonical paths / 主路径

### 3.1 New chat / 新对话（CP-SESS + CP-UI）— **draft only（OPT-B2）**

```text
UI「新对话」→ getCompositionRoot().shell.openNewDraftTab
           → session.enterDraftMode
           → activeSessionId = __pending_draft__（sessions[] 无新项）
首条发送   → commitDraftIfNeeded → mint 真 sessionId + 绑 draftFolder
```

- ADR：[`session-pending-draft-adr.md`](./session-pending-draft-adr.md)
- **用户入口仅 draft**：侧栏 / strip / 快捷键 → compositionRoot shell/session draft APIs；**禁止**产品空壳 `createSession()` mint
- `createSessionAndOpenChat`：**@deprecated** shim → 仅 `enterDraft`（不 mint）；新代码勿再调
- Slash 首发：`commitDraftIfNeeded` only（无 `createSession` fallback）
- 系统占位例外：`createSession({ id, title, activate:false })`（如 schedule / import）

### 3.2 Send / 发送（CP-RUN + CP-SESS）

```text
commitDraftIfNeeded（若草稿）
→ 乐观 append user msg（clientMessageId）
→ chatApi → streamViaEngine（主，Tauri IPC → core_run_task）
→ 引擎事件（workbench-run-event）→ streamingStore（热路径）→ 终态写 session
```

- busy 再发 → **L1 follow_up / soft**（不 abort 当前 run）
- 无降级第二通道：核心未就绪（waitUntilConnected 超时）→ **拒绝启动**（C3.4：directFetch HTTP SSE
  降级分支已删，见 `chat-bridge/ConnectionLifecycle.ts` 头部声明）
- 历史度量：`recordTransportDegradedDirectFetch`（controlMetrics，OPT-F7 产物）仅保留度量通道，不参与主路径决策

### 3.3 Stop L2 / L3（CP-RUN）— dual-wire **still transitional**（OPT-B7 + OPT-C6）

| 用户 | Level | wire | 效果 |
|------|-------|------|------|
| Stop（默认） | **L2** | `cooperative_stop` | turn 协作收尾；**不** abort provider |
| Force（长按/确认） | **L3** | `force_cancel` | abort provider + tools |

```text
handleStop* → api/streamStop.dispatchStreamCancelStop
           → live StreamCancelFn（createStreamCancel）XOR runId → compositionRoot.runControl
           → runControlClient.dispatchRunControl
           → sendTerminateDualWire（唯一双线配对点）
           → core_run_control（L2/L3；过渡双线成对附 core_cancel_run，安全点 drain 由引擎保证）
```

- 契约：[`run-control.md`](./run-control.md)、`packages/shared-types/src/run-control.ts`
- **共享 stop wire（OPT-C6）：** `api/streamStop`（`dispatchStreamStopCancel` + `markStreamingActive`）— chat + agent 共用；勿在 hook 内再复制 L2/L3 出站
- **唯一双线 helper：** `sendTerminateDualWire`（`api/runControlClient.ts`）
- **过渡双线 flag 仍开：** `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE`（默认 `true`）→ L2/L3 成对附 `cancel-run.mode`；关则仅 `run-control`（须 E0 live Stop 证明后删 dual — **勿**未验收关 flag）
- metrics 按 **一次** L2/L3 计数；L1 follow_up **永不**附 cancel-run
- **禁止** UI 直发 `{ type: 'cancel-run' }` 绕过 `runControlClient`

### 3.4 Tool pre / post（CP-RUN）

```text
Rust 引擎内工具执行（crates/session-loop::tool_exec）
  → 审批门（crates/session-loop / crates/orchestrator 审批状态机）
  → ToolExecutor（crates/agent-tools）
  → 工具 intermediate / terminal 事件经 workbench-run-event 回发前端
```

- 实现：`crates/session-loop/src/tool_exec.rs`、`crates/session-loop/src/approval.rs`、`crates/agent-tools/src/executor.rs`
- 目录：[`docs/guides/hooks.md`](../guides/hooks.md)（历史：旧 TS hooks 层的语义参考）

### 3.5 Import external / 外部导入（CP-SESS + CP-HOST）— **real Tauri FS（OPT-B1）**

```text
Settings / FirstRunWizard 点击
→ 真实 Tauri FS 检测 ~/.claude | ~/.codex（allow-root，非全盘扫；非 agent 本机扫盘）
→ 解析 JSONL（Codex / Claude parsers）→ map → createSession + addMessage
```

- ADR：[`external-session-import-adr.md`](./external-session-import-adr.md)
- 代码：`apps/crish-desktop/src/api/import/**`（`importFsHost` = Tauri FS adapter）；只读、无 live sync、无写回源
- 验收：parsers + detect/map **31 unit tests**；真机 home 用产品 Tauri；CI/agent 无 home 时 mock FS / SKIP

---

## 4. Forbidden dual paths / 禁止双路径

完整杀单与路径锚点：**[`architecture-dedup-inventory.md`](../plans/progress/architecture-dedup-inventory.md)**（Top 10）。摘要：

| # | 禁止 | 规范 | 状态（OPT-B…E 事实） |
|---|------|------|----------------------|
| 1 | 用户「新对话」`createSession` / 空壳 mint | 仅 `enterDraft` / `openNewDraftTab`；`createSessionAndOpenChat` deprecated | **done B2** |
| 2 | strip + sidebar 双开 tab；乱写 `setActive` | shell 管 open/focus；tree 管几何 | **partial C1**（E9 enforce residual） |
| 3–4 | chat / agent 两套 stop；绕过 runControl；散落 dual wire | 统一 L2/L3 + `createStreamCancel`；**streamStop** 共享 wire；**唯一** `sendTerminateDualWire` + **transitional** flag | **partial B7+C6**；dual body 删仍 gated E0 live Stop |
| 5 | 完成消息用 sync TS md 当真源 | `AsyncMarkdownBlock` → Rust `md_render`（含 InlineAgentPanel） | **done B6**（sync = fallback only） |
| 6 | 命令路径满天 `getState()` | 命令走 compositionRoot（layout chrome / **setAppSettings** / tree thin / sidebar / openAgentPanel / chrome / **session pin·archive·branch**） | **partial**（B4+D3+**E5–E7**+**G7**；strip residual） |
| 7 | useChatStream / useAgentStream 双 cancel 原语 | 共享 `streamStop` + createStreamCancel 契约 | **partial C6**（full hook merge residual） |
| 8 | 文档指向已删 `store/session-actions/` | flat `session*Actions.ts` + barrel | **done E8**（docs purge） |
| 9 | ~~新建复用 empty shell~~ **DONE OPT-C2** | draft 哨兵；empty shell 仅 hydrate GC（非 create） | keep prune |
| 10 | 产品功能只挂 direct-fetch | 主路径 Tauri IPC（workbench-run-event）；核心未就绪拒绝启动 | **done C3.4**；`recordTransportDegradedDirectFetch` 仅存度量通道 |

---

## 5. Styles / 样式

| 角色 | 路径 |
|------|------|
| **Token 真源** | `apps/crish-desktop/src/styles/tokens.css` |
| 入口 import | `apps/crish-desktop/src/index.css`（tokens 最先） |
| 补充 | `design-system.css`、`z-index.css`、`theme-dark.css`、`shell/*`、`chat/*`、`settings/*` |

**规则：** 颜色/间距/圆角/层级用 token；组件 CSS **禁止**新增硬编码 hex 当真源。审计见 [`style-token-unification.md`](../plans/progress/style-token-unification.md)。

**OPT-B3 已收口表面：** DiffCard / ApprovalAskCard / ChatToolCall（+ ToolCallHeader）/ settings-base — 去 hex fallback，裸 `var(--accent-*)` 等 token。

---

## 6. Where to put new features / 新功能落点

| 你要做… | 放这里 | 走哪条控制面 |
|---------|--------|--------------|
| UI 组件 / 空态 / 布局 | `apps/crish-desktop/src/components/**` | CP-UI |
| 会话 CRUD / draft / 列表规则 / pin·archive·branch | `store/session*Actions.ts` + compositionRoot.session/shell（**OPT-G7** 写经 `session` facade） | CP-SESS |
| 发送 / 流 / Stop | `hooks/chat-stream/*`、`api/runControlClient.ts`、`api/chat-bridge/handlers` | CP-RUN |
| 工具策略 / 审批 / 工具执行 | `crates/session-loop`（tool_exec / approval）、`crates/agent-tools`（executor） | CP-RUN |
| 编排 / 目标 / 事件持久 | `crates/orchestrator` | CP-RUN |
| 审批处理 / MCP / workflow | `api/chat-bridge/handlers`（前端审批卡片）、`crates/agent-tools`（MCP 桥）、`api/workflowApi.ts` | 契约层 |
| PTY / FS / 原生 md | `apps/agent-workbench/src-tauri` + `crates/*` | CP-HOST |
| 跨包类型 / run-control wire | `packages/shared-types` + `packages/shared-types/src/generated/engine/` | 契约 |
| 外部导入 | `apps/crish-desktop/src/api/import/**` | CP-SESS + HOST |
| Provider 配置 | `apps/crish-desktop/src/api/providerProfiles.ts` → `update-config` | 配置同步 |
| 壳 TS 支持层 | `apps/agent-workbench/src/core`、`src/shared` | 非 desktop 产品路径 |
| 样式 token | `styles/tokens.css` 先扩，再写组件 CSS | CP-UI |

**组装纪律：** 第三处命令调用 → 先扩 `compositionRoot` facade，再散落 `getState`。  
**非产品：** `apps/web-ui`（已移除）、workbench Preact、无框架前端叙述。

---

## 7. Related / 相关

| 文档 | 用途 |
|------|------|
| [`desktop-composition-and-stores.md`](./desktop-composition-and-stores.md) | compositionRoot + store 图 |
| [`streaming-transport-contract.md`](./streaming-transport-contract.md) | 流传输契约 |
| [`engine-events.json`](../../crates/conex-types/contracts/engine-events.json) + [`generated/engine/`](../../packages/shared-types/src/generated/engine/) | 引擎事件契约真源（R3；前端类型生成产物） |
| [`daemon-protocol-single-source.md`](./daemon-protocol-single-source.md) | **历史**：旧 daemon 协议文档（引擎 Rust 化后仅存档） |
| [`multi-unit-layout-restore-adr.md`](./multi-unit-layout-restore-adr.md) | 多 unit 布局恢复 |
