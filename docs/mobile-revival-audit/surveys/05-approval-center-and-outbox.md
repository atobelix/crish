# 专项审计报告 05：审批中心与 Outbox 队列 (approval-center-and-outbox)

> **审计基准**：`apps/crish-mobile`（Expo SDK 57 / RN 0.86 / React 19.2.3）与 `apps/agent-workbench`（Tauri / Rust 内核）  
> **调查员**：审批中心与 Outbox 队列调查员  
> **产出时间**：2026-09-04  
> **审计范围**：
> - `apps/crish-mobile/src/domain/store/approvalStore.ts`、`approvalReducers.ts`、`approvalMappers.ts`
> - `apps/crish-mobile/src/domain/data/outbox.ts`
> - `apps/crish-mobile/src/adapters/wiring/approvalWiring.ts`
> - `apps/crish-mobile/src/adapters/viewmodels/useApprovalListVm.ts`、`useApprovalDetailVm.ts`
> - `apps/crish-mobile/src/presentation/screens/approvalListScreen.tsx`、`approvalDetailScreen.tsx`
> - `apps/crish-mobile/src/presentation/components/blocks/ApprovalCard.tsx`、`ApprovalActionBar.tsx`
> - `apps/crish-mobile/src/domain/repositories/approvalCommands.ts`
> - `apps/crish-mobile/src/db/dao/approvalQueueDao.ts`、`approvalHistoryDao.ts`
> - 桌面端对应契约与实现：`crates/conex-types/contracts/device-protocol.json`、`crates/conex-types/src/device/commands.rs`、`apps/agent-workbench/src-tauri/src/server/`（`ws.rs`, `router.rs`, `core_backend.rs`）、`apps/agent-workbench/src-tauri/src/run/run_approval.rs`

---

## 模块架构全景

```
[WebSocket Inbound: events.push / events.resume.page]
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│ approvalWiring.ts (ApprovalBridge)                      │
│ - 帧提取: parseEngineEvent (shared-types)                │
│ - approval-requested ──► mapApprovalRequested           │
│ - approval-resolved  ──► mapApprovalResolved            │
└──────┬──────────────────────────────────────────┬───────┘
       │                                          │
       ▼                                          ▼
┌───────────────────────────────┐  ┌───────────────────────────────────┐
│ approvalStore.ts (Zustand)    │  │ outbox.ts (内存态: outboxState)    │
│ - pending: ApprovalItem[]     │  │ - items: OutboxItem[]             │
│ - decisionBusy: Record<string>│  │ - 状态: pending / sent / failed   │
│ - history: ApprovalRecord[]   │  │ - 退避: 1s -> 4s -> 16s -> 60s    │
│ - outboxCount: number         │  │ - confirmResolved 出队            │
└──────┬────────────────────────┘  └──────▲────────────────────────────┘
       │                                  │
       │ 状态订阅 (UI)                     │ enqueueApprovalDecision
       ▼                                  │
┌───────────────────────────────┐  ┌──────┴────────────────────────────┐
│ useApprovalListVm / DetailVm  │  │ approvalWiring.ts: flushOnce()    │
│ - useCountdownTick (1s tick)  │  │ - 单飞锁定: replayInflight        │
│ - markExpired 本地超时兜底      │  │ - collectReplayable (FIFO)        │
│ - 防双点 300ms (beginDecision) │  │ - WsGateway.invoke(remote.approve)│
└──────┬────────────────────────┘  └──────┬────────────────────────────┘
       │                                  │
       ▼                                  ▼
┌───────────────────────────────┐  ┌───────────────────────────────────┐
│ Screens & Presentation Blocks │  │ 桌面端 / 服务端 (Rust / WebSocket)  │
│ - ApprovalListScreen          │  │ - ws.rs: ⚠️ 未分发 remote.* (黑洞)│
│ - ApprovalDetailScreen        │  │ - router.rs: REST POST /v1/...    │
│ - ApprovalCard / ActionBar    │  │ - run_approval.rs: 引擎门禁校验   │
└───────────────────────────────┘  └───────────────────────────────────┘
```

---

## 一、审批状态转移与 Outbox 闭环审计

### 1. 审批状态转移全景与状态机矩阵

在移动端审批生命周期中，存在**三大独立且相互制约的状态轴**：
1. **条目业务状态**（`ApprovalItem.status`）：控制列表展示、倒计时以及用户操作权限；
2. **决策通道状态**（`ApprovalItem.decisionStatus`）：反映当前操作的网络执行状态；
3. **Outbox 队列状态**（`OutboxItem.status`）：控制离线与补发队列的单飞重放生命周期。

```
[approval-requested]
        │
        ▼
   ┌─────────┐   beginDecision()    ┌──────────┐   enqueue ok    ┌────────┐
   │ pending ├─────────────────────►│ deciding ├────────────────►│ queued │
   └────┬────┘                      └────┬─────┘                 └───┬────┘
        │                                │                           │
        │ 本地 120s 倒计时                │ 网络失败回滚               │ 远程执行成功
        │ now >= expiresAt               │ failDecision()            │ (markDecisionSent)
        ▼                                ▼                           ▼
   ┌─────────┐                      ┌──────────┐                 ┌─────────┐
   │ expired │                      │ pending  │                 │ [移出]  │
   └─────────┘                      │ (failed) │                 │ +history│
        ▲                           └──────────┘                 └─────────┘
        │ 冲突错误码 (409) / 双端并发
        │ markDecisionConflict()
   ┌────┴─────┐
   │ conflict │
   └──────────┘
```

#### 三轴状态联合矩阵表

| 业务状态 (`item.status`) | 通道状态 (`item.decisionStatus`) | Outbox 状态 (`outbox.status`) | 状态语义 | UI 表现与交互可用性 |
| :--- | :--- | :--- | :--- | :--- |
| `pending` | `idle` | *(未入队)* | 初始待批状态 | 正常展示卡片与倒计时；允许/拒绝按钮可用 |
| `deciding` | `sending` | *(入队瞬态)* | 点击开始，防抖加锁 | 按钮置忙（`busy=true`），展示“处理中…” |
| `queued` | `sending` | `pending` | 已入 Outbox，等待重放 | 展示“待发送 · 网络恢复后自动发送”，禁止重复决策 |
| `queued` | `sending` | `sent` | 命令已送达桌面，等待事件确认 | 仍展示待发送态，等待服务端 `approval-resolved` 事件 |
| `pending` | `failed` | `failed` | 决策发送失败，退避等待重试 | 卡片展示“决策未送达，将自动重试”，按钮可重新点击 |
| `conflict` | `failed` | *(已出队)* | 冲突/409/已被其他端处理 | 展示“状态可能已变化，点击查看”，无法再次决策 |
| `expired` | `failed` | *(已出队)* | 本地倒计时 120s 耗尽 | 条目置灰展示“已过期”，保留 24h，隐藏操作条 |
| *(已移出)* | *(已销毁)* | *(已出队)* | 最终完成态 | 从待办列表移除，追加写入 `history` 审计记录 |

- **关键源码引用**：
  - 终态判断与幂等：[`approvalReducers.ts:17-26`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/approvalReducers.ts#L17-L26)（终态集合：`approved`, `denied`, `expired`, `conflict`）；
  - 排序算法：[`approvalReducers.ts:36-71`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/approvalReducers.ts#L36-L71)（主键：`expiresAt` 剩余时间升序；次键：同 run 聚合相邻 + L2 危险级优先）；
  - 幂等流入：[`approvalReducers.ts:85-113`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/approvalReducers.ts#L85-L113)（同 `toolCallId` 覆盖但保留本地倒计时与发送通道状态，终态不被回退）。

---

### 2. 本地两阶段确认的 Outbox FIFO 单飞重放机制

- **代码位置**：[`outbox.ts:15-48`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L15-L48) 与 [`approvalWiring.ts:337-393`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L337-L393)

#### (1) 两阶段确认（Two-Phase Confirmation）执行闭环
Outbox 队列设计了三态模型：`pending` -> `sent` -> `confirmResolved`（出队）：
1. **阶段一：发送确认（Transport Acknowledgment）**
   - 用户触发允许/拒绝 -> [`enqueueApprovalDecision`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L504) 生成条目，初始为 `status: 'pending'`；
   - 单飞重放调度器取出可重放条目，调用 `WsGateway.invoke('remote.approve' / 'remote.deny')`；
   - 网关返回成功（收到对应 `result.approve` 且 `ok === true`）后：
     - 调用 [`markSent(outboxState, item.id, now)`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L186-L205)：条目迁移至 `sent` 状态；**在 sent 状态下，条目不参与后续重发**（`collectReplayable` 显式过滤掉 `sent`）；
     - 同步调用 [`approvalStore.getState().markDecisionSent(...)`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/approvalStore.ts#L117-L129)。
2. **阶段二：事实确认（Engine Event Confirmation）**
   - 桌面端引擎真正完成裁决并持久化事件后，通过 WebSocket 广播 `approval-resolved` 事件帧；
   - 移动端在 [`consumeEnvelope`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L310-L334) 接收到 `approval-resolved`：
     - 调用 [`confirmResolved(outboxState, toolCallId)`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L249-L257)：将匹配的 `toolCallId` 条目从 Outbox 彻底物理移除；
     - 调用 `approvalStore.getState().handleResolved(...)` 完成历史审计落库。

#### (2) FIFO 顺序与单飞重放（Single-Flight Replay）
- **FIFO 顺序性保证**：
  [`collectReplayable`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L162-L175) 扫描所有 `status === 'pending'` 或 (`status === 'failed' && nextRetryAtMs <= nowMs`) 的条目，严格执行按 `createdAtMs` 升序排序：
  ```typescript
  .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
  ```
  保证较早触发的审批决策必定先于后续决策投递。
- **单飞并发控制（Inflight Lock）**：
  - 在 [`approvalWiring.ts:340-356`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L340-L356)：
    ```typescript
    private async flushOnce(): Promise<void> {
      if (this.replayInflight) return;
      this.replayInflight = true;
      try {
        for (;;) {
          const batch = collectReplayable(outboxState, this.nowFn());
          if (batch.length === 0) break;
          for (const item of batch) {
            await this.sendOne(item);
          }
          syncOutboxCount();
        }
        this.scheduleBackoffRetry();
      } finally {
        this.replayInflight = false;
      }
    }
    ```
  - 当并发调用 `flush()` 时，由于 `replayInflight = true`，直接阻断重入；`for (;;)` 循环保证在单次飞行中消费完由于网络耗时期间新入队的增量条目，直至无可重放条目才释放锁。

---

### 3. 断线期间入队、重连补发与退避重试机制

- **代码位置**：[`outbox.ts:50-58`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L50-L58)、[`approvalWiring.ts:383-415`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L383-L415)

#### (1) 断线期间入队行为
- 当处于离线状态（`WsGateway` 的 `sendFn` 为空）时，调用 `enqueueApprovalDecision`：
  1. [`enqueueDecision`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L97-L156) 正常向内存列表追加 `status: 'pending'` 条目；
  2. 调用 `singleton?.flush()` -> `flushOnce()` -> `sendOne(item)`；
  3. `this.gateway.invoke` 立即检测到无连接，抛出 `GatewayError('transport.closed', ...)`；
  4. `sendOne` 捕获异常，调用 `recordFailure`，将条目置为 `status: 'failed'`，计算退避时间并登记 `nextRetryAtMs`；
  5. 审批中心标题栏角标显示当前未完成条数 `outboxCount`（`pending` 与 `failed` 均计入角标，`sent` 不计入）。

#### (2) 重连补发与全链路对账
- 当网络恢复，底层连接成功握手并接收到 `events.subscribe.ok` 信号时：
  [`ApprovalBridge.onSyncReady`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L304-L307) 被触发：
  ```typescript
  private onSyncReady(): void {
    void this.flushOnce();
    void this.reconcile();
  }
  ```
  - **立即补发**：`flushOnce()` 立即接管未送达的 Outbox 队列，无视退避时间直接触发重放；
  - **状态对账**：`reconcile()` 调用 `remote.listPendingApprovals`，执行双向往收敛：
    - 引擎有、本地无 -> 补入本地待办（`mapReconcileApprovalItem`）；
    - 本地有、引擎无 -> 若本地处于非 `deciding` 态，说明已被外部或桌面处理，从待办列表主动移除。

#### (3) 退避阶梯算法与人工介入
- 退避公式由 [`outboxBackoffMs(attempts)`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L53-L58) 定义：
  $$\text{Backoff}(N) = \begin{cases} 
  1\,000\text{ ms} & N \le 1 \\ 
  4\,000\text{ ms} & N = 2 \\ 
  16\,000\text{ ms} & N = 3 \\ 
  60\,000\text{ ms} & N \ge 4 
  \end{cases}$$
- **容量与转人工机制**：
  - `OUTBOX_MAX_ITEMS = 200`：队列上限 200 条；当队列满时，**仅淘汰最早已完成的 `sent` 条目；若全是未完成的 `pending`/`failed`，严格拒绝新条目（返回 `full`），绝不丢弃未决决策**；
  - `OUTBOX_MAX_ATTEMPTS = 5`：连续失败达到 5 次以上，[`needsHumanAttention`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L235-L237) 返回 `true`，但条目永不硬删除，由 `OUTBOX_TTL_MS = 24h` 兜底。

#### (4) 永久冲突错误码（PERMANENT_DECISION_ERROR_CODES）收敛
- **定义位置**：[`approvalWiring.ts:61-68`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L61-L68)
  ```typescript
  const PERMANENT_DECISION_ERROR_CODES: ReadonlySet<string> = new Set([
    'cmd.approval_mismatch',
    'cmd.not_found',
    'cmd.denied',
    'cmd.invalid',
    'approval.expired',
    'approval.rejected',
  ]);
  ```
- **处理逻辑**：
  当调用返回的错误码命中该集合时，证明服务端已不可能接受该命令（例如：已在桌面端裁决导致 409 `cmd.approval_mismatch`、目标 Run 已销毁、审批已超时 `approval.expired`）：
  - **立即出队**：调用 `confirmResolved(outboxState, item.toolCallId)`，终止任何退避与重试，防止死循环轰炸服务端；
  - **冲突标记**：调用 `approvalStore.getState().markDecisionConflict(item.toolCallId)`，将本地卡片置为 `status = 'conflict'`，提示“状态可能已变化，点击查看”。

---

### 4. 防双点 300ms 机制及审批卡片倒计时到期（Expired）逻辑

- **代码位置**：[`approvalReducers.ts:9-10, 121-153`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/approvalReducers.ts#L9-L10)、[`ApprovalActionBar.tsx:37-56`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/blocks/ApprovalActionBar.tsx#L37-L56)、[`useApprovalListVm.ts:70-79`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useApprovalListVm.ts#L70-L79)

#### (1) 防双点 300ms 机制架构
移动端建立了三级防双点纵深防御体系：
1. **UI 交互层**：
   [`ApprovalActionBar.tsx:42-56`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/blocks/ApprovalActionBar.tsx#L42-L56) 接收 `busy: boolean` 属性。当处于 busy 时，按钮置灰且点击回调直接 early return；拒绝确认弹窗强制自动关闭（`setConfirmOpen(false)`）；
2. **ViewModel 层**：
   [`useApprovalDetailVm.ts:85-87`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useApprovalDetailVm.ts#L85-L87) 校验 `decisionBusy[toolCallId]`，若处于 busy 立即返回 `{ ok: false, reason: 'busy' }`；
3. **领域 Store / Reducer 层（刚性时间锁）**：
   [`approvalReducers.ts:138-143`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/approvalReducers.ts#L138-L143) 执行绝对时间判定：
   ```typescript
   if (
     item.decisionSentAtMs !== undefined &&
     nowMs - item.decisionSentAtMs < DECISION_BUSY_MS // 300ms
   ) {
     return { items: items as ApprovalItem[], busy: { ...busy }, ok: false };
   }
   ```
   只有通过校验后，才将条目原子置为 `status: 'deciding'`, `decisionStatus: 'sending'`, `decisionBusy: true`，并将 `decisionBusy[toolCallId] = true` 装配入 Store。

#### (2) 倒计时到期（Expired）与本地兜底
- **到期时序设计**：
  桌面端引擎审批超时固定为 120 秒（`APPROVAL_TIMEOUT = 120s`）。然而，**桌面端引擎在超时后并不向外广播 `approval-resolved(expired)` 事件**（仅在后续收到决策时被动拒绝）。
- **客户端主动到期机制**：
  - 列表与详情 ViewModel 使用 [`useCountdownTick(1000)`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/hooks/useCountdownTick.ts) 维持本地秒级心跳（无待办时自动停表节能）；
  - 在 [`useApprovalListVm.ts:70-79`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useApprovalListVm.ts#L70-L79)：
    ```typescript
    useEffect(() => {
      for (const item of pending) {
        if (
          (item.status === 'pending' || item.status === 'deciding') &&
          now >= item.expiresAt
        ) {
          approvalStore.getState().markExpired(item.request.toolCallId, now);
        }
      }
    }, [pending, now]);
    ```
  - 当本地时钟推进越过 `expiresAt` 时，触发 [`expireApproval`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/approvalReducers.ts#L261-L291)：
    - 条目置为 `status = 'expired'`，`decisionStatus = 'failed'`；
    - **不会立即移出列表**，而是置灰保留在待办列表中（`FINISHED_RETENTION_MS = 24h`），供用户直观获知审批结果；
    - 自动生成一条 `channel: 'auto'`, `decision: 'expired'` 的审计记录追加写入 `history`；
    - 用户可通过 [`dismissExpired`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/approvalStore.ts#L168-L173) 手动清理已过期条目。

---

## 二、协议对齐度分析

针对用户指令中要求的三个核心远程命令（`remote.approve`, `remote.deny`, `remote.listPendingApprovals`），我们在移动端与桌面端（Rust 内核）之间进行了全字段比对：

### 1. 跨端命令契约矩阵

| 命令标识 (Kind) | 协议命令名 (Command) | 桌面端实现体 (Rust / Tauri) | 契约参数接口 (`paramsType`) | 契约响应接口 (`resultType`) | 写命令 / Outbox | 桌面端注册状态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `remote.approve` | `approve` | `core_approve_tool` / `ApiBackend::approve` | `ApproveParams` | `ApproveResult` | 是 / 是 (`toolCallId+msgId`) | ✅ 已注册 |
| `remote.deny` | `deny` | `core_deny_tool` / `ApiBackend::deny` | `DenyParams` | `ApproveResult` | 是 / 是 (`toolCallId+msgId`) | ✅ 已注册 |
| `remote.listPendingApprovals` | `listPendingApprovals` | `mobile_list_pending_approvals` (未注) / `ApiBackend::list_pending_approvals` | `ListPendingApprovalsParams` | `ListPendingApprovalsResult` | 否 / 否 (`natural`) | ❌ **未注册 (registered: false)** |
| `remote.approvalHistory` | `approvalHistory` | `mobile_approval_sync_state` (未注) / `ApiBackend::approval_history` | `ApprovalHistoryParams` | `ApprovalHistoryResult` | 否 / 否 (`natural`) | ❌ **未注册 (registered: false)** |
| `remote.checkCommand` | `checkCommand` | `core_check_command` | `CheckCommandParams` | `CheckCommandResult` | 否 / 否 (`natural`) | ✅ 已注册 |

---

### 2. 数据结构字段逐项对齐审计

#### (1) `remote.approve`
- **移动端请求构造**：
  [`approvalWiring.ts:97-111`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L97-L111)
  ```json
  {
    "kind": "remote.approve",
    "body": {
      "command": "approve",
      "params": { "toolCallId": "tc-123", "runId": "run-456" }
    }
  }
  ```
- **桌面端 Rust 结构**：
  [`crates/conex-types/src/device/commands.rs:37-43`](file:///c:/Software/conex/crates/conex-types/src/device/commands.rs#L37-L43)
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct ApproveParams {
      pub tool_call_id: String,
      #[serde(skip_serializing_if = "Option::is_none")]
      pub run_id: Option<String>,
  }
  ```
- **返回结果体**：
  `ApproveResult`: `{ "ok": true, "toolCallId": "tc-123", "decision": "approved" }`。
- **对齐结论**：字段名、camelCase 映射完全对齐。协议消除了冗余的 `decision` 参数，杜绝传错决策可能。

#### (2) `remote.deny`
- **移动端请求构造**：
  [`approvalWiring.ts:114-129`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L114-L129)
  ```json
  {
    "kind": "remote.deny",
    "body": {
      "command": "deny",
      "params": { "toolCallId": "tc-123", "reason": "用户拒绝执行", "runId": "run-456" }
    }
  }
  ```
- **桌面端 Rust 结构**：
  [`crates/conex-types/src/device/commands.rs:45-53`](file:///c:/Software/conex/crates/conex-types/src/device/commands.rs#L45-L53)
  ```rust
  pub struct DenyParams {
      pub tool_call_id: String,
      #[serde(skip_serializing_if = "Option::is_none")]
      pub run_id: Option<String>,
      #[serde(skip_serializing_if = "Option::is_none")]
      pub reason: Option<String>,
  }
  ```
- **返回结果体**：与 approve 共用 `ApproveResult`，`decision: "denied"`。
- **对齐结论**：完全对齐。`reason` 字段缺省时桌面端自动回退至 `"user denied"`。

#### (3) `remote.listPendingApprovals`
- **移动端映射**：
  [`approvalWiring.ts:174-203`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L174-L203)
  消费 `PendingApproval` 列表：`requestId`, `toolCallId`, `toolName`, `summary`, `cwd`, `sessionId`, `runId`, `requesterRunId`, `reason`, `arbiter`, `requestedAt`, `expiresAt`, `dangerLevel`, `paramKeys`。
- **桌面端 Rust 构造**：
  [`apps/agent-workbench/src-tauri/src/run/run_approval.rs:539-576`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_approval.rs#L539-L576)
  `list_pending_approvals_impl` 提取 `active_runs` 下各审批门快照，全字段同构装配。
- **对齐结论**：数据结构规范完全一致，**但存在致命的传输通道断层（见下文）**。

---

### 3. 跨端传输通道的严重断层发现（重大发现）

> [!CAUTION]
> **发现一：桌面端 WebSocket 服务端的“远程命令黑洞”**  
> 移动端 `WsGateway.invoke` 通过 WebSocket 向桌面端发送 `remote.approve` / `remote.deny` / `remote.listPendingApprovals` 帧。  
> 审计桌面端 [`apps/agent-workbench/src-tauri/src/server/ws.rs:1133-1163`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs#L1133-L1163) 发现：  
> 服务端对入站帧仅匹配了 `PairHello`, `EventsSubscribe`, `EventsSubscribeAll`, `EventsResume`, `Heartbeat`, `EventsAck`, `Error`；  
> 对于所有 `MessageKind::Remote(...)` 命令帧，直接落入通配忽略分支：  
> ```rust
> _ => {
>     tracing::debug!(target: "ws", conn_id = ctx.conn_id, kind = %envelope.kind_str(), "R1-05 范围外 kind，忽略");
>     Action::Continue
> }
> ```
> **后果**：服务端默默丢弃帧，**从不回复任何 `result.*` 或 `error` 帧**！移动端 `invoke` 必将等待 10 秒并报 `cmd.timeout` 超时！

> [!WARNING]
> **发现二：C13 对账命令未在 Tauri 注册（`registered: false`）**  
> 在契约表 [`packages/shared-types/src/generated/device/commands.ts:24`](file:///c:/Software/conex/packages/shared-types/src/generated/device/commands.ts#L24) 中明确标明：  
> `mobile_list_pending_approvals` 的 `registered: false`。在 Tauri 的 `command_manifest.rs` 中全无该命令的注册。  
> 这导致对账命令在桌面端目前只能通过 HTTP REST `GET /v1/approvals/pending` 调用，无法通过 WS 网关调用。

> [!NOTE]
> **发现三：REST 端点可用但移动端未接线**  
> 桌面端在 [`router.rs:151, 480-515`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/router.rs#L151-L515) 中其实已经完整实现了 `POST /v1/approval/{toolCallId}/approve`、`POST /v1/approval/{toolCallId}/deny` 以及 `GET /v1/approvals/pending` 的 HTTP REST 路由；  
> 但移动端 `approvalWiring.ts` 完全绑定于 `WsGateway.invoke`，并未实现 HTTP 降级回退通道。

---

## 三、重复与死层

### 1. `SqlApprovalQueueDao` 完整实现却零调用（持久化死层）
- **代码事实**：
  [`apps/crish-mobile/src/db/dao/approvalQueueDao.ts`](file:///c:/Software/conex/apps/crish-mobile/src/db/dao/approvalQueueDao.ts) 拥有超过 210 行高质量代码，完整实现了基于 SQLite 的 `ApprovalQueueDao`（`upsert`, `findById`, `listReplayable`, `update`, `deleteByToolCallId`, `deleteSentOlderThan` 等），且测试套件完整；
- **死层证据**：
  但在 [`approvalWiring.ts:72`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L72)，代码写明：
  ```typescript
  // 职责边界：...持久化（D6 §6.6 硬底线）属 db 域后续轮次，本层为内存态占位。
  let outboxState: OutboxState = createOutboxState();
  ```
  在全局搜索 `SqlApprovalQueueDao`，发现除了 DAO 本身和 DAO 单元测试外，**在整个项目中无一处业务代码实例化或调用了该 DAO**！
- **危害**：持久化承诺未兑现，SQLite 数据表形同虚设，Outbox 纯靠内存维系。

### 2. `outboxState.replaying` 状态孤立（死状态位）
- **代码事实**：
  [`outbox.ts:43, 178-183`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L43-L183) 定义了 `OutboxState.replaying` 字段及更新纯函数 `setReplaying`；
- **死状态证据**：
  但在 [`approvalWiring.ts:222, 340-356`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L222-L356)，重放并发控制完全由类内部私有属性 `private replayInflight = false;` 独立维护，**从未调用过 `setReplaying` 更新 `outboxState`**。`outboxState.replaying` 始终恒为 `false`，属于未贯通的死状态字段。

### 3. 命令构造函数的双源重复实现
- **代码事实**：
  - 源 A：[`src/domain/repositories/approvalCommands.ts:101-129`](file:///c:/Software/conex/apps/crish-mobile/src/domain/repositories/approvalCommands.ts#L101-L129) 严格依据契约实现了 `buildApproveRequest`、`buildDenyRequest`、`buildListPendingApprovalsRequest`；
  - 源 B：[`src/adapters/wiring/approvalWiring.ts:97-141`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L97-L141) **又手写了一套一模一样的构造函数**。
- **危害**：违反 DRY 原则，增加了维护时的漂移风险。

### 4. ViewModel 层的历史兼容导出垫片
- **代码事实**：
  [`src/adapters/viewmodels/useApprovalDetailVm.ts:18-25`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useApprovalDetailVm.ts#L18-L25) 导出了本属于 wiring 层的 `approvalOutboxCount`, `enqueueApprovalDecision`, `resetApprovalOutboxForTest`。
- **架构异味**：注释声明这是“兼容出口”。ViewModel 作为表现适配层，反向重导出底层 Wiring 层的控制方法，模糊了层级边界。

### 5. `SqlApprovalHistoryDao` 与 Store 内存 History 的断裂
- **代码事实**：
  与 Outbox 类似，`apps/crish-mobile/src/db/dao/approvalHistoryDao.ts` 实现了完整的本地 SQLite 历史持久化表；但在 `approvalStore.ts` 中，`history` 仅是一个最大 500 条的内存数组（`s.history = appendHistory(s.history, result.record)`），完全没有触发 SQLite 写入与冷启动读取。

### 6. `decisionBusy` 双轨状态字段冗余
- **代码事实**：
  - 轨 1：`approvalStore.decisionBusy: Record<string, boolean>`（全局 Map）；
  - 轨 2：`approvalStore.pending[i].decisionBusy: boolean`（条目内属性）。
- **同步裂缝**：在 `approvalStore.ts:175-183` 的 `markQueued` 动作中，更新了 `p.decisionBusy = true`，却遗漏了同步写入 `s.decisionBusy[toolCallId] = true`，导致双轨状态出现潜在不同步。

---

## 四、健壮性隐患

### 1. 进程回收与离线决策永久丢失隐患（Zero Durability Pitfall）
- **严重级别**：🔥 **致命隐患（Critical）**
- **代码位置**：[`approvalWiring.ts:72`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L72)
- **机理分析**：
  移动端处于弱网/离线环境是高频常态。用户在断线时点击了允许/拒绝，决策进入内存态 `outboxState`。
  当用户将应用切至后台，移动操作系统（iOS / Android）极易因为内存压力将后台宿主进程杀死（Process Termination）。
  由于 `outboxState` 未与 `SqlApprovalQueueDao` 挂接，**内存中的待发决策将随进程销毁而彻底消失**。用户再次打开应用时，不仅决策未发送，且已因本地时间越过 120 秒而被误判为 `expired`，导致核心功能承诺失效。

---

### 2. 批量重发中的串行超时雪崩与重放单飞锁死（Batch Timeout Stalling）
- **严重级别**：🚨 **高危缺陷（High）**
- **代码位置**：[`approvalWiring.ts:347-353, 362-392`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L347-L392)
- **机理分析**：
  在 `flushOnce` 中，对于拉取出的批量条目执行串行 `await this.sendOne(item)`：
  ```typescript
  for (const item of batch) {
    await this.sendOne(item);
  }
  ```
  如果服务端因为前述“远程命令黑洞”不回包，每个条目将经历完整的 10 秒超时（`DEFAULT_INVOKE_TIMEOUT_MS = 10s`）。
  假设队列中有 5 个待发条目，单次循环将阻塞长达 **50 秒**！
  在此 50 秒期间：
  1. `this.replayInflight = true`，锁死整个重放调度器；
  2. 哪怕在此期间网络完全恢复、或者用户新提交了极度紧急的审批，新的 `flush()` 也会被直接忽略，造成严重的操作拥堵与界面挂死假象。

---

### 3. 单一退避定时器覆盖与重试饥饿风险（Timer Coalescing Stalling）
- **严重级别**：⚠️ **中高危隐患（Medium-High）**
- **代码位置**：[`approvalWiring.ts:396-415`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L396-L415)
- **机理分析**：
  `scheduleBackoffRetry()` 使用了单实例保护：
  ```typescript
  if (this.retryTimer !== null) return;
  ```
  **时序破坏场景**：
  1. 条目 A 经历第 4 次失败，其计算出的退避等待时间为 60 秒。`scheduleBackoffRetry` 启动了一个 60 秒的 `retryTimer`；
  2. 2 秒后，新入队的条目 B 首次发送失败（第 1 次失败），其期望在 1 秒后重试（`attempts=1 -> 1s`）；
  3. 此时再次调用 `scheduleBackoffRetry()`，由于 `this.retryTimer !== null`，**被直接 return 忽略**；
  4. 结果：本应在 1 秒后重试的条目 B，被硬生生拖延了近 58 秒，直到条目 A 的定时器触发时才被顺带唤醒。

---

### 4. 两阶段确认过早移除引发的状态割裂（Premature Pending Removal）
- **严重级别**：⚠️ **中危隐患（Medium）**
- **代码位置**：[`approvalWiring.ts:371-374`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L371-L374)
- **机理分析**：
  在 `sendOne` 收到 `gateway.invoke` 成功回执时，立即调用了：
  ```typescript
  approvalStore.getState().markDecisionSent(item.toolCallId, item.decision, now);
  ```
  该操作立即从 `approvalStore.pending` 删除了条目并归入历史。
  但是，**命令回执成功仅代表桌面端服务接收了指令，并不代表工具实际执行完毕并生成了终态事件**。
  如果桌面端在刚收到指令后突然崩溃，或者后续底层执行器由于并发冲突返回了错误，此时移动端 UI 已经显示“已允许/已处理”，无法再撤回；如果之后网络重连对账，该请求若被桌面判定失败，移动端界面将出现永久的状态分裂。

---

### 5. 跨端时钟不同步导致的伪过期（Clock Drift & Fake Expiry）
- **严重级别**：⚠️ **中危隐患（Medium）**
- **代码位置**：[`approvalWiring.ts:193-194`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L193-L194) 与 [`useApprovalListVm.ts:74`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useApprovalListVm.ts#L74)
- **机理分析**：
  在对账时，条目的到期时间取自引擎：`expiresAt = pa.expiresAt`。
  而本地 ViewModel 判断过期使用的是移动端设备的本地物理时钟：`now = Date.now()`。
  如果移动端手机的时钟与桌面端主机时钟存在 30~60 秒的偏差（如手机时间偏快）：
  对账拉下来的待审批条目，在本地可能被立即判定为 `now >= item.expiresAt`，**导致本应还剩 1 分钟有效期的审批条目在手机端瞬间置灰变成 expired**。

---

### 6. 排队中条目（Queued）的倒计时到期盲区
- **严重级别**：⚠️ **中危隐患（Medium）**
- **代码位置**：[`useApprovalListVm.ts:72-74`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useApprovalListVm.ts#L72-L74)
- **机理分析**：
  在 `useApprovalListVm` 中，倒计时到期判断仅涵盖两态：
  ```typescript
  if ((item.status === 'pending' || item.status === 'deciding') && now >= item.expiresAt)
  ```
  当条目已进入 Outbox 等待发送时，其状态为 `item.status = 'queued'`。
  如果移动端离线长达数小时，该条目的 `status` 永远保持在 `queued`，卡片一直显示“待发送 · 网络恢复后自动发送”，倒计时减至 `0:00` 却不置灰。用户误以为网络恢复后依然有效，然而在网络恢复发送时必然遭遇桌面端 409 或 expired 拒绝。

---

## 五、复兴与演进建议

1. **贯通 Outbox SQLite 持久化（消除死层与零持久化隐患）**：
   - 将 `approvalWiring.ts` 中的纯内存 `outboxState` 与已写好的 `SqlApprovalQueueDao` 全面打通；
   - 在 `enqueueDecision`, `markSent`, `recordFailure`, `confirmResolved` 时同步落盘；
   - 在应用冷启动与 `ensureApprovalWiring` 时，调用 `hydrateOutbox(await dao.listAll(), now)` 实现真正的抗崩溃恢复扫描。
2. **修复桌面端 WebSocket 远程命令路由（根治远程命令黑洞）**：
   - 补全 `apps/agent-workbench/src-tauri/src/server/ws.rs` 中的 `MessageKind::Remote(...)` 分支，将其与 `ApiBackend` 真实直调方法（`approve`, `deny`, `list_pending_approvals`）对接，并下发 `result.*` 回执帧；
   - 在 `command_manifest.rs` 中补齐 `mobile_list_pending_approvals` 的登记。
3. **消除代码重复与边界清理**：
   - 统一使用 `approvalCommands.ts` 中的命令构造函数，移除 `approvalWiring.ts` 中的重复手写代码；
   - 清理 `useApprovalDetailVm.ts` 中对 wiring 层方法的非必要二次重导出。
4. **重构重试调度与防饥饿机制**：
   - 重构 `scheduleBackoffRetry`：当有更早的 `nextRetryAtMs` 产生时，取消现有定时器并重新设定更近的定时器，杜绝重试饥饿。
5. **统一倒计时到期语义**：
   - 在倒计时到期逻辑中纳入对 `queued` 态的处理，当超过绝对 TTL 或超时时给予准确的界面预警反馈。
