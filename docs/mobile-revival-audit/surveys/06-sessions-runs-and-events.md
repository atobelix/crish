# 专项审计报告 06：会话状态与事件流消费 (sessions-runs-and-events)

> **审计基准**：`apps/crish-mobile`（Expo SDK 57 / RN 0.86 / React 19.2.3）
> **调查员**：会话状态与事件流消费调查员
> **产出时间**：2026-09-04
> **审计范围**：
> - `apps/crish-mobile/src/domain/store/sessionStore.ts`, `sessionReducers.ts`
> - `apps/crish-mobile/src/domain/store/eventStore.ts`, `eventReducers.ts`
> - `apps/crish-mobile/src/domain/store/eventMappers.ts`
> - `packages/shared-utils/src/event-ring-window.ts`, `event-envelope.ts`, `event-filter.ts`
> - `apps/crish-mobile/src/presentation/screens/sessionDetailScreen.tsx`
> - `apps/crish-mobile/src/presentation/screens/sessionsScreen.tsx`
> - `apps/crish-mobile/src/presentation/screens/runDetailScreen.tsx`
> - `apps/crish-mobile/src/presentation/components/blocks/EventFeed.tsx`, `EventRow.tsx`, `StreamingText.tsx`
> - `apps/crish-mobile/src/presentation/components/sessions/SessionRow.tsx`
> - `apps/crish-mobile/src/presentation/components/runDetail/RunDetailTimeline.tsx`, `runDetailMeta.ts`
> - `apps/crish-mobile/src/adapters/wiring/feedBridge.ts`, `ingestRouter.ts`

---

## 模块架构全景

```
                        [WebSocket Inbound: WsGateway]
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
┌───────────────────────┐                           ┌───────────────────────┐
│  session.updated/All  │                           │      events.push      │
└───────────┬───────────┘                           └───────────┬───────────┘
            │                                                   │
            ▼                                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ eventMappers.ts                                                           │
│ - mapDeviceFrame (kind 路由)                                              │
│ - mapIngestFrame (ENGINE_EVENT_TYPES 动态驱动，57 类事件映射)               │
│ - timeline-truncate: parseEngineFrame 严格校验防污染                      │
│ - 产出 StoreIngestAction[] (feed-append / run-active / approval-delta...) │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ ingestRouter.ts -> dispatchIngestActions (唯一执行点)                     │
└───────────────┬───────────────────────────────────────────┬───────────────┘
                │                                           │
                ▼                                           ▼
┌───────────────────────────────┐           ┌───────────────────────────────┐
│ sessionStore.ts (Zustand)     │           │ eventStore.ts (Zustand)       │
│ - sessions: SessionSummary[]  │           │ - windows: Record<sessionId,  │
│   (isPinned -> 活动 -> 更新)  │           │             EventWindow>      │
│ - upsert / reconcile          │           │ - network: FeedNetwork        │
│ - applyRunActive / Approval   │           │ - ingest / hydrate / cursor   │
│ - ⚠️ applyLatestSeq (未接线!) │           │ - unloadWindow (LRU 无锁!)    │
└───────────────┬───────────────┘           └───────────────┬───────────────┘
                │                                           │
                │        ┌──────────────────────────────────┤
                │        │ (windows 顶层全量订阅 ⚠️)         │
                ▼        ▼                                  ▼
┌───────────────────────────────┐           ┌───────────────────────────────┐
│ sessionsScreen.tsx            │           │ sessionDetailScreen.tsx       │
│ - SessionRow (memo)           │           │ - EventFeed (FlatList 虚拟化) │
│ - 预览与流式指示器             │           │ - 40dp 吸底悬浮条恢复          │
│ - 状态徽标 / 未读红点 (永为0⚠️)│           │ - markRead 清零 (游标只升不降)│
└───────────────────────────────┘           └───────────────┬───────────────┘
                                                            │
                                                            ▼
                                            ┌───────────────────────────────┐
                                            │ runDetailScreen.tsx           │
                                            │ - entriesOfRun (全量遍历 ⚠️)  │
                                            │ - deriveRunStatus (五色收敛)  │
                                            │ - RunDetailTimeline (200/页)  │
                                            └───────────────────────────────┘
```

---

## 一、【49 类事件映射完整度】全量审查与契约断层

### 1.1 事件类型演进事实：49 类到 57 类的漂移现状

在早期架构演进（2026-08-11 D8 登记恢复域与 Goal 域）中，引擎事件从 41 类扩展为 49 类；而在随后的 D-03 契约窗口与统一输入流收敛战役（2026-08-14 ~ 2026-08-16）中，引擎事件经历了进一步迭代：
1. **删除**：`tool-input-repaired` 核销删除，`tool-update` 作为死契约删除；
2. **新增**：新增 9 项观测事件（`steering-evaluated`, `control-intent`, `hook-outcome`, `summary-background`, `stage-summary-milestone`, `nudge-enqueued`, `recovery-acknowledged`, `recovery-retry-attempted`, `provider-request-anchored`）及 1 项撤回域事件（`timeline-truncate`）；
3. **最终规模**：当前权威契约 `crates/conex-types/src/events.rs` 与 `packages/shared-types/src/generated/engine/events.ts` 锁定的事件类型总数为 **57 类**（`ENGINE_EVENT_TYPES`）。

移动端 `apps/crish-mobile/src/domain/store/eventMappers.ts:70-76` 采用了由生成面驱动的动态映射方案：
```typescript
export const EVENT_ROUTES: Readonly<Record<string, EventRoute>> =
  Object.fromEntries(
    ENGINE_EVENT_TYPES.map((type) => [
      type,
      SESSION_SIDE_ROUTES[type] ?? 'feed',
    ])
  ) as Record<string, EventRoute>;
```
- **架构韧性**：这一动态绑定使新增的事件类型（第 50~57 类）能自动入表并兜底分配为 `'feed'` 路由，避免了硬编码查表漏项导致的静态崩溃。
- **契约断层**：然而，生成面契约已扩展至 57 类，移动端展现层（`EventRow.tsx`、`summarizeEventFrame`）与测试注释中仍大量残留“49 类事件”口径，导致展现层人话翻译出现严重断层。

### 1.2 57 类事件路由与副作用映射全景矩阵

在 `eventMappers.ts` 中，事件被分为两层处理：
- **默认路由**：全部合法已知事件统一发射 `{ kind: 'feed-append' }` 追加至对应会话的环形窗口；
- **会话级副作用**：仅有 4 类事件定义在 `SESSION_SIDE_ROUTES` 中，触发会话索引维度的状态变更；
- **严格校验**：`timeline-truncate` 实施了严格结构校验。

| 序号 | 引擎事件类型 (`type`) | 路由动作 (`EventRoute`) | 副作用行为 (`StoreIngestAction`) | 展示层人话摘要支持 (`summarizeEventFrame`) | 错误级别判定 (`deriveErrorLevel`) |
|:---|:---|:---|:---|:---|:---|
| 1 | `agent-start` | `run-active` | `feed-append` + `run-active` (`active: true`) | ✅ 支持（显示 runId） | ❌ 否 |
| 2 | `agent-end` | `feed` | `feed-append` | ✅ 支持（显示 reason） | ❌ 否 |
| 3 | `turn-start` | `feed` | `feed-append` | ✅ 支持（第 N 轮开始） | ❌ 否 |
| 4 | `turn-end` | `feed` | `feed-append` | ✅ 支持（第 N 轮结束） | ❌ 否 |
| 5 | `message-start` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 6 | `message-delta` | `feed` | `feed-append` (`preview` 透传) | ✅ 支持（正文增量） | ❌ 否 |
| 7 | `message-end` | `feed` | `feed-append` | ✅ 支持（消息完成） | ❌ 否 |
| 8 | `tool-start` | `feed` | `feed-append` | ✅ 支持（工具名称） | ❌ 否 |
| 9 | `tool-end` | `feed` | `feed-append` | ✅ 支持（工具成功/失败） | ✅ `result.isError` 为 true |
| 10 | `tool-batch-start` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 11 | `tool-batch-end` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 12 | `context-compression-start`| `feed` | `feed-append` | ✅ 支持（显示 tokensBefore） | ❌ 否 |
| 13 | `context-compression-end` | `feed` | `feed-append` | ✅ 支持（压缩完成/失败） | ❌ 否 |
| 14 | `provider-diagnostic` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ **漏判**（错误诊断未标红） |
| 15 | `runtime-error` | `feed` | `feed-append` | ✅ 支持（错误内容截断） | ✅ 标红 (`true`) |
| 16 | `runtime-steering` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 17 | `runtime-intervention-required` | `feed` | `feed-append` | ✅ 支持（显示 reason） | ❌ 否 |
| 18 | `approval-requested` | `approval-plus` | `feed-append` + `approval-delta (+1)` | ✅ 支持（显示 toolName/summary） | ❌ 否 |
| 19 | `approval-resolved` | `approval-minus` | `feed-append` + `approval-delta (-1)` | ✅ 支持（显示 decision） | ❌ 否 |
| 20 | `checkpoint-created` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 21 | `checkpoint-restored` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 22 | `run-terminal` | `run-terminal` | `feed-append` + `run-terminal` (`active: false`) | ✅ 支持（terminal 三态） | ✅ `terminal === 'failed'` |
| 23 | `cache-stats-updated` | `feed` | `feed-append` | ✅ 支持（显示命中率） | ❌ 否 |
| 24 | `cache-waste-alert` | `feed` | `feed-append` | ✅ 支持（浪费 token 数） | ❌ 否 |
| 25 | `cold-cache-warning` | `feed` | `feed-append` | ✅ 支持（缓存过期警告） | ❌ 否 |
| 26 | `security-audit` | `feed` | `feed-append` | ✅ 支持（操作与决策） | ✅ `decision === 'blocked'` |
| 27 | `subagent-started` | `feed` | `feed-append` | ✅ 支持（任务描述） | ❌ 否 |
| 28 | `subagent-event` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 29 | `subagent-ended` | `feed` | `feed-append` | ✅ 支持（结束状态） | ❌ 否 |
| 30 | `task-started` | `feed` | `feed-append` | ✅ 支持（显示命令/摘要） | ❌ 否 |
| 31 | `task-output` | `feed` | `feed-append` | ✅ 支持（输出行/块） | ❌ 否 |
| 32 | `task-heartbeat` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 33 | `task-suspicious` | `feed` | `feed-append` | ✅ 支持（疑似卡死提示） | ❌ **漏判**（疑似卡死未标红） |
| 34 | `task-completed` | `feed` | `feed-append` | ✅ 支持（显示退出码） | ❌ 否 |
| 35 | `task-failed` | `feed` | `feed-append` | ✅ 支持（显示退出码） | ✅ 标红 (`true`) |
| 36 | `task-killed` | `feed` | `feed-append` | ✅ 支持（显示是否强制） | ❌ 否 |
| 37 | `timer-fired` | `feed` | `feed-append` | ✅ 支持（显示提示词） | ❌ 否 |
| 38 | `timer-cancelled` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 39 | `cron-fired` | `feed` | `feed-append` | ✅ 支持（显示触发次数） | ❌ 否 |
| 40 | `recovery-escalated` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 41 | `recovery-steering` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 42 | `recovery-fork` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 43 | `recovery-report` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 44 | `recovery-budget-denied` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 45 | `goal-round-started` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 46 | `goal-round-completed` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 47 | `goal-continuation-decided`| `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 48 | `steering-evaluated` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 49 | `control-intent` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 50 | `hook-outcome` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 51 | `summary-background` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 52 | `stage-summary-milestone` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 53 | `nudge-enqueued` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 54 | `recovery-acknowledged` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 55 | `recovery-retry-attempted` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 56 | `provider-request-anchored` | `feed` | `feed-append` | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |
| 57 | `timeline-truncate` | `feed` | `feed-append` (**需严格校验**) | ❌ **无专用文案**（走 default 兜底） | ❌ 否 |

### 1.3 核心契约亮点：timeline-truncate 严格守卫

在 `apps/crish-mobile/src/domain/store/eventMappers.ts:169-177`，针对 `timeline-truncate` 实施了独有的防御性门禁：
```typescript
if (frame.type === 'timeline-truncate' && parseEngineFrame(frame) === null) {
  return [
    {
      kind: 'ignore',
      reason:
        'timeline-truncate:parseEngineEvent strict-parse failed (malformed/unknown, lenient skip)',
    },
  ];
}
```
- **Rationale**：`timeline-truncate` 是会话撤回与分支回退的权威基准点，携带关键的 `boundarySeq` 与 `targetMessageId`。如果将畸形或不合规的撤回事件推入 feed，会导致客户端的重放基准崩溃。因此通过生成解析器 `parseEngineFrame` 强制实行“严格校验，畸形拒收（over-refuse）”策略，符合反退避铁律。

### 1.4 展现层人话摘要断层与死契约发现

1. **摘要与短标签大面积缺位**：
   - 57 类事件中，`summarizeEventFrame`（`EventRow.tsx:108-193`）仅覆盖了 30 类，**其余 27 类事件**在移动端时间线上均显示为生硬的 `事件 <type>`（例如 `事件 steering-evaluated`、`事件 timeline-truncate`）；
   - 短标签 `eventKindLabel`（`EventRow.tsx:50-93`）仅映射了 22 类，其余 35 类事件在前端显示为原始英文变体名；
   - 错误级别判定 `deriveErrorLevel` 遗漏了关键的 `task-suspicious`（任务卡死应作为告警态标黄/红）与 `provider-diagnostic`（服务商调用失败）。
2. **死契约遗留：`tool-update`**：
   - 在 Rust 后端（`crates/conex-types/src/device/events.rs:22-23`），早在 2026-08-16 的战役 R1 中已将 `tool-update` 从引擎变体中彻底核销删除（事件总数 58 -> 57）；
   - 但在移动端代码库中，`tool-update` 仍深度散落残留于：
     - `EventRow.tsx:36`（`TOOL_KIND_WHITELIST` 白名单）
     - `EventRow.tsx:62`（`eventKindLabel` 映射）
     - `EventRow.tsx:124-128`（`summarizeEventFrame` 解析）
     - `streamingTypes.ts:11`（`STREAMING_TYPES` 集合）
     - `terminalEvents.ts:2`（注释中仍声称收集 `tool-update`）
   - 这是典型的跨端演进遗留的死契约代码，需在后续阶段进行统一清退。

---

## 二、【状态机与未读逻辑】深入穿透

### 2.1 活动 Run 维护机制（activeRunIds）与冷启动状态盲区

#### A. 运行时动态维护链路
在运行时，活动 Run 的状态转移完全由 WebSocket 推送的实时事件驱动：
1. `agent-start` -> `eventMappers.ts` 产生 `{ kind: 'run-active', sessionId, runId }`；
2. `ingestRouter.ts` -> `sessionStore.getState().applyRunActive(sessionId, runId, true)`；
3. `sessionReducers.ts:173-181` 将 `runId` 压入 `item.activeRunIds`；
4. `run-terminal` -> 产生 `{ kind: 'run-terminal', sessionId, runId, terminal }` -> `applyRunActive(sessionId, runId, false)` 将其剔除。

#### B. 核心设计断层：断线重连与冷启动盲区
审查发现，在以下两个关键链路中，活动 Run 维护机制出现严重断层：
1. **续传与快照回放丢失副作用**：
   - 当设备断线重连或进行快照补齐时，网关返回 `events.resume.page`；
   - 在 `eventMappers.ts:251-270` 中，`events.resume.page` 被单一映射为：
     `{ kind: 'feed-hydrate', sessionId, events: frames, cursor }`；
   - 在 `ingestRouter.ts:34-38` 中，`feed-hydrate` 仅调用了 `eventStore.getState().hydrate(...)`，**完全没有回放事件中的会话副作用**（不会提取其中的 `agent-start` 或 `run-terminal` 派发给 `sessionStore`）！
2. **服务端索引不包含运行态**：
   - 服务端返回的会话索引契约 `SessionIndexEntry`（`packages/shared-types/src/generated/device/types.ts:171-183`）仅包含：
     `id, title, folder, isPinned, isArchived, timestamp, updatedAt, messageCount, engineCursor, engineLastRunId, hydratedFromEngine`；
   - 服务端没有提供该会话当前是否处于执行态的字段，仅有最近一次执行的 `engineLastRunId`；
   - 在冷启动时，`sessionReducers.ts:26-38` 的 `createSessionSummary` 只能将 `activeRunIds` 默认初始化为 `[]`。
3. **严重后果**：
   - **冷启动失明**：若用户打开移动端时，桌面端正有一个 Run 在运行，移动端拉取的会话列表中该会话的 `activeRunIds` 为空，显示为“空闲”，且无法触发活动置顶；
   - **重连失步**：若离线期间发生了 `agent-start` 并通过 `events.resume.page` 补齐，会话列表依然显示“空闲”，直到下一个实时的 `run-terminal` 到达。

### 2.2 置顶排序不变量（sortSessions）审计

在 `apps/crish-mobile/src/domain/store/sessionReducers.ts:47-62`，会话列表排序遵循严格的四级收敛不变量：
```typescript
export function sortSessions(
  items: readonly SessionSummary[]
): SessionSummary[] {
  return [...items].sort((a, b) => {
    const aPin = a.isPinned === true ? 1 : 0;
    const bPin = b.isPinned === true ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    const aAct = isSessionActive(a) ? 1 : 0;
    const bAct = isSessionActive(b) ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    const at = a.updatedAt ?? 0;
    const bt = b.updatedAt ?? 0;
    if (at !== bt) return bt - at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
```

1. **排序四层不变量规则**：
   - **第 1 级（用户强置顶）**：`isPinned === true` 绝对置顶（桌面向移动端同步的 partition 语义）；
   - **第 2 级（活动态置顶）**：`isSessionActive(a)` 优先（定义为 `activeRunIds.length > 0 || pendingApprovalCount > 0`，有进行中任务或待审批的会话浮至顶层）；
   - **第 3 级（时间降序）**：按 `updatedAt` 时间戳降序排列；
   - **第 4 级（确定性保序）**：在上述条件完全相同时，以 `id` 字符串升序作为稳定兜底。
2. **触发时机闭环性**：
   - `upsertSessionItem`（新增/单条更新）、`reconcileSessions`（全量对账）、`applyRunActive`（Run 启动/结束）、`applyApprovalDelta`（审批增减）均在变更后显式调用了 `sortSessions`；
   - 不变量在状态转移中保持恒定收敛。
3. **注释与代码漂移**：
   - `sessionReducers.ts:8-9` 的字段定义中明确标注：`receivedAtMs: number; /** 本地附加：会话面消息到达时刻 ms（updatedAt 缺失时排序兜底） */`；
   - 但在 `sortSessions:57-58` 的实际代码中，直接使用了 `const at = a.updatedAt ?? 0;`，**完全未消费 `receivedAtMs` 字段**！若服务端下发的 `updatedAt` 异常为 `undefined`，该会话将直接沉底至 0 时间线，而不会使用本地接收时间兜底。

### 2.3 未读数模型（unreadCount / markRead）的重大虚假闭环

在领域模型设计中，`sessionReducers.ts` 规划了一套细致的未读计数模型（F5 §6.3）：
- `applyLatestSeq(item, latestSeq, latestIsAssistant)`：当最新 sequence 大于本地已读游标 `lastReadSequence` 且最新一条消息为**助手角色**时，派生未读差值 `unreadCount = latestSeq - item.lastReadSequence`；
- `markSessionRead(item, sequence)`：当用户进入详情页并滚动到底部时，`lastReadSequence` 前移，`unreadCount` 清零；且要求 `sequence` 只升不降。

#### 🚨 严重发现：生产链路接线完全断裂（死逻辑）
对整个移动端工程进行全局静态符号检索确认：
1. **调用者缺失**：除了以下 4 个文件外，**全仓没有任何生产代码调用 `applyLatestSeq`**：
   - `sessionsScreen.test.tsx`（单测中手动注入数据）
   - `sessionReducers.test.ts`（单测测试纯函数）
   - `sessionStore.test.ts`（单测测试 store 转发）
   - `sessionStore.ts`（提供接口定义）
2. **接线层遗漏**：
   - 在 `eventMappers.ts` 中，`message-end` 事件被归类为默认的 `'feed'` 路由，仅输出 `{ kind: 'feed-append' }`；
   - 映射表没有提取 `message-end` 中的 `sequence` 与 `message.role === 'assistant'`，也没有产出 `{ kind: 'session-unread-update' }` 或类似的 store 动作；
   - `feedBridge.ts` 与 `ingestRouter.ts` 中压根没有处理未读更新的链路！
3. **虚假闭环**：
   - 单元测试由于全部采用手工调用 `store.applyLatestSeq(sid, 10, true)`，测试用例表现为 100% 通过（PASS）；
   - 但在真机/模拟器运行时，**会话的 `unreadCount` 永远为 0**！会话列表项上的未读红点（`session-unread-badge`）永远不可能被点亮；
   - `sessionDetailScreen.tsx:81-85` 中的 `sessionStore.getState().markRead(...)` 实际上每次只是在为一个本来就是 0 的计数器执行“清零”操作！

### 2.4 Run 状态派生机（terminalEvents / runDetailMeta）

在 `runDetailScreen.tsx` 与终端回放中，Run 状态完全基于事件流纯函数派生：
1. **五色状态收敛**（`deriveRunBadge`）：
   - `failed` -> `error`（红色）
   - `completed` / `cancelled` -> `terminal`（绿色 / 淡灰）
   - `running` -> 若本地回执处于暂停则为 `paused`（橙色），否则为 `running`（蓝色）
   - 无事件 -> `unknown`（灰色）
2. **暂停态（paused）的特殊处理**：
   - 引擎端并未定义 `pause` / `resume` 对应的事件类型；
   - 移动端通过 `useRunControlVm.paused` 捕获 `cooperative_stop` 控制命令的成功回执，将其作为本地合成状态与事件流中的 `running` 组合，优雅地解决了协议层面缺失暂停事件的问题；
3. **跨窗口展平性能瓶颈**：
   - `runDetailScreen.tsx:59-62` 调用 `entriesOfRun(windows, runId)`；
   - 这一函数在 `terminalEvents.ts:21-34` 中遍历了 `windows` 下的所有会话的所有条目，在事件高频推送时构成了不容忽视的 CPU 瓶颈（见后文性能章节）。

---

## 三、【性能与渲染隐患】长连接与虚拟化剖析

### 3.1 内存占用预算与环形缓冲（FEED_RING_MAX & MAX_ACTIVE_WINDOWS）

移动端事件流内存管理采用了双层有界预算模型：
1. **窗口内条目有界**：`packages/shared-utils/src/event-ring-window.ts:21` 规定每个会话窗口的环形缓冲区上限为 `FEED_RING_MAX = 500` 条。超出 500 条时触发 `trimWindow`，丢弃最旧的事件并累加 `truncatedCount`；
2. **会话窗口数量有界**：`apps/crish-mobile/src/adapters/wiring/feedBridge.ts:29` 规定活跃会话窗口上限为 `MAX_ACTIVE_WINDOWS = 4`；
3. **理论内存预算**：
   $$\text{最大内存事件数} = 500 \times 4 = 2,000 \text{ 条}$$
   以每条 JSON 信封展开后平均占用 1~2 KB 估算，事件流运行期内存峰值稳定在 **2MB ~ 4MB** 之间，不存在因事件无限堆积导致移动端 V8/Hermes OOM 的风险。

### 3.2 严重性能风险：Delta 洪峰冲刷与环形缓冲区爆仓

尽管内存总量有界，但事件消费逻辑与底层流式协议之间存在严重的**语义不匹配**：
1. **递增 Sequence 机制**：
   - 在 Rust 后端（`crates/orchestrator/src/events.rs:53-61`），`[EventQueue]` 会为包含 `message-delta` 在内的每一个事件赋予全局单调递增的 `sequence`；
2. **移动端去重逻辑陷阱**：
   - 查看 `packages/shared-utils/src/event-ring-window.ts:61-74` 的 `appendFeed`：
     ```typescript
     const existing = window.entries.findIndex(
       (e) => readNumber(e, 'sequence') === seq
     );
     if (existing >= 0) {
       window.entries[existing] = { ...entry, ... }; // 同 seq 原地覆盖
       return 'replaced';
     }
     window.entries.push(entry); // 不同 seq 追加新行
     ```
   - 原地覆盖（`replaced`）**仅在 sequence 完全相同**时生效（原本设计用于 preview 帧被后续相同 sequence 的正式帧覆盖）；
   - 当引擎流式生成一段回复时，会连续发送几十甚至上百个 `message-delta`，**每一个 delta 都带有不同的 sequence**！
3. **带来的灾难性后果**：
   - **缓冲区被垃圾冲刷**：一次包含 300 个 token 的普通回复，就会产生数百条 `message-delta` 记录存入 `window.entries`；
   - **关键事件被挤出淘汰**：500 条的缓冲区在短时间内被填满，此前极为关键的会话上下文（如 `agent-start`、`tool-start`、`approval-requested`）被当作“旧事件”彻底从缓冲区头部 `splice` 丢弃；
   - **UI 呈现碎片灾难**：在 `EventFeed` 中，由于没有做 delta 文本拼装，用户的时间线界面将被密密麻麻的“正文增量：xxx”刷屏几十页，严重破坏移动端时间线的可读性与可用性。

### 3.3 LRU 窗口卸载致命缺陷：前台正视会话无锁保护

在 `apps/crish-mobile/src/adapters/wiring/feedBridge.ts:233-245`，实现了超过 4 个窗口时的自动淘汰逻辑：
```typescript
private unloadExcessWindows(): void {
  const activeCount = this.activity.size;
  if (activeCount <= this.maxWindows) return;
  const candidates = [...this.activity.entries()].sort((a, b) => a[1] - b[1]);
  const excess = activeCount - this.maxWindows;
  for (let i = 0; i < excess; i++) {
    const [sessionId] = candidates[i] ?? [];
    if (sessionId === undefined) break;
    eventStore.getState().unloadWindow(sessionId);
    this.activity.delete(sessionId);
  }
}
```
1. **活跃度判定单一**：`this.activity` 的时间戳仅在有该会话的数据帧到达时更新（`this.markActive(sessionId)`）；
2. **前台会话无保护（缺少锁）**：
   - `sessionStore` 中记录了用户当前选中的会话 `selectedSessionId`；
   - 但 `feedBridge` 卸载逻辑**完全没有感知 `selectedSessionId`**，也没有向 UI 层提供“保护当前窗口不被卸载”的机制；
3. **复现场景**：
   - 用户正在 `sessionDetailScreen` 中仔细阅读会话 A 的历史记录（会话 A 当前无新事件输入，时间戳停滞）；
   - 此时后台的会话 B、C、D、E 频繁收到后台任务或通知事件，时间戳被持续刷新；
   - `unloadExcessWindows` 触发，会话 A 被判定为“最久未活动”，其事件窗口被直接调用 `unloadWindow(sessionId)` 销毁；
   - 用户的手机屏幕瞬间变白/清空，直接退化为 `EMPTY_WINDOW`（0 条事件），造成极度恶劣的崩溃级用户体验！

### 3.4 长列表吸底（follow）与 40dp 悬浮恢复机制

在 `apps/crish-mobile/src/presentation/components/blocks/EventFeed.tsx:35-132` 与详情页中，吸底机制设计考究，但存在触控对抗细节：
1. **40dp 判定与状态翻转保护**：
   ```typescript
   export const AUTO_FOLLOW_THRESHOLD_DP = 40;
   const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
   const following = distanceFromEnd <= AUTO_FOLLOW_THRESHOLD_DP;
   if (following !== follow) onFollowChange?.(following);
   ```
   - 仅在布尔值翻转时通知父组件，避免了以 16ms（`scrollEventThrottle={16}`）触发的父组件状态更新风暴；
2. **双轨动画策略**：
   - 实时事件到达时自动吸底：`targetRef.current?.scrollToEnd({ animated: false })`（非动画无跳动，避免掉帧）；
   - 用户手动点击悬浮条恢复吸底：`listRef.current?.scrollToEnd({ animated: true })`（动画平滑归位）；
   - 悬浮条设置了 `hitSlop={dualHitSlop(36)}`，将触控热区补足至符合平台人机指南的 44/48dp；
3. **潜在交互冲突（手势对抗）**：
   - 当 `follow === true` 时，若用户正用手指向上拖拽列表试图查看历史，恰在此时新事件到达，`useEffect` 会强行执行 `scrollToEnd`，**打断用户的滑动触摸手势**。应结合 `onScrollBeginDrag` 在用户手指接触屏幕期间临时冻结吸底。

### 3.5 React 渲染性能与全量状态订阅风暴

审查 `presentation` 层发现多处高频重渲染隐患：
1. **`SessionsScreen` 顶层全量订阅 `windows`**：
   - `apps/crish-mobile/src/presentation/screens/sessionsScreen.tsx:31`：
     ```typescript
     const windows = useEventStore((s) => s.windows);
     ```
   - 整个会话列表页直接订阅了整个 `windows` 对象的引用；
   - 长连接下**任何会话**收到**任何一条事件**（甚至是一条毫秒级的 delta），`windows` 引用即改变，导致整个 `SessionsScreen` 重新执行 `render`；
   - 虽然单行 `SessionRow` 具有 `memo`，但仍需对列表所有 item 进行 props 浅比较，且重新计算所有行的 `lastPreviewOfWindow`；
2. **`runDetailScreen` 中的 O(N) 跨窗口遍历**：
   - `apps/crish-mobile/src/presentation/screens/runDetailScreen.tsx:54, 59` 同样订阅了 `windows`；
   - 每次有事件到达，`useMemo` 会重新触发 `entriesOfRun(windows, runId)`；
   - 该函数将遍历 4 个窗口共多达 2,000 条条目，进行字符串过滤并执行 `stableSortBySeq`（含数组拷贝与排序），在高频推送下将持续占用 JS 线程，导致界面掉帧卡顿；
3. **`EventFeed` 内部的重复全量过滤**：
   - `EventFeed.tsx:73-85`：每次 `entries` 数组更新，均执行一次全量 `entries.filter` 统计 `errorCount`，随后再次执行 `filterFeed` 进行组合筛选，缺乏增量派生优化。

---

## 四、【重复与死层】代码治理清单

| 治理编号 | 涉及文件路径与行号 | 现象与本质 | 严重级别 | 治理方案与预期效果 |
|:---|:---|:---|:---|:---|
| **DEAD-01** | `apps/crish-mobile/src/domain/store/sessionReducers.ts:159`<br>`apps/crish-mobile/src/domain/store/sessionStore.ts:96` | **未读数计算逻辑全仓悬空**：`applyLatestSeq` 没有任何接线层调用，运行时未读红点永远不生效。 | 🔴 **严重断层** | 在 `eventMappers.ts` 中针对 `message-end`（角色为 assistant）派生未读更新动作，打通接线闭环。 |
| **DEAD-02** | `apps/crish-mobile/src/adapters/wiring/feedBridge.ts:233-245` | **LRU 卸载无保护**：`unloadExcessWindows` 未对当前前台查看的 `selectedSessionId` 加锁，导致后台事件挤压时前台内容被清空。 | 🔴 **严重隐患** | 卸载候选集过滤掉 `sessionStore.getState().selectedSessionId`，确保正视窗口永不被误删。 |
| **DEAD-03** | `apps/crish-mobile/src/domain/store/eventMappers.ts:251-270`<br>`apps/crish-mobile/src/adapters/wiring/ingestRouter.ts:34-38` | **续传快照副作用丢失**：`events.resume.page` 仅执行 `feed-hydrate`，丢失了恢复事件中的 `agent-start` 与 `run-terminal` 副作用，导致离线重连后活动状态无法同步。 | 🟠 **高危断层** | 在 `feed-hydrate` 执行时，或者在回放事件列表中提取生命周期事件，同步刷新 `sessionStore.activeRunIds`。 |
| **DEAD-04** | `apps/crish-mobile/src/presentation/components/blocks/EventRow.tsx:36,62,124`<br>`apps/crish-mobile/src/domain/pure/streamingTypes.ts:11` | **已删除死契约残留**：Rust 端已于 2026-08-16 战役 R1 中彻底删除 `tool-update`，移动端仍保留大量白名单与分支。 | 🟡 **中度死代码** | 彻底移除 `tool-update` 相关逻辑与白名单，避免契约漂移与混淆。 |
| **DEAD-05** | `apps/crish-mobile/src/domain/store/eventReducers.ts:15,26,34` | **跨根目录深度相对导入**：使用 `../../../../../packages/shared-utils/src/...` 穿透根目录，对 Metro 打包与路径解析构成严重脆弱性。 | 🟠 **构建隐患** | 改用 `@crish/shared-utils` monorepo 包名规范化导入。 |
| **DEAD-06** | `apps/crish-mobile/src/presentation/screens/sessionsScreen.tsx:31`<br>`apps/crish-mobile/src/presentation/screens/runDetailScreen.tsx:54` | **顶层全局全量订阅**：页面直接 `useEventStore((s) => s.windows)`，任何微小事件到达均引发跨页面全量重渲染。 | 🟠 **性能隐患** | 将预览信息提取与 Run 条目下沉至专用 selector 或细粒度 store，解耦顶层订阅。 |
| **DEAD-07** | `apps/crish-mobile/src/domain/store/sessionReducers.ts:8,57-58` | **注释与实现漂移**：声明 `receivedAtMs` 用于 `updatedAt` 缺失时兜底排序，代码实现直接使用 `updatedAt ?? 0`。 | 🟢 **轻度瑕疵** | 排序逻辑修正为 `const at = a.updatedAt ?? a.receivedAtMs;`，与文档断言完全闭合。 |
| **DEAD-08** | `apps/crish-mobile/src/presentation/screens/runDetailScreen.test.tsx` | **React 19 Act 告警泄露**：`useRunControlVm` 异步状态未包裹 `act(...)`，测试套件抛出多处控制台红字告警。 | 🟢 **测试规范** | 测试用例中对触发异步控制动作的调用补齐 `act(async () => ...)`。 |

---

## 五、收敛改造建议与行动项（供阶段二汇总）

为了在阶段二与阶段三彻底根除上述断层与性能隐患，建议按以下四项逻辑单元制定收敛方案：

### 1. 接线层与未读模型彻底闭环 (Fix Unread & Reconcile)
- **事件映射增强**：在 `eventMappers.ts` 的 `SESSION_SIDE_ROUTES` 中为 `message-end` 建立专用副作用处理，当 `message.role === 'assistant'` 时发射 `{ kind: 'session-unread-delta', sessionId, sequence }`；
- **快照生命周期回放**：在 `events.resume.page` 到达时，检查帧列表中未收口的 `agent-start` 与已收口的 `run-terminal`，驱动 `sessionStore.applyRunActive` 保证离线恢复后运行态一致；
- **冷启动状态同步**：利用初始握手或查询返回的 `status.query`（包含 `activeRuns`）初始化 `sessionStore` 的运行态。

### 2. 前台会话与内存卸载守卫 (LRU Foreground Guard)
- **会话锁定机制**：在 `feedBridge.ts` 的 `unloadExcessWindows` 算法中，显式注入豁免条件：
  ```typescript
  const currentSelectedId = sessionStore.getState().selectedSessionId;
  const candidates = [...this.activity.entries()]
    .filter(([sid]) => sid !== currentSelectedId) // 锁定当前正视会话
    .sort((a, b) => a[1] - b[1]);
  ```
  彻底杜绝用户正在查看的详情页被后台事件挤压清空的恶性 Bug。

### 3. Delta 事件折叠与环形缓冲区保护 (Streaming Delta Fold)
- **会话内增量聚合**：在 `appendFeed` 处理流式增量（`message-delta`、`task-output`）时，不应为每个递增 sequence 创建独立条目。应以 `messageId` 或同一轮次为聚拢键，将增量合并到当前进行中的活跃消息条目内；
- **保护生命周期事件**：防止环形缓冲区被几百条无意义的 token 碎片冲刷，确保 500 条预算真实服务于全生命周期的 57 类关键决策节点。

### 4. 契约死代码清退与展示层补齐 (Cleanup & Localization)
- **清退 `tool-update`**：全仓核销移动端对已废弃契约 `tool-update` 的冗余处理；
- **补齐 27 类事件人话摘要**：为 `recovery-*`、`goal-*`、`timeline-truncate`、`provider-diagnostic` 等事件补充清晰的中文摘要，避免时间线上充斥原始英文类型；
- **路径规范化**：将 `eventReducers.ts` 中的 `../../../../../` 相对深路径规范化为 `@crish/shared-utils`。
