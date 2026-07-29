# Run 控制语义（L0–L3）

| Field | Value |
|-------|-------|
| Status | B0 骨架 + A1 契约 |
| 协议真源 | `packages/shared-types/src/run-control.ts` |
| 运行时队列 | `packages/agent-runtime/src/control/`（ControlBus） |
| 中控 | [`docs/plans/2026-07-system-architecture-control-master-plan.md`](../plans/2026-07-system-architecture-control-master-plan.md) §5 |

---

## 1. L0–L3 一览

| 级别 | wire 名（协议） | 谁发起 | 效果 | AI 是否继续 | 是否 abort provider |
|------|-----------------|--------|------|-------------|---------------------|
| **L0** | `continue` | AI / loop | 进入下一 turn | 是 | 否 |
| **L1** | `soft_inject` | 用户 / steer | 安全点注入消息，**不杀**当前 stream | **是** | 否 |
| **L2** | `cooperative_stop` | 用户 Stop / AI 策略 / hook | 当前 turn 正常收尾，干净停止 | 否 | **否** |
| **L3** | `force_cancel` | 用户 Force / 系统 | 硬停：abort provider + tools | 否 | **是** |

固定映射（禁止私自改 wire 字面量）：

```
L0 → continue
L1 → soft_inject
L2 → cooperative_stop
L3 → force_cancel
```

运行时扩展：`steer` / `follow_up` 与 `soft_inject` 同属 L1，投影到协议时折叠为 `soft_inject`；**入队环不同**（见 §1.1）。

### 1.1 AgentInputQueue 三环（对齐 pi steer / followUp）

参考 [pi agent](../../reference/pi/packages/agent) CHANGELOG #403 与 `agent-loop.ts`：

| 环 | API | 何时 drain | 对齐 pi |
|----|-----|------------|---------|
| **force** | `enqueue` / 默认 | streaming 中途可打断 | （Conex legacy；pi 无对等 mid-stream 打断） |
| **steer** | `enqueueSteer` / `enqueueSoft` / control `soft_inject`·`steer` | 安全点：provider 消费结束 / tool 批后（`hasRunnablePending`） | `agent.steer()` — 当前 tool 批后注入，可续 turn |
| **followUp** | `enqueueFollowUp` / control `follow_up` | 仅 run 本将 idle（无 tool、无 force/steer）时 `promoteFollowUp` | `agent.followUp()` — 无更多 tool/steering 后才注入 |

ControlBus `drainAsAction` 优先级不变：

```
force_cancel (L3) > cooperative_stop (L2) > L1 inject（分 steerMessages / followUpMessages）
```

session-loop 安全点：

- **after stream / after tools**：`checkControlAtSafePoint` 写入对应环；仅 `hasRunnablePending`（force/steer）立即续跑。
- **turn-complete 且 toolCallCount===0**：`promoteFollowUp` 后 `INPUT_AVAILABLE`（否则 `SHOULD_STOP`）。

---

## 2. 产品原则（摘要）

1. **默认用户 Stop = L2**；长按或二次确认 = L3。
2. **AI 自主停** = end_turn + 无 tool / 无 pending + hook `shouldStopAfterTurn` → L2。
3. **禁止**用 L3 表达「模型觉得差不多了」。
4. **maxTurns** 目标：先 L2 / budget 事件 + 可选续跑，而非静默硬杀（产品可配 hard ceiling）。
5. 参考 jcode soft interrupt：仅在 **provider 空闲安全点** 注入 L1。
6. 参考 **pi**：mid-run 改向用 **steer**；等本轮跑完再补一句用 **followUp**（勿把 followUp 当 force）。

---

## 3. 与 Abort 的区别

| | Abort / `AbortSignal` | Run Control（L0–L3） |
|--|----------------------|----------------------|
| **粒度** | 单一硬中断通道 | 四级意图，可观测、可测 |
| **L2 协作停** | 通常做不到「收尾再停」 | turn 干净结束，保留结果 |
| **L1 注入** | cancel 后再发 = 新 run 或丢流 | 队列消息，不杀当前 stream |
| **可观测** | 多为本地 signal | ControlIntent 一等事件（可写 event log） |
| **适用** | 底层取消 token（L3 会用到） | 产品/策略控制面 |

**结论**：

- **Abort 是机制**（取消 in-flight IO）。
- **L0–L3 是产品语义**。只有 **L3** 应触发 provider/tools abort；L2 走协作收尾；L1 只入队。
- 禁止用「一律 AbortController.abort()」实现 UI Stop——那会把所有停都变成 L3，导致丢结果、工具打断、日志误导。

ControlBus 在 session-loop **安全点** `drainAsAction()`，聚合优先级见 §1.1。`continue`（L0）不入队。

---

## 4. 类型分层（防漂移）

| 层 | 类型 | 说明 |
|----|------|------|
| shared-types | `RunControlLevel`（wire）、`RunControlLevelCode`（L0–L3）、`RunControlIntent`（协议载荷） | 跨包契约 |
| agent-runtime control | `RunControlKind`、`RunControlIntent`（带 id/kind/message）、`ControlBus` | 进程内队列；`level` 使用 L0–L3 代号 |
| 适配 | `levelForKind` / `wireLevelForKind` / `toProtocolRunControlIntent` | 运行时 ↔ 协议 |

runtime 的 control 模块 **re-export** shared-types，避免第二套 wire 名定义。

---

## 5. Desktop 出站门面（禁止第三路径）

| 表面 | UI handler | Wire 出站 |
|------|------------|-----------|
| 主对话 | `handleStopGeneration` / `handleForceCancelGeneration` | `safeCancelStream` → `createStreamCancel` → `compositionRoot.runControl.dispatch` |
| 子 Agent 面板 | `handleStop` / `handleForceStop` | live：`StreamCancelFn`（同 createStreamCancel）；无句柄：`requestAgentRunStop` → `compositionRoot.runControl.cooperativeStop` / `forceCancel` |
| 运行中再发 | composer queue / slash follow_up | `compositionRoot.runControl.followUp`（L1，不 cancel） |

- mode 字面量真源：`apps/crish-desktop/src/api/runControlClient.ts` → `StreamCancelMode`
- 实现细节：`runControlClient.dispatchRunControl` → L2/L3 经 **`sendTerminateDualWire`**（唯一双线配对点）
- **禁止** UI 直发 `{ type: 'cancel-run' }` 绕过 compositionRoot / runControlClient
- **禁止** agent stop 同时调用 StreamCancelFn **与** fallback（同 run 只出站一次）

### 5.1 TRANSITIONAL dual wire（inventory #4）

Canonical 协议帧：`{ type: 'run-control', level: cooperative_stop|force_cancel, ... }`。

在 daemon cooperative L2 全量验收前，L2/L3 仍由 `sendTerminateDualWire` **成对**附带：

```
run-control (level)  →  cancel-run { runId, mode: cooperative|force }
```

| 常量 | 默认 | 含义 |
|------|------|------|
| `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` | `true` | 关则仅发 `run-control`（须 E0 live Stop 证明） |

- metrics 仍按 **一次** L2/L3 计数（不把 cancel-run 当第二条真相）
- L1 follow_up / soft_inject **永不**附 cancel-run
- 删除 dual 条件：daemon L2 产品化 + E0 live Stop；见 `docs/plans/progress/architecture-dedup-inventory.md` #4

## 6. 相关文档

- Hook 与 L2 stop 建议：[`docs/hooks.md`](../hooks.md)
- 会话 / 消息身份：`packages/shared-types/src/session-identity.ts`、`message-identity.ts`
- 中控 Round：A1（类型）· B0（骨架）· B1（UI/daemon Stop）

---

## 7. Desktop 控制面 metrics（D2 lite）

进程内内存计数，**无** OpenTelemetry / 外部 APM。真源：

| 模块 | 路径 |
|------|------|
| 计数器 | `apps/crish-desktop/src/api/controlMetrics.ts` |
| 空壳 dev assert | `apps/crish-desktop/src/dev/emptyShellAssert.ts` |
| 静默完成检测 | `apps/crish-desktop/src/api/silentComplete.ts`（UserView；`onComplete` 接线） |

| 信号 | 含义 | 接线 |
|------|------|------|
| `run_control_L1/L2/L3` | soft_inject / cooperative_stop / force_cancel | `runControlClient.dispatchRunControl` |
| `draft_enter` | 进入 PENDING_DRAFT | `sessionCrudActions.enterDraftMode` |
| `draft_commit` | 草稿 materialize 成真会话 | `sessionCrudActions.commitDraftIfNeeded` |
| `message_upsert` | 消息按 id upsert | `sessionSharedHelpers.upsertMessageById` |
| `hydrate_prune` | list/hydrate 剪掉的空壳数 | `prepareSessionsForUi` |
| `shell_empty_assert` | dev 残壳 / I-DRAFT 脏入 | `runEmptyShellAssert`（`setSessions` 后） |
| `silent_complete` | run 完成但 UserView 无可见正文/工具 | `checkAndAlertSilentComplete`（`useStreamCallbacks` onComplete） |

API：`record(key)` / `getSnapshot()` / `reset()`（亦有 `incControlMetric` / `getControlMetrics` / `resetControlMetrics`）。

**刻意未做**：traceId e2e、health 面板 UI、外部 exporter（中控 D2-3/D2-6 仍 partial）。
