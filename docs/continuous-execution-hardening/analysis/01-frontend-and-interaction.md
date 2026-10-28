# 01 前端交互层深度审查与方案报告：全天候连续运行、权限审批与倒计时状态治理

> **战役主题**：全天候自主 Agent 连续运行与健壮性改造战役 (Continuous Execution Hardening)  
> **审查维度**：01 - 前端交互与权限审批治理 (Frontend & Interaction Layer)  
> **责任文件与核心审查范围**：
> - `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx`
> - `apps/crish-desktop/src/components/agent-card/ApprovalAskCard.tsx`
> - `apps/crish-desktop/src/components/agent-card/useApprovalCountdown.ts`
> - `apps/crish-desktop/src/components/agent-card/ApprovalCountdown.tsx`
> - `apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx`
> - `apps/crish-desktop/src/store/permissionStore.ts`
> - `apps/crish-desktop/src/api/permissionModes.ts`
> - `apps/crish-desktop/src/components/chat-card/useChatApproval.ts`
> - `apps/crish-desktop/src/components/chat-card/useChatApprovalHandlers.ts`
> - `apps/crish-desktop/src/components/chat-card/useChatApprovalExecutor.ts`
> - `apps/crish-desktop/src/api/chat-approval/approvalRollbackGuard.ts`
> - `apps/crish-desktop/src/api/chat-bridge/streamSession.ts`
> - `apps/crish-desktop/src/api/chat-bridge/handlers/approvalHandlers.ts`
> - `apps/crish-desktop/src/hooks/agentStreamCallbacks.ts`
> - `apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts`
> - `apps/crish-desktop/src/store/sessionExecutionTrackerStore.ts`
> - `crates/conex-run/src/run/run_approval.rs`
> - `apps/agent-workbench/src-tauri/src/core_query_commands.rs`
> - `apps/crish-mobile/src/adapters/wiring/approvalWiring.ts`
> **产出规范**：Strictly Read-Only Analysis / UTF-8 无 BOM / 包含绝对与相对路径、具体行号证据、系统性根因分析与架构重构方案 / 严禁执行 git commit

---

## 目录

1. [执行摘要与审查结论 (Executive Summary)](#一执行摘要与审查结论)
2. [权限模式在前端的切换、持久化与下发链路深度审查](#二权限模式在前端的切换持久化与下发链路深度审查)
   - 2.1 [四模式语义、别名映射与引擎端单向塌缩](#21-四模式语义别名映射与引擎端单向塌缩)
   - 2.2 [Composer 切换器与 Plan 模式双向状态机联动](#22-composer-切换器与-plan-模式双向状态机联动)
   - 2.3 [Zustand + localStorage 全局持久化与多会话污染风险](#23-zustand--localstorage-全局持久化与多会话污染风险)
   - 2.4 [静态下发链路与长程任务运行时动态调整断层](#24-静态下发链路与长程任务运行时动态调整断层)
3. [CompactToolRow 遗漏 remainingMs 与 onTimeout 的系统性根因调查](#三compacttoolrow-遗漏-remainingms-与-ontimeout-的系统性根因调查)
   - 3.1 [现象透视与调用栈断裂点代码证据](#31-现象透视与调用栈断裂点代码证据)
   - 3.2 [根因一：后端 Wire 协议截断，未广播超时时间戳](#32-根因一后端-wire-协议截断未广播超时时间戳)
   - 3.3 [根因二：组件树 Props Drilling 管道物理断裂与 Store 字段缺失](#33-根因二组件树-props-drilling-管道物理断裂与-store-字段缺失)
   - 3.4 [根因三：P1 权限归一纪律下的防御性悬空与客户端倒计时规避](#34-根因三p1-权限归一纪律下的防御性悬空与客户端倒计时规避)
   - 3.5 [根因四：Composer 冷静审批条（PermissionBar）与流内卡片的原型分歧](#35-根因四composer-冷静审批条permissionbar与流内卡片的原型分歧)
4. [倒计时 UI 与交互方案设计（无人值守自动放行 vs 自动拒绝）](#四倒计时-ui-与交互方案设计无人值守自动放行-vs-自动拒绝)
   - 4.1 [现有 useApprovalCountdown 的致命时序缺陷与闭包漂移](#41-现有-useapprovalcountdown-的致命时序缺陷与闭包漂移)
   - 4.2 [双轨业务场景划分：Auto-Allow 放行 vs Auto-Deny 拒绝](#42-双轨业务场景划分auto-allow-放行-vs-auto-deny-拒绝)
   - 4.3 [双轨语义状态徽章与三段式渐进色彩紧迫度进度条](#43-双轨语义状态徽章与三段式渐进色彩紧迫度进度条)
   - 4.4 [三级主动干预控制矩阵（Pause & Hold / 立即裁决 / 模式降级）](#44-三级主动干预控制矩阵pause--hold--立即裁决--模式降级)
   - 4.5 [权威时间基准单源（Server Epoch）与本地时钟防休眠漂移校准](#45-权威时间基准单源server-epoch与本地时钟防休眠漂移校准)
5. [桌面挂机与断网重连对审批状态与运行中会话展示的影响与治理建议](#五桌面挂机与断网重连对审批状态与运行中会话展示的影响与治理建议)
   - 5.1 [系统睡眠与后台节流导致的“假死幽灵卡片”与“批准失败”误报链](#51-系统睡眠与后台节流导致的假死幽灵卡片与批准失败误报链)
   - 5.2 [拒绝未送达回滚死锁（Zombie Pending Card Bug）穿透分析](#52-拒绝未送达回滚死锁zombie-pending-card-bug穿透分析)
   - 5.3 [会话水合（Hydration）对运行中任务与审批状态的暴力抹杀](#53-会话水合hydration对运行中任务与审批状态的暴力抹杀)
   - 5.4 [桌面端对账协议（Reconciliation）全线空白与单向事件依赖脆弱性](#54-桌面端对账协议reconciliation全线空白与单向事件依赖脆弱性)
   - 5.5 [执行跟踪器（sessionExecutionTrackerStore）易失性与多会话盲区](#55-执行跟踪器sessionexecutiontrackerstore易失性与多会话盲区)
   - 5.6 [系统性工程治理与重构实施方案](#56-系统性工程治理与重构实施方案)
6. [行动计划与代码改造实施清单 (Actionable Implementation Checklist)](#六行动计划与代码改造实施清单)

---

## 一、执行摘要与审查结论

全天候自主 Agent 的核心目标是在用户离线、夜间挂机或长时间长程批处理场景下，保持任务平稳连续推进。然而，对当前桌面交互层（`apps/crish-desktop`）在权限模式管理、审批卡片交互、倒计时机制以及长程挂机稳定性的全链路代码审查揭示：**前端交互层与引擎协议之间存在严重的“时序断层”、“状态单向脱节”与“挂机自毁逻辑”**，导致全天候无人值守执行在前端形态上完全无法闭环。

核心审查结论归纳如下：

1. **权限模式全局污染与运行时静态锁定**：
   前端权限模式（`ask` / `deep` / `plan` / `full`）由全局单例 `usePermissionStore` 管理并直接持久化于 `localStorage`，导致多会话之间权限相互串扰；更致命的是，`permissionMode` 仅在会话发起（`streamSession.ts`）时作为入参单向注入引擎，长程任务执行过程中用户在 UI 上无法动态提权或降级，模式切换对已在运行中的会话完全失效。
2. **倒计时机制端到端严重断裂（Dead Props Drilling）**：
   `ApprovalAskCard.tsx` 虽具备完善的倒计时进度条与超时回调接口，但在唯一生产渲染路径 `CompactToolRow.tsx` 中，`remainingMs` 与 `onTimeout` **被硬编码漏传（完全悬空为 `undefined`）**。根因在于后端引擎事件信封（`AgentEvent::ApprovalRequested`）未曾下发超时时间戳与策略语义，导致前端组件树管道物理断裂；同时，历史 P1 权限归一纪律为了规避客户端 JS 计时漂移与分布式竞态，采取了防御性悬空策略，但未建立起端到端的替代同步方案。
3. **倒计时交互设计处于“盲盒”态**：
   现存倒计时 Hook（`useApprovalCountdown.ts`）存在因闭包重置导致进度条动态闪烁重置的缺陷；更严重的是，UI 缺乏“超时后究竟是自动放行还是自动拒绝”的策略透明度（Policy Transparency），且缺乏用户回到工位时的“一键暂停（Hold）”与“就地降级”的主动干预手段。
4. **挂机休眠触发“假死卡片”与“拒绝回滚死锁”**：
   桌面长程挂机时，若系统睡眠或 WebView 节流，引擎内部硬编码的 120s 超时过期后清除待办。用户唤醒后前端仍显示待审批卡片，点击“允许”报 `NotFound` 从而误报“批准失败”；点击“拒绝”更因回滚保护代码（`approvalRollbackGuard.ts`）将卡片强制还原为 `pending_approval`，形成**永久无法消除的僵尸死锁卡片**。
5. **桌面端启动与重连对账全线空白，水合暴力抹杀运行态**：
   相比移动端（`crish-mobile`）已接入 `listPendingApprovals` 对账链路，桌面端完全依赖实时流式事件推送，对账能力为零。页面刷新或水合加载时，`sessionHydrationMessages.ts` 盲目将所有 `pending_approval` 和 `running` 状态暴力改写为 `error`（“上次会话中断”），在后台核心正常运行时直接从前端掐死会话。

---

## 二、权限模式在前端的切换、持久化与下发链路深度审查

### 2.1 四模式语义、别名映射与引擎端单向塌缩

前端权限模式定义于 `apps/crish-desktop/src/api/permissionModes.ts`，定义了四种桌面用户交互模式，并在底层与引擎协议的五种模式进行映射：

```typescript
// apps/crish-desktop/src/api/permissionModes.ts:27-30
export type PermissionMode = 'ask' | 'deep' | 'full' | 'plan';

/** 引擎协议 permissionMode（含 unattended 批处理；桌面 UI 暂不暴露） */
export type EnginePermissionMode = 'ask' | 'auto' | 'full-access' | 'plan' | 'unattended';
```

#### 语义映射与单向塌缩表：

| 桌面 UI 模式 (`PermissionMode`) | UI 标签与中文语义 | 下发引擎模式 (`EnginePermissionMode`) | 引擎实际处理策略 (TrustZone 矩阵) | 回写/Hydrate 行为 |
| :--- | :--- | :--- | :--- | :--- |
| **`ask`** | **需确认**（改文件、推送前先问你） | `'ask'` | T0/T2 自动；T1/T3 弹窗确认；T4 极危确认 | 稳定回写为 `ask` |
| **`deep`** | **深入分析**（多读多聊，改文件仍会问你） | `'ask'` | **与 `ask` 物理等价**（引擎无 `deep` 状态机分支） | 引擎回写时**单向塌缩为 `ask`** |
| **`plan`** | **计划**（只出方案，不改项目） | `'plan'` | 仅 T0 只读；写操作 soft-deny，不触发弹窗 | 稳定回写为 `plan` |
| **`full`** | **完全访问**（读写推送自动做，极危才问） | `'full-access'` | T0–T3 全自动放行；T4 极危操作强制二次确认 | 稳定回写为 `full` |

#### 代码证据与隐患：

1. **`deep` 模式的视觉假象与回写塌缩**：
   在 `apps/crish-desktop/src/api/permissionModes.ts:63-68` 的映射真相表 `DESKTOP_TO_ENGINE` 中：
   ```typescript
   export const DESKTOP_TO_ENGINE: Readonly<Record<PermissionMode, EnginePermissionMode>> = {
     ask: 'ask',
     deep: 'ask', // deep 在引擎侧与 ask 完全同构
     full: 'full-access',
     plan: 'plan',
   };
   ```
   `deep` 模式仅在前端作为心理预期标签存在，引擎侧完全当作 `ask` 执行。若设置页或状态同步发生 `desktopEngineRoundTrip`，`deep` 模式会被引擎返回值重置为 `ask`（`permissionModes.ts:267` 注释明文指出：“*deep 会塌缩为 ask，属预期*”）。
2. **无人值守模式被强行封印与回退**：
   引擎内核原生支持 `unattended`（批处理无人值守）与 `auto`（全自动驾驶），但前端规范化函数 `normalizePermissionMode`（`permissionModes.ts:158-175`）将 `unattended`、`headless`、`batch`、`auto` 等全部强制回退收敛至 `ask`。这导致用户即便在后台启动了批处理任务，前端一旦介入，也会强制将其拉回“人工需确认”流程，阻碍全天候自主连续运行。

---

### 2.2 Composer 切换器与 Plan 模式双向状态机联动

#### 1. 切换器渲染与交互管理
切换器组件实现于 `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx`：
- **Pill 触发器与独占菜单**：`PermissionModeMenu:86-124` 渲染底部输入框内的模式药丸按钮（`styles.permPill`），并绑定 `pillBtnRef`。点击通过 `toggleExclusiveMenu`（第 67 行）实现与其它菜单互斥。
- **模式选项漫游**：第 70-74 行提取 `DESKTOP_PERMISSION_MODE_IDS`（`ask` -> `deep` -> `plan` -> `full`），通过 `selectMode` 调用 `transitionPermissionMode` 并触发 `onChange(next)`。
- **视觉 Token**：第 16-21 行分别映射专属图标（`shield-check`、`search`、`target`、`alert-circle`），并通过翡翠绿 Checkmark 标识选中态。

#### 2. Plan 模式的双向联动状态机
在 `apps/crish-desktop/src/api/permissionModes.ts:327-340` 与 `apps/crish-desktop/src/store/permissionStore.ts:73-86` 中，建立了 Plan 模式与权限模式的强联动：
```typescript
// apps/crish-desktop/src/api/permissionModes.ts:332-340
export function permissionModeAfterPlanToggle(
  currently: PermissionMode | unknown,
  planEnabled: boolean,
): PermissionMode {
  const cur = coercePermissionMode(currently);
  if (planEnabled) return 'plan';
  if (cur === 'plan') return DEFAULT_PERMISSION_MODE; // 关 plan 且原为 plan 时回退到 ask
  return cur;
}
```
当用户在界面开启“计划模式（Plan Mode）”功能时，`setPlanModeEnabled(true)` 会强制将全局 `permissionMode` 覆写为 `plan`；当用户关闭计划模式时，若当前处于 `plan`，则自动复位至 `ask`。该联动保证了只读规划与写权限的逻辑闭环。

---

### 2.3 Zustand + localStorage 全局持久化与多会话污染风险

#### 存储机制实现
`apps/crish-desktop/src/store/permissionStore.ts:52-71`：
```typescript
const initialPermissionMode = loadStoredPermissionMode();

export const usePermissionStore = create<PermissionStore>()(
  withDevtools(
    withLogger(
      immer((set) => ({
        permissionMode: initialPermissionMode,
        planModeEnabled: planModeEnabledFor(initialPermissionMode),
        planApproved: false,
        commandPermissions: loadCommandPermissions(),

        setPermissionMode: (mode: PermissionMode) => {
          set((state) => {
            state.permissionMode = mode;
            state.planModeEnabled = planModeEnabledFor(mode);
            state.planApproved = false;
          });
          persistPermissionMode(mode); // 写入 localStorage: crish_permission_mode
        },
...
```

#### 架构缺陷分析：全局单例泄漏 (Global Singleton Contamination)
1. **跨会话状态穿透**：
   `usePermissionStore` 是进程级唯一单例，其状态对应整个桌面应用（通过 `localStorage['crish_permission_mode']` 全局保存）。
2. **多 Agent / 多任务协同隐患**：
   在全天候运行场景中，用户可能开启了多个并行会话（例如会话 A 执行后台长程数据迁移任务，需要 `full` 或 `unattended`；会话 B 进行核心业务代码审计，要求严格的 `plan` 或 `ask`）。
   在当前架构下，用户在会话 A 中切换到 `full`，会立刻无声息地改变全局 `permissionStore`，导致会话 B 发起的任务也意外以 `full-access` 下发引擎，**造成灾难性的跨会话越权执行**！

---

### 2.4 静态下发链路与长程任务运行时动态调整断层

#### 下发链路代码路径
会话执行的组装与分派见 `apps/crish-desktop/src/api/chat-bridge/streamSession.ts`：
```typescript
// streamSession.ts:90-91
const mode = getPermissionMode(); // 从全局 usePermissionStore 读取
const permissionMode = toEnginePermissionMode(mode); // 转为 EnginePermissionMode

// streamSession.ts:159-163
await startRunTask(transport, {
  runId,
  prompt,
  sessionId: safeSessionId,
  permissionMode, // 注入 core_run_task 参数包
  ...
}, () => getWorkspacePath() || undefined);
```
`startRunTask`（`apps/crish-desktop/src/api/transport/index.ts:35-55`）通过 Tauri IPC 向 Rust 核心分派 `core_run_task`。

#### 运行时断层分析：
1. **“一次性”静态参数锁定**：
   `permissionMode` 仅在会话发起（`core_run_task`）那一瞬间被采样一次并送入后端。
2. **运行中动态升降级通道完全缺失**：
   长程 Agent 任务可能连续运行数小时并调用上百次工具。当用户在任务运行中需要离开工位（希望将当前任务临时升级为 `full` 自动放行），或者发现 Agent 行为有偏差需要紧急降级为 `ask` 或 `plan` 时，**前端与后端之间完全没有提供 `core_update_run_permission_mode` 这类动态调整 IPC 协议**。
   用户在 UI 上点击模式切换只能改变未来新会话的配置，对当前卡在审批中的长程任务毫无作用。

---

## 三、CompactToolRow 遗漏 remainingMs 与 onTimeout 的系统性根因调查

### 3.1 现象透视与调用栈断裂点代码证据

在组件层，`ApprovalAskCard.tsx` 完整支持超时与倒计时功能：
```typescript
// apps/crish-desktop/src/components/agent-card/ApprovalAskCard.tsx:62-66
type Props = {
  ...
  remainingMs?: number | undefined;
  onTimeout?: (() => void) | undefined;
};
```
在卡片内部（第 220-224 行）接入了 `useApprovalCountdown`，并在第 383-385 行挂载了进度条：
```typescript
{remainingMs != null ? (
  <ApprovalCountdown remainingMs={remainingMs} percent={timeoutPercent} />
) : null}
```
然而，在全仓唯一的真实生产渲染点 `apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx:153-170` 中：
```typescript
// CompactToolRow.tsx:153-170
<ApprovalAskCard
  msgId={mid ?? ''}
  toolId={tc.id}
  summary={summary}
  cmd={tech && tech !== summary ? tech : techFull || undefined}
  busy={approvalBusy}
  riskMeta={tc.approvalMeta}
  onAllow={() => {
    if (tc.id && mid) onApprovalAllow!(tc.id, mid, false);
  }}
  onAllowRemember={() => {
    if (tc.id && mid) onApprovalAllow!(tc.id, mid, true);
  }}
  onDeny={() => {
    if (tc.id && mid) onApprovalDeny!(tc.id, mid);
  }}
  // 【致命断裂】：根本没有传入 remainingMs 与 onTimeout！
/>
```
导致在真实运行时环境中，卡片永远接收到 `remainingMs = undefined`，倒计时进度条与超时自动化完全形同虚设！

---

### 3.2 根因一：后端 Wire 协议截断，未广播超时时间戳

深入审查 Rust 引擎审批门发射事件的代码 `crates/conex-run/src/run/run_approval.rs:269-291`：
```rust
// crates/conex-run/src/run/run_approval.rs:269-291
let request = PermissionRequest {
    id: format!("approval-{call_id}"),
    session_id: self.session_id.clone(),
    cwd: self.cwd.clone().unwrap_or_default(),
    tool_call_id: call_id.to_string(),
    tool_name: tool_name.to_string(),
    parameters: args.clone(),
    summary: format!("call {tool_name}"),
    tool_metadata: Default::default(),
    metadata: arbiter_metadata(arbiter),
    requester_run_id: requester.map(|r| r.run_id.clone()),
    reason: requester.and_then(|r| r.reason.clone()),
};
(self.broadcast)(AgentEvent::ApprovalRequested {
    session_id: self.session_id.clone(),
    request,
    timestamp: crate::engine_provider::now_iso_utc(),
});
```
- **协议盲区**：虽然引擎内部在 `PendingRequestMeta`（第 336 行）中记录了 `requested_at_ms`，并且内部运行着 `self.approval_timeout`（120s），但是对外广播的 `PermissionRequest` 结构体与 `AgentEvent::ApprovalRequested` **未包含任何超时预算（如 `timeoutMs: 120000`）或截止时间戳（如 `expiresAt: 1791764690000`）**！
- 协议层面没有这些字段，前端即使想要计算剩余时间也无从获知引擎的真实等待策略。

---

### 3.3 根因二：组件树 Props Drilling 管道物理断裂与 Store 字段缺失

从事件监听至组件渲染的整条链路存在结构性断裂：

```text
[Rust IPC: AgentEvent::ApprovalRequested]
        │
        ▼ (丢失 timeoutMs/expiresAt)
[apps/crish-desktop/src/api/chat-bridge/handlers/approvalHandlers.ts:26]
        │ onApprovalRequested 调用 callbacks.onToolPendingApproval(...)
        ▼ (缺少超时入参)
[apps/crish-desktop/src/hooks/agentStreamCallbacks.ts:220]
        │ 构造 MessageToolCall 对象
        ▼ (MessageToolCall 接口中无 requestedAt/expiresAt 字段)
[apps/crish-desktop/src/store/types.ts:314]
        │
        ▼
[apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.tsx:47]
        │ ChatToolStackProps 接口中无 remainingMs/onTimeout 字段
        ▼
[apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx:154]
          渲染 ApprovalAskCard 时无法传值！
```

1. **类型定义缺失**：审查 `apps/crish-desktop/src/store/types.ts:314-335`，`MessageToolCall` 仅包含 `id, name, arguments, status, output, diffs, explanation, approvalMeta, approvalDecision, startedAt, durationMs`，根本没有为待审批倒计时设计任何数据槽位。
2. **中间层断通**：`ChatToolStackProps`（`ChatToolCallBlock.tsx:47-72`）只传递了 `approvalBusy` 与操作函数，完全将时间维度的状态遗忘在管道之外。

---

### 3.4 根因三：P1 权限归一纪律下的防御性悬空与客户端倒计时规避

审查 `apps/crish-desktop/src/api/chat-bridge/handlers/approvalHandlers.ts:7-13` 头注：
> “*P1 权限归一（B1/D1，前端二次决策 1→0）：前端不再替用户决定「引擎已判 NeedsApproval 的操作」... 裁决唯一入口 = 用户 approve/deny 按钮（engineApproveTool / engineDenyTool）。审批权威 = 引擎 ApprovalGateImpl::resolve 单一 pending 校验。*”

- **历史背景与竞态顾虑**：
  在 P1 重构前，曾存在前端根据本地定时器自动触发拒绝或放行的尝试。然而，前端 JS 定时器在浏览器切后台、休眠或主线程卡顿时代差极大。如果前端单方面通过 `onTimeout` 触发拒绝调用 `engineDenyTool`，而远端（如手机端或用户手动在最后一毫秒点击了“允许”）刚好产生网络并发，将导致双重决断竞态。
- **防御性悬空**：
  为彻底消除“前端二次裁判”，架构师收窄了职责，要求所有审批裁决必须以引擎为唯一真理源（SSOT）。然而，在斩断前端独立倒计时决策的同时，**未同步完成“由引擎下发权威倒计时基准并在前端仅做渲染”的时钟同步体系**，导致 `remainingMs` 被直接悬空忽略。

---

### 3.5 根因四：Composer 冷静审批条（PermissionBar）与流内卡片的原型分歧

审查 `CompactToolRow.tsx:133-137`：
```typescript
if (tc.status === 'pending_approval') {
  // 插件开：审批上提 composer 冷静条，流内不画 ApprovalAskCard
  if (slotCore.getSingle('workspace.chat.composerAbove')) {
    return null;
  }
...
```
而在官方对话流扩展的 `PermissionBar.tsx:4`（`apps/crish-desktop/src/extensions/conversation-flow/PermissionBar.tsx`）中明文写道：
> “*回调走 useChatApproval / engineApproveTool；不要演示倒计时槽。*”

这揭示了开发过程中的设计割裂：一部分开发者认为审批条应常驻于输入框上方（冷静条），不需要花哨的倒计时；另一部分开发者为流内卡片编写了 `ApprovalCountdown` 和 `useApprovalCountdown`，但仅停留在单测验证阶段，两套方案未能在全天候连续执行的背景下形成合力。

---

## 四、倒计时 UI 与交互方案设计（无人值守自动放行 vs 自动拒绝）

### 4.1 现有 useApprovalCountdown 的致命时序缺陷与闭包漂移

现存的 `apps/crish-desktop/src/components/agent-card/useApprovalCountdown.ts` 存在严重的实现缺陷：

```typescript
// apps/crish-desktop/src/components/agent-card/useApprovalCountdown.ts:37-76
useEffect(() => {
  if (remainingMs == null) return;
  if (remainingMs <= 0) {
    setTimeoutPercent(0);
    expiredRef.current = true;
    if (!timeoutFiredRef.current && !busyRef.current) {
      timeoutFiredRef.current = true;
      onTimeoutRef.current?.();
    }
    return;
  }

  const total = Math.max(remainingMs, 1);
  timeoutTotalRef.current = total; // 缺陷：每次 remainingMs 变化，total 都被重新赋值！
  timeoutFiredRef.current = false;
  expiredRef.current = false;
  setTimeoutPercent(100); // 缺陷：进度条瞬间重置为 100% 满格闪烁！

  const endTime = Date.now() + remainingMs; // 缺陷：基于本地相对时间累加，休眠后严重漂移

  const interval = setInterval(() => {
    const remaining = endTime - Date.now();
    ...
  }, 100);
  return () => clearInterval(interval);
}, [remainingMs]); // 依赖了 remainingMs！
```

#### 缺陷根因穿透：
1. **重渲染进度条跳跃重置 (Progress Jump Bug)**：
   若父组件由于其他状态（如网络活动、Token 流式生成）触发重渲染，重新传入经轻微校准的 `remainingMs`，该 Hook 会将 `timeoutPercent` 强制重置为 100%，导致界面上的进度条发生抽搐和倒流。
2. **浏览器休眠失效**：
   依靠 `setInterval(..., 100)` 驱动，当系统休眠或标签页挂起时，浏览器调度器会冻结或降频至 1000ms+。唤醒后缺乏对绝对服务端时间戳的补偿计算。

---

### 4.2 双轨业务场景划分：Auto-Allow 放行 vs Auto-Deny 拒绝

全天候连续执行需要区分两种截然不同的倒计时策略：

| 策略维度 | 场景 A：无人值守自动放行 (Unattended Auto-Allow) | 场景 B：超时安全保护自动拒绝 (Safety Auto-Deny) |
| :--- | :--- | :--- |
| **核心目的** | 保障长程任务连续运转，非致命/低风险操作自主推进 | 兜底防死锁，防止常规会话在用户离开后无限期卡停 |
| **触发条件** | 用户明确开启 `Unattended Mode` 且操作属于 T1/T2 或非破坏性工具 | 常规 `ask` 模式，等待超时无人应答 |
| **超时终态** | 自动向引擎上报 `Approved`，任务继续执行 | 引擎上报 `Expired`（等效 `Denied`），任务受控暂停或报错 |
| **红线保护** | **严禁对 T4 极危操作自动放行**（T4 强制回退为安全拒绝） | 适用于全量工具 |
| **UI 视觉主色** | 科技蓝 / 翡翠绿（推进感、安定感） | 警示琥珀色 / 珊瑚红（紧迫感、防线感） |

---

### 4.3 双轨语义状态徽章与三段式渐进色彩紧迫度进度条

针对当前 `ApprovalCountdown.tsx` 只有一条细线且无秒数文本的问题，设计全新交互形态：

```
┌────────────────────────────────────────────────────────────────────────┐
│  🛡️ 需要你的确认                                   [无人值守 · 自动放行] │
│                                                                        │
│  是否允许执行测试套件回归？                                              │
│  npm test -- --project=unit                                            │
│                                                                        │
│  [========================================>..........]  ⏱️ 00:18       │
│  提示：若无手动干预，将在 18 秒后自动批准执行以保障夜间流程连续推进         │
│                                                                        │
│  [ ⏸️ 暂停倒计时 ]         [ ❌ 拒绝 ]                 [ ✔️ 立即允许 ]   │
└────────────────────────────────────────────────────────────────────────┘
```

#### 关键设计要素：
1. **策略透明度徽章 (Policy Transparency Badge)**：
   - 自动放行：渲染 `data-countdown-policy="auto-allow"`，文案展示为“无人值守 · 24s 后自动放行”。
   - 安全拒绝：渲染 `data-countdown-policy="auto-deny"`，文案展示为“超时保护 · 45s 后自动拒绝”。
2. **三段式紧迫度进度条色彩转移 (Graduated Visual Tension)**：
   - **平稳阶段（剩余 >30%）**：CSS 变量 `--accent-calm`（冷灰或沉静蓝），进度条匀速收缩。
   - **预警阶段（剩余 10s ~ 30%）**：平滑过渡至 `--accent-warning`（琥珀黄），提示用户注意。
   - **濒死冲刺阶段（剩余 <10s）**：激进切换至 `--accent-danger`（珊瑚红），伴随秒数数字每秒一次的微型脉冲缩放动效（`scale(1.05)`），向工位附近的物理用户发出强烈的视觉警报。

---

### 4.4 三级主动干预控制矩阵（Pause & Hold / 立即裁决 / 模式降级）

无人值守系统必须赋予“突然回到工位的用户”绝对的最高控制权：

1. **第一级：一键暂停倒计时（Pause & Hold）**：
   - **交互痛点**：用户刚泡完咖啡回来，看到倒计时还剩 3 秒，想看清命令却来不及。
   - **解决机制**：在卡片显著位置提供 `[ ⏸️ 暂停倒计时 ]` 按钮。点击后：
     - 立即停止前端进度条跑动，UI 切换为静态等待态；
     - 向后端发送 IPC 命令 `core_pause_approval_timeout(toolCallId)`，后端挂起该 oneshot 通道的超时计时器，等待人工最终裁决。
2. **第二级：即时确定性裁决（Immediate Settle）**：
   - `[ ✔️ 立即允许 ]` 与 `[ ❌ 拒绝 ]` 保持顶级操作位。
   - 用户任何时刻点击允许或拒绝，倒计时逻辑立即被卸载销毁，彻底消除竞态。
3. **第三级：就地退出无人值守（Drop out of Unattended）**：
   - 在卡片辅助操作菜单中提供“本次运行降级为需确认模式”。
   - 用户点击后，不仅当前工具卡停，后续所有未执行步骤全部恢复为人工手动审批。

---

### 4.5 权威时间基准单源（Server Epoch）与本地时钟防休眠漂移校准

为根除 `useApprovalCountdown.ts` 的重渲染闪烁与休眠漂移缺陷，提出“**基于服务端绝对时间戳的单源时钟模型**”：

```typescript
// 建议重构的 useApprovalClock.ts
export interface UseApprovalClockOptions {
  /** 后端给出的绝对过期时间戳（Epoch 毫秒，SSOT） */
  expiresAtMs?: number;
  /** 总持续时长（用于计算百分比分母） */
  totalDurationMs?: number;
  busy?: boolean;
  onTimeout?: () => void;
}

export function useApprovalClock({
  expiresAtMs,
  totalDurationMs,
  busy,
  onTimeout,
}: UseApprovalClockOptions) {
  const [remainingMs, setRemainingMs] = useState<number>(() =>
    expiresAtMs ? Math.max(0, expiresAtMs - Date.now()) : 0
  );

  useEffect(() => {
    if (!expiresAtMs || busy) return;

    const tick = () => {
      const now = Date.now();
      const left = Math.max(0, expiresAtMs - now);
      setRemainingMs(left);
      if (left <= 0) {
        clearInterval(timer);
        onTimeout?.();
      }
    };

    tick();
    const timer = setInterval(tick, 200); // 降低轮询频率，通过 requestAnimationFrame 或 CSS 动画补间
    return () => clearInterval(timer);
  }, [expiresAtMs, busy, onTimeout]);

  const percent = totalDurationMs && totalDurationMs > 0
    ? Math.max(0, Math.min(100, (remainingMs / totalDurationMs) * 100))
    : 0;

  return { remainingMs, percent, isExpired: remainingMs <= 0 };
}
```
- **抗休眠能力**：无论计算机休眠多久，唤醒那一刻 `Date.now()` 与 `expiresAtMs` 直接比对，立即准确得出已超时（`remainingMs = 0`），不会产生中间漏跳或重头跑动的假象。

---

## 五、桌面挂机与断网重连对审批状态与运行中会话展示的影响与治理建议

### 5.1 系统睡眠与后台节流导致的“假死幽灵卡片”与“批准失败”误报链

#### 现场时序推演与代码证据：
1. **引擎超时静默发生**：
   挂机期间，Windows 进入低功耗睡眠或锁屏。Rust 引擎在 120 秒到期后执行 `crates/conex-run/src/run/run_approval.rs:346-364`：
   ```rust
   match tokio::time::timeout(self.approval_timeout, rx).await {
       Ok(Ok(decision)) => decision,
       Ok(Err(_)) | Err(_) => {
           self.pending.lock().unwrap().remove(call_id);
           self.pending_meta.lock().unwrap().remove(call_id);
           ApprovalDecision::Expired
       }
   }
   ```
   请求已被从引擎内物理抹除，会话转向报错或下一步。
2. **前端时钟脱节与幽灵卡片残留**：
   由于桌面端休眠，前端 WebView 未能及时消费或由于通道挂起丢弃了 `approval-resolved`。唤醒后，前端界面依然停留在 `pending_approval` 状态。
3. **用户点击与错误升级**：
   用户以为任务还在等他，点击卡片上的“允许”。触发 `useChatApprovalExecutor.ts:43-92`：
   ```typescript
   await engineApproveTool(tid); // invoke('core_approve_tool', { toolCallId: tid })
   ```
   后端执行 `crates/conex-run/src/run/run_approval.rs:177`：
   ```rust
   let sender = self.pending.lock().unwrap().remove(tool_call_id)
       .ok_or_else(|| CoreError::NotFound(format!("tool_call_id not in pending approvals...")))?;
   ```
   后端返回 `NotFound`。前端直接进入 `catch` 块（第 82-86 行）：
   ```typescript
   updateMessageToolCall(activeSessionId, mid, tid, {
     status: 'error',
     output: '批准失败',
   });
   showToast('批准失败，请重试');
   ```
   **严重后果**：原本属于正常的“等待超时已过期”，被系统粗暴定性并提示为“批准失败，请重试”。用户多次点击永远重试失败，造成极差的可用性体验与心理恐慌。

---

### 5.2 拒绝未送达回滚死锁（Zombie Pending Card Bug）穿透分析

在 `apps/crish-desktop/src/components/chat-card/useChatApprovalExecutor.ts:94-123` 中，拒绝操作的处理暴露了一个严重的死锁 Bug：

```typescript
// useChatApprovalExecutor.ts:103-120
try {
  updateMessageToolCall(activeSessionId, mid, tid, {
    status: 'error',
    output: '已拒绝',
  });
  await engineDenyTool(tid); // 后端返回 NotFound 抛错
} catch (_err) {
  const { t: currentTc } = findChatTool(activeSessionId, mid, tid);
  if (shouldSkipDenyRollback(currentTc)) return;

  // 【致命回滚】：强制回退为 pending_approval！
  updateMessageToolCall(activeSessionId, mid, tid, {
    status: 'pending_approval',
    output: '拒绝未送达',
  });
  showToast('拒绝未送达，请重试');
}
```

结合 `apps/crish-desktop/src/api/chat-approval/approvalRollbackGuard.ts:26-31`：
```typescript
export function shouldSkipDenyRollback(
  currentTc?: MessageToolCall | null
): boolean {
  if (!currentTc) return false;
  return currentTc.status === 'running' || currentTc.status === 'success';
}
```

#### 死锁发生过程：
1. 工具因挂机超时在后端已被移除。
2. 用户唤醒后点击“拒绝”。
3. `engineDenyTool` 抛出 `NotFound` 异常。
4. `shouldSkipDenyRollback` 检查发现当前 `status` 不是 `running` 或 `success`（刚才被设为了 `error`），因此返回 `false`（不跳过回滚）。
5. 回滚执行：工具状态**被重新置回 `pending_approval`**，并在下方显示 `拒绝未送达`。
6. 卡片继续渲染在屏幕上，用户再次点击拒绝或允许依然抛错并回滚。**此卡片化身为不可清除的僵尸死锁，永久污染会话流！**

---

### 5.3 会话水合（Hydration）对运行中任务与审批状态的暴力抹杀

在桌面端重启或刷新重新水合消息历史时，`apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts:542-557` 存在极其激进的破坏性逻辑：

```typescript
// apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts:542-557
if (next.toolCalls?.length) {
  next = {
    ...next,
    toolCalls: next.toolCalls.map((tc) =>
      tc.status === 'running' || tc.status === 'pending_approval'
        ? {
            ...tc,
            status: 'error' as const,
            output: tc.output?.trim()
              ? tc.output
              : '上次会话中断，工具未完成',
          }
        : tc
    ),
  };
}
```

#### 架构冲击：
- 在全天候 Agent 架构中，Rust 核心（`conex-run` / Tauri Sidecar / Daemon）是一个独立的后台服务进程或常驻核心。
- 如果前端 WebView 崩溃、意外刷新或用户重启了桌面窗口，后端的 Agent 任务和审批门**完全可能依然健康运行着**。
- 但前端一旦执行水合，就会武断地将所有正在等待审批（`pending_approval`）和正在执行（`running`）的工具直接打上 `error` 标记，并填充“*上次会话中断，工具未完成*”的硬编码死文字。
- 前端主动切断了重连与接管正在运行会话的一切可能！

---

### 5.4 桌面端对账协议（Reconciliation）全线空白与单向事件依赖脆弱性

#### 桌面端 vs 移动端对账实现对比：

| 维度 | 移动端 (`crish-mobile`) | 桌面端 (`crish-desktop`) |
| :--- | :--- | :--- |
| **对账入口** | 具备 `gatewayListPendingApprovals`（`approvalWiring.ts:157`） | **完全没有调用对账接口，全仓检索为 0** |
| **时戳基准** | 解析 `receivedAtMs` 与 `expiresAt`（`approvalWiring.ts:177`） | 依赖前端本地相对时钟推导 |
| **脱机自愈** | 启动对账补齐离线待审批条目，已过期条目自动出队 | 离线错过广播即永久丢失状态 |
| **后端支撑** | 共享 Rust 后端 `core_get_system_status` / `GET /v1/approvals/pending` | 虽同源同一个 Tauri 壳，桌面端却未接入 |

后端早已在 `apps/agent-workbench/src-tauri/src/core_query_commands.rs:226-229` 中装配了完善的查询能力：
```rust
conex_run::run::list_active_runs_impl(&core).await,
conex_run::run::list_pending_approval_summaries_impl(&core),
```
但 `crish-desktop` 的架构在历史迭代中形成了“**完全依赖实时事件单向广播，不做拉网对账**”的脆弱范式。一旦网络断流或系统挂起，事件信封丢失，前端状态立刻沦为“孤岛”。

---

### 5.5 执行跟踪器（sessionExecutionTrackerStore）易失性与多会话盲区

在 `apps/crish-desktop/src/store/sessionExecutionTrackerStore.ts:1-61` 中，设计了跟踪所有会话后台执行状态的单轨状态机：
```typescript
export type SessionExecutionStage =
  | 'waiting_approval'
  | 'executing_tool'
  | 'thinking'
  | 'streaming_text'
  ...
```
- **完全内存化（In-Memory Volatile）**：
  该 Store 没有任何持久化或与 Rust 核心状态的对齐机制。窗口一刷新，所有正在执行或等待审批的后台标记清空。
- **全局通知与侧栏红点失联**：
  挂机期间，若会话 A 在后台触发了 `waiting_approval`，前端如果由于休眠错过了 `onToolPendingApproval`，该 Tracker 无法记录红点，侧栏和系统托盘无法唤醒用户，导致任务静默超时死锁。

---

### 5.6 系统性工程治理与重构实施方案

为了彻底解决挂机、休眠、断网与审批状态的顽疾，必须在前端落地以下三大治理支柱：

#### 支柱一：断网恢复与页面可见性对账总线 (Reconciliation Bus)
在应用生命周期根部引入重连与唤醒对账器：
```typescript
// 建议在 api/chat-bridge/reconciliation.ts 中实现
export async function reconcileDesktopSessionState(): Promise<void> {
  const transport = getTransport();
  if (!transport.isReady()) return;

  // 1. 调用已有的底层命令读取当前活跃 runs 与待审批条目
  const systemStatus = await transport.request('core_get_system_status');
  const pendingApprovals = systemStatus.pendingApprovals; // 来自 list_pending_approval_summaries_impl

  // 2. 扫描前端所有活跃会话中的 pending_approval 工具
  const pendingToolsInStore = findAllPendingApprovalToolsInStore();

  // 3. 差异对账 (Diff Reconciliation)
  for (const localTc of pendingToolsInStore) {
    const remote = pendingApprovals.find(p => p.toolCallId === localTc.id);
    if (!remote) {
      // 后端已无此请求 -> 标记为已过期或在其他端裁决，平稳收拢终态，消除僵尸卡片！
      markToolCallExpired(localTc.sessionId, localTc.msgId, localTc.id);
    }
  }
}
```
- 触发时机：
  1. `window.addEventListener('online', reconcileDesktopSessionState)`
  2. `document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconcileDesktopSessionState(); })`
  3. Tauri 主窗口事件 `tauri://focus`
  4. `transport.onReady` 重新连接时。

#### 支柱二：精细化错误码与智能拒绝收口 (Smart Settle for NotFound)
在 `useChatApprovalExecutor.ts` 的 catch 块中，针对 `NotFound` / `approval_mismatch` 实施断门保护：
```typescript
} catch (err) {
  const msg = String(err?.message || err);
  const isNotFoundOrExpired = /not in pending|NotFound|approval_mismatch/i.test(msg);

  if (isNotFoundOrExpired) {
    // 明确属于过期或已裁决，直接标记为 expired 终态，绝不触发回滚！
    updateMessageToolCall(activeSessionId, mid, tid, {
      status: 'error',
      output: '审批已失效或已被处理（超时）',
    });
    showToast('该审批已超时或已在其他设备完成');
    return;
  }

  // 仅在真实的网络 IO 失败时才执行谨慎的回滚与重试提示
...
```

#### 支柱三：水合探活守卫 (Active-Run Probing Hydration)
重构 `sanitizeMessagesForHydrate`：
- 在将消息置为 `error` 前，先查询当前会话是否属于活跃会话（`activeRuns[sessionId]` 或 `core_list_active_runs`）。
- 若会话对应的 Rust 任务仍在运行，**坚决保留其 `running` 和 `pending_approval` 状态**，并主动重新挂接事件流监听器，实现无缝断点续接。

---

## 六、行动计划与代码改造实施清单

| 阶段 | 编号 | 任务项 | 涉及文件 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| **P0 紧急缺陷修复** | FIX-01 | 修复 `CompactToolRow` 漏传倒计时参数 Bug | `CompactToolRow.tsx`, `ChatToolCallBlock.tsx` | `CompactToolRow` 渲染 `ApprovalAskCard` 时正确传参；单测验证透传字段无丢失 |
| **P0 紧急缺陷修复** | FIX-02 | 根除 `useChatApprovalExecutor` 拒绝未送达回滚死锁 | `useChatApprovalExecutor.ts`, `approvalRollbackGuard.ts` | 审批已过期时点击拒绝直接收口为 expired 终态，绝不回滚为 pending 卡死 |
| **P1 协议与时钟对齐** | PROT-01 | 引擎广播 `ApprovalRequested` 补齐超时绝对时间戳 | `crates/conex-run/src/run/run_approval.rs`, `packages/shared-types` | 信封新增 `timeoutMs` 与 `expiresAt`；前端解析层无漂移提取 |
| **P1 协议与时钟对齐** | PROT-02 | 前端重构 `useApprovalCountdown` 为基于服务端绝对时钟 | `useApprovalCountdown.ts`, `ApprovalCountdown.tsx` | 组件重渲染进度条不跳跃；系统休眠唤醒立即精准对齐剩余时间 |
| **P2 UI 交互重塑** | UI-01 | 落地双轨语义状态徽章与多段渐变紧迫度进度条 | `ApprovalAskCard.tsx`, `ApprovalCountdown.tsx` | 明确显示自动放行/自动拒绝语义、剩余秒数文本，最后 10s 变红脉冲 |
| **P2 UI 交互重塑** | UI-02 | 落地用户三级主动干预控制（暂停倒计时/就地降级） | `ApprovalAskCard.tsx`, `ApprovalActions.tsx` | 用户点击“暂停”冻结倒计时并上报引擎，提供撤出无人值守模式入口 |
| **P3 挂机与连续执行** | CONT-01 | 建立桌面端窗口唤醒与重连拉网对账总线 | `apps/crish-desktop/src/api/chat-bridge/reconciliation.ts` | 桌面唤醒后自动拉取 `core_get_system_status` 清除幽灵待审批卡片 |
| **P3 挂机与连续执行** | CONT-02 | 水合层改造：引入后台活跃 Run 探活保护 | `sessionHydrationMessages.ts`, `sessionStore.ts` | 页面刷新不抹杀后台正在跑的会话工具状态，自动重新绑定事件流 |
| **P4 权限域治理** | PERM-01 | 权限模式从全局单例解耦为会话级独立作用域 | `permissionStore.ts`, `streamSession.ts` | 允许不同会话拥有独立权限配置，彻底杜绝全局状态污染 |
| **P4 权限域治理** | PERM-02 | 支持长程任务运行中动态调整权限模式 | `streamSession.ts`, `crates/conex-run` | 任务执行中用户在 UI 切换权限模式实时向引擎同步并生效 |

---

> **报告归档说明**：本报告为战役 01 维度的深度静态审查与权威改进方案，结论将作为后续代码重构波次（Batch）的实施输入基准。