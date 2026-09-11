# 审批流程与工具执行管道重构方案

> 目标版本: Crish R2
> 关联审计: UI-FLOW-AUDIT-COMPLETE.md #106-115, #412-427
> 基础架构: 三独立 Store、SessionRuntimeRegistry、操作队列

---

## 目录

1. [审批流程机重构](#1-审批流程机重构)
2. [工具执行管道](#2-工具执行管道)
3. [乐观更新与回滚](#3-乐观更新与回滚)
4. [diff 管理](#4-diff-管理)
5. [工具调用 UI](#5-工具调用-ui)

---

## 1. 审批流程机重构

### 1.1 ApprovalFlowMachine 新状态机

消除 #412：引擎发送 `approval-requested` 后断连导致审批永久卡死。

```
                   +---> [approved] ---> [executing] ---> [completed]
                   |         ^
[idle] ---> [pending] ---+---> [denied]
                   |         +---> [timed_out]
                   |
                   +---> [disconnected]
                           |
                           +---> (reconnect) ---> [pending] (重新查询引擎)
                           +---> (超时)     ---> [auto_denied]
```

**状态定义：**

| 状态 | 含义 | 触发条件 |
|------|------|----------|
| `idle` | 无审批请求 | 初始态、审批完成/拒绝后 |
| `pending` | 等待用户审批 | 收到 `approval-requested` |
| `approved` | 用户已批准 | 用户点击允许 |
| `denied` | 用户已拒绝 | 用户点击拒绝 |
| `timed_out` | 审批超时 | `PENDING_TIMEOUT`（默认 60s）到达 |
| `disconnected` | WebSocket 断开 | `close`/`error` 事件 |
| `auto_denied` | 断连后超时自动拒绝 | `disconnected` 态下 `DISCONNECT_TIMEOUT`（默认 30s）到达 |
| `executing` | 引擎正在执行已批准的工具 | 收到 `tool-started` |
| `completed` | 工具执行完成 | 收到 `tool-end` |

### 1.2 审批超时策略

| 策略 | 默认值 | 行为 | 配置位置 |
|------|--------|------|----------|
| `auto_deny` | 60s | 到达超时自动拒绝，toast 通知 | `APPROVAL.PENDING_TIMEOUT_MS` |
| `auto_approve` | 不可用 | 仅白名单匹配时自动批准（已有） | — |
| `notify_user` | 30s | 用户未审批时 toast 提醒 | `APPROVAL.REMIND_INTERVAL_MS` |

超时计时器在以下事件重置：
- 用户与审批卡片交互（展开详情）
- 引擎发送 `approval-updated`（更新上下文）
- 审批进入 `disconnected` 态（暂停计时）

### 1.3 WebSocket close/error 状态清理

```typescript
// approvalFlowMachine.ts
onWebSocketClose = (pendingApprovals: ApprovalState[]) => {
  for (const approval of pendingApprovals) {
    if (approval.status === 'pending') {
      this.transition(approval.id, 'disconnected');
      // 启动断连超时计时器
      this.startDisconnectTimer(approval.id, DISCONNECT_TIMEOUT);
    }
  }
};

onWebSocketReconnect = async (pendingApprovals: ApprovalState[]) => {
  for (const approval of pendingApprovals) {
    if (approval.status === 'disconnected') {
      // 向引擎重新查询此审批的状态
      const result = await client.queryApproval(approval.id);
      if (result.status === 'still_pending') {
        this.transition(approval.id, 'pending');
      } else {
        // 引擎端已有结果，同步
        this.transition(approval.id, result.status);
      }
    }
  }
};
```

### 1.4 审批状态持久化

审批状态写入 `sessionStore` 的 `session.approvals[]` 字段：

```typescript
interface PersistedApproval {
  id: string;
  toolCallId: string;
  status: 'pending' | 'approved' | 'denied' | 'timed_out' | 'disconnected';
  context: ApprovalContext;
  createdAt: number;
  updatedAt: number;
  sessionId: string;
}
```

持久化时机：
- 每次状态转换立即写入
- `beforeunload` 时 flush 所有未完成的审批
- 重启后从 `sessionStore` 恢复，对 `pending`/`disconnected` 状态的审批：
  - 如果距今超过 `MAX_PENDING_AGE_MS`（默认 300s），自动标记为 `timed_out`
  - 否则尝试向引擎重新查询

---

## 2. 工具执行管道

### 2.1 工具执行生命周期状态机

```
[queued] ---> [running] ---> [completed]
                 |               |
                 +---> [error]   +---> diff_发布
                 |
                 +---> [timed_out]
                 |
                 +---> [cancelled]
```

| 状态 | 含义 |
|------|------|
| `queued` | 等待执行（引擎排队） |
| `running` | 正在执行 |
| `completed` | 执行成功 |
| `error` | 执行出错（保留已有 diff） |
| `timed_out` | 执行超时（消除 #413） |
| `cancelled` | 用户主动停止 |

### 2.2 `tool-end` 丢失的超时恢复（消除 #413）

**问题**：`finish()` 的 1200ms 超时只关闭流，不更新工具状态。

**方案**：

```typescript
class ToolExecutionMonitor {
  private timers: Map<string, TimerHandle> = new Map();

  startTracking(toolCallId: string, maxDurationMs: number = 120_000) {
    const timer = setTimeout(() => {
      // 1. 查询引擎：工具是否真实完成？
      this.queryEngine(toolCallId).then((result) => {
        if (result.status === 'completed') {
          // 引擎端已完成但消息丢失 → 补充完成
          this.forceComplete(toolCallId, result.output);
        } else if (result.status === 'running') {
          // 引擎端仍在运行 → 延长超时
          this.startTracking(toolCallId, maxDurationMs);
        } else {
          // 引擎端无记录或已失败 → 标记超时
          this.markTimedOut(toolCallId);
        }
      }).catch(() => {
        // 查询失败（引擎断连）→ 标记超时
        this.markTimedOut(toolCallId);
      });
    }, maxDurationMs);

    this.timers.set(toolCallId, timer);
  }

  private markTimedOut(toolCallId: string) {
    useSessionStore.getState().updateToolCall(toolCallId, {
      status: 'timed_out',
      output: { type: 'timeout', message: '工具执行超过最大时长，已自动终止' }
    });
    this.cleanup(toolCallId);
  }
}
```

**配置**：
- 单个工具超时：`TOOL_EXECUTION.TIMEOUT_MS`（默认 120s）
- 查询重试间隔：`TOOL_EXECUTION.QUERY_INTERVAL_MS`（默认 5s）
- 最大查询次数：`TOOL_EXECUTION.MAX_QUERY_RETRIES`（默认 3）

### 2.3 工具输出存储上限与 DOM 展示策略

| 层级 | 上限 | 策略 |
|------|------|------|
| 内存（store） | `tc.output` 最大 512KB | 超过时截断并标记 `truncated: true` |
| DOM 展示 | 默认展开 2000 字符 | 超过时显示"显示更多"按钮 |
| 虚拟滚动 | `max-height: 40vh` | 改为可配置，响应容器尺寸变化 |
| 大输出（>1MB） | 仅存储前 512KB | 提供"查看完整输出"跳转到文件查看器 |

**工具输出截断策略**：

```typescript
const TRUNCATION_CONFIG = {
  STORE_MAX_BYTES: 512 * 1024,       // 512KB
  DOM_AUTO_EXPAND_CHARS: 2000,
  DOM_MAX_HEIGHT_VH: 60,             // 由 40vh 提升至 60vh
  FULL_OUTPUT_LINK_THRESHOLD: 1 * 1024 * 1024, // 1MB
};
```

### 2.4 diff 发布的原子性保障（消除 #415）

**问题**：`publishToolDiffs` 第二次调用可能创建重复条目。

**方案**：引入 `DiffTransaction`

```typescript
interface DiffTransaction {
  id: string;                    // 唯一事务 ID = hash(sessionId + toolCallId + 文件路径)
  sessionId: string;
  toolCallId: string;
  files: DiffFile[];
  status: 'pending' | 'committed' | 'rolled_back';
  createdAt: number;
}

function publishToolDiffs(sessionId: string, toolCallId: string, diffs: DiffFile[]) {
  const registry = sessionRuntimeRegistry.get(sessionId);
  const transaction: DiffTransaction = {
    id: generateTransactionId(sessionId, toolCallId, diffs),
    sessionId,
    toolCallId,
    files: diffs,
    status: 'pending',
    createdAt: Date.now(),
  };

  // 去重检测：事务 ID 已存在则跳过
  if (registry.hasTransaction(transaction.id)) {
    return; // 幂等
  }

  // 冲突检测：目标文件有未提交的变更且来自不同 toolCall
  for (const diff of diffs) {
    const existing = registry.getDiffForFile(diff.path);
    if (existing && existing.toolCallId !== toolCallId) {
      // 标记冲突，由用户决定
      diff.conflictWith = existing.toolCallId;
    }
  }

  registry.addTransaction(transaction);

  // 通知 daemon 原子发布
  daemonClient.publishDiffs({
    transactionId: transaction.id,
    sessionId,
    diffs,
  }).then(() => {
    registry.commitTransaction(transaction.id);
  }).catch(() => {
    registry.rollbackTransaction(transaction.id);
  });
}
```

### 2.5 `onToolError` 保留已有 diff（消除 #416）

**方案**：`onToolError` 不再将 `tc.diffs` 置为 `undefined`，而是分离状态与输出：

```typescript
function handleToolError(toolCallId: string, error: ToolError) {
  useSessionStore.getState().updateToolCall(toolCallId, {
    status: 'error',
    error: {
      message: error.message,
      code: error.code,
      timestamp: Date.now(),
    },
    // 保留已有 diffs，不覆盖
    // diffs: undefined ← 删除这行
  });
}
```

UI 层渲染规则：
- `status === 'error'` 且 `diffs` 存在 → 显示 diff 预览 + 错误横幅"执行出错，部分改动可能已应用"
- `status === 'error'` 且 `diffs` 为空 → 显示错误详情 + 重试按钮
- `status === 'error'` 且 `diffs` 部分存在 → 标记已应用和未应用的 diff

---

## 3. 乐观更新与回滚

### 3.1 审批乐观更新设计

**流程**：

```
用户点击"允许"
  │
  ├─ 立即: UI 显示 "已批准（确认中）"（乐观态）
  ├─ 发送 daemonApproveTool 到引擎
  │
  ├─ 成功: UI 切换为 "已批准 ✓"（确认态）
  │
  └─ 失败/超时:
       ├─ 引擎拒绝: UI 回滚为原始态 + toast "审批被引擎拒绝"
       └─ 网络错误: UI 保留 "已批准（确认中）" + 重试按钮
```

**状态表示**：

| 视觉态 | store 状态 | 含义 |
|--------|-----------|------|
| "允许" | `pending` | 等待审批 |
| "已批准 ✓" | `approved` | 乐观更新 + 引擎确认 |
| "已批准（确认中）" | `approving` | 乐观更新，等待引擎确认 |
| "已拒绝 ✓" | `denied` | 用户拒绝 + 引擎确认 |
| "已拒绝（确认中）" | `denying` | 乐观更新，等待引擎确认 |
| "（需重试）" | `approval_failed` | 引擎确认失败 |

### 3.2 daemon 确认失败时的回滚机制（消除 #414）

```typescript
class ApprovalRollbackManager {
  private rollbackStack: Map<string, ApprovalSnapshot> = new Map();

  // 创建乐观更新前的快照
  snapshot(approvalId: string) {
    const current = useSessionStore.getState().getApprovalState(approvalId);
    this.rollbackStack.set(approvalId, {
      previousStatus: current.status,
      previousToolCallStatus: current.toolCallStatus,
      timestamp: Date.now(),
    });
  }

  // 引擎确认失败 → 回滚
  rollback(approvalId: string) {
    const snapshot = this.rollbackStack.get(approvalId);
    if (!snapshot) return;

    // 检查回滚窗口（默认 10s 内可回滚）
    if (Date.now() - snapshot.timestamp > ROLLBACK_WINDOW_MS) {
      // 超过回滚窗口 → 标记为不一致，由用户手动修复
      useSessionStore.getState().updateApprovalState(approvalId, {
        status: 'inconsistent',
        warning: '审批状态与引擎不同步，请手动确认',
      });
      return;
    }

    useSessionStore.getState().restoreApprovalState(approvalId, snapshot);
    this.rollbackStack.delete(approvalId);
  }

  // 引擎确认成功 → 清除快照
  confirm(approvalId: string) {
    this.rollbackStack.delete(approvalId);
  }
}
```

### 3.3 二次确认流程的视觉设计

```
┌─────────────────────────────────────┐
│  工具: writeFile("src/index.ts")    │
│  ┌──────────────────────────────┐   │
│  │ 文件改动预览:                    │   │
│  │ + console.log("hello")        │   │
│  └──────────────────────────────┘   │
│                                      │
│  ┌─────────┐  ┌─────────┐          │
│  │  允许   │  │  拒绝   │  ← 初次确认 │
│  └─────────┘  └─────────┘          │
│                                      │
│  ┌─ 记住选择 ─┐ ┌─ 只这次 ─┐       │
│  └───────────┘ └─────────┘          │
└─────────────────────────────────────┘
          │ 用户点击"允许"
          ▼
┌─────────────────────────────────────┐
│  ✓ 已发送批准请求...                 │
│  ┌──────────────────────────────┐   │
│  │ ⏳ 等待引擎确认...             │   │
│  └──────────────────────────────┘   │
│                                      │
│  ┌─────────┐                        │
│  │  撤销   │  ← 可在此窗口内撤销    │
│  └─────────┘                        │
└─────────────────────────────────────┘
          │ 引擎确认
          ▼
┌─────────────────────────────────────┐
│  ✓ 已批准                          │
│  工具执行中...                       │
└─────────────────────────────────────┘
```

**二次确认的视觉差异**：
- `approving`：按钮变为浅绿色脉冲动画 + "确认中"文字
- `approved`：按钮变为实心绿色 + ✓ 图标
- `approval_failed`：按钮变为橙色警告 + ⚠ 图标 + "重试"文字

### 3.4 批量审批操作

```typescript
// approvalBatchActions.ts
interface BatchApprovalAction {
  type: 'approve_all' | 'deny_all' | 'approve_selected' | 'deny_selected';
  approvalIds: string[];
  sessionId: string;
}

async function executeBatchApproval(action: BatchApprovalAction) {
  const { sessionStore } = useSessionStore.getState();

  // 1. 乐观更新全部
  for (const id of action.approvalIds) {
    sessionStore.updateApprovalState(id, {
      status: action.type.startsWith('approve') ? 'approving' : 'denying',
    });
  }

  // 2. 批量发送到引擎
  try {
    await daemonClient.batchApproveTools({
      sessionId: action.sessionId,
      approvalIds: action.approvalIds,
      action: action.type,
    });

    // 3. 全部确认
    for (const id of action.approvalIds) {
      sessionStore.updateApprovalState(id, {
        status: action.type.startsWith('approve') ? 'approved' : 'denied',
      });
    }
  } catch {
    // 4. 全部回滚
    for (const id of action.approvalIds) {
      rollbackManager.rollback(id);
    }
    showToast('批量操作失败，已回滚', 'error');
  }
}
```

**UI 入口**：
- 审批 dock 添加 "全部允许" / "全部拒绝" 按钮（消除 #419, #98）
- 批量操作前显示确认对话框："将允许/拒绝 N 个待审批工具"
- 批量操作期间显示进度条

---

## 4. diff 管理

### 4.1 diffFiles 按会话隔离（消除 #423）

**方案**：`diffFiles` 从全局 Store 移至 `SessionRuntimeRegistry`

```typescript
// sessionRuntimeRegistry.ts
class SessionRuntimeRegistry {
  private sessions: Map<string, SessionRuntime> = new Map();

  getSessionRuntime(sessionId: string): SessionRuntime {
    let runtime = this.sessions.get(sessionId);
    if (!runtime) {
      runtime = {
        diffFiles: [],
        diffTransactions: new Map(),
        toolExecutions: new Map(),
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, runtime);
    }
    return runtime;
  }

  // 会话销毁时清理
  destroySession(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  // 老化：超过 24h 未访问的会话 diff 自动清理
  evictStaleSessions(maxAgeMs: number = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [id, runtime] of this.sessions) {
      if (now - runtime.lastAccessedAt > maxAgeMs) {
        this.sessions.delete(id);
      }
    }
  }
}
```

**Store 适配**：为兼容现有代码，全局 `diffFiles` 保留为聚合视图：

```typescript
// sessionStore 中的 diffFiles 变为计算属性
get diffFiles(): DiffFile[] {
  const activeSessionId = this.activeSessionId;
  if (!activeSessionId) return [];
  return sessionRuntimeRegistry.getSessionRuntime(activeSessionId).diffFiles;
}
```

### 4.2 publishToolDiffs 冲突解决改进（消除 #415）

**冲突类型**：

| 冲突类型 | 检测条件 | 解决策略 |
|----------|----------|----------|
| 自身重复 | 同一 toolCall 对同一文件发布相同 diff | 幂等跳过 |
| 跨工具冲突 | 不同 toolCall 修改同一文件的同一区域 | 标记冲突，用户选择 |
| 已接受冲突 | 文件已被用户接受后又被修改 | 新 diff 覆盖旧 diff，保留旧 diff 在历史中 |

```typescript
function resolveDiffConflict(
  existing: DiffFile,
  incoming: DiffFile,
): 'override' | 'skip' | 'manual' {
  if (existing.status === 'accepted') {
    // 已接受的 diff 被新 diff 覆盖 → 保留历史版本
    return 'override';
  }
  if (existing.toolCallId === incoming.toolCallId) {
    // 同一工具的重复发布 → 跳过
    return 'skip';
  }
  // 不同工具的冲突 → 标记需用户手动解决
  return 'manual';
}
```

**UI 冲突展示**：

```
┌─ diff 冲突 ─────────────────────────┐
│ 文件: src/config.ts                  │
│                                      │
│ 现有改动 (来自 writeFile):           │
│ + DEBUG=true                         │
│                                      │
│ 新改动 (来自 editFile):              │
│ + logLevel="debug"                   │
│                                      │
│  ┌─────────┐  ┌─────────┐  ┌─────┐ │
│  │ 保留现有 │  │ 使用新   │  │ 都保留│ │
│  └─────────┘  └─────────┘  └─────┘ │
└──────────────────────────────────────┘
```

### 4.3 withdrawMessage 时的 diff 清理（消除 #425-426）

```typescript
function withdrawMessage(sessionId: string, messageIdx: number) {
  const session = useSessionStore.getState().getSession(sessionId);
  const message = session.messages[messageIdx];
  const registry = sessionRuntimeRegistry.getSessionRuntime(sessionId);

  // 收集此消息涉及的所有 toolCallId
  const toolCallIds = message.toolCalls?.map(tc => tc.id) || [];

  // 1. 从 tc.diffs 中清理
  for (const tc of message.toolCalls || []) {
    tc.diffs = undefined;
  }

  // 2. 从 SessionRuntimeRegistry.diffFiles 中清理
  registry.removeDiffsByToolCallIds(toolCallIds);

  // 3. 从已接受的 diff 列表中移除（如果有）
  registry.removeAcceptedDiffsByToolCallIds(toolCallIds);

  // 4. 执行撤回
  useSessionStore.getState().withdrawMessage(sessionId, messageIdx);
}
```

### 4.4 分叉会话的 diff 隔离（消除 #427）

```typescript
function branchSession(sourceSessionId: string, branchPoint: number): string {
  const sourceRegistry = sessionRuntimeRegistry.getSessionRuntime(sourceSessionId);
  const branchId = generateSessionId();

  // 深拷贝 source 的 diff 状态到分支
  const branchRuntime = sessionRuntimeRegistry.createSessionRuntime(branchId);
  branchRuntime.diffFiles = sourceRegistry.diffFiles
    .filter(d => d.createdAt <= branchPoint)  // 只保留分支点前的 diff
    .map(d => ({ ...d, sessionId: branchId })); // 重新绑定到新会话

  // 分支点后的 diff 不复制，由新会话独立累积
  return branchId;
}
```

**分支 diff 界面标识**：

```
┌─ 会话 A（主干） ─┐    ┌─ 会话 B（分支） ─┐
│ diff1 (已接受)   │    │ diff1 (已接受)   │ ← 从 A 继承
│ diff2 (待审批)   │    │ diff3 (新增)     │ ← B 独有
│ diff4 (新增)     │    └──────────────────┘
└──────────────────┘
```

---

## 5. 工具调用 UI

### 5.1 工具执行进度条

```typescript
// ChatToolCallBlock.tsx
interface ToolProgressProps {
  status: ToolCallStatus;
  startedAt?: number;
  completedAt?: number;
  estimatedDurationMs?: number; // 从历史统计获取
}
```

**渲染规则**：

| 状态 | 进度条表现 |
|------|------------|
| `queued` | 灰色等待动画（点状脉冲） |
| `running` | 蓝色不确定进度条（`<progress indeterminate>`）或基于历史估算的确定进度条 |
| `completed` | 绿色满进度条 + ✓ |
| `error` | 红色进度条中断 + ✗ |
| `timed_out` | 橙色进度条 + ⏱ |
| `cancelled` | 灰色进度条 + ⊘ |

**估算进度计算**：

```typescript
function calculateProgress(toolName: string, elapsedMs: number): number {
  const historicalAvg = toolExecutionHistory.getAverageDuration(toolName);
  if (!historicalAvg) return -1; // 不确定进度
  return Math.min(elapsedMs / historicalAvg, 0.95); // 最多 95%，留 5% 给收尾
}
```

### 5.2 工具耗时显示

```typescript
// ChatToolCallBlock.tsx
const ToolDuration: React.FC<{ toolCall: ToolCallState }> = ({ toolCall }) => {
  const now = useNowTick(1000); // 每秒 tick
  const elapsed = toolCall.status === 'running'
    ? now - toolCall.startedAt!
    : (toolCall.completedAt || toolCall.erroredAt || now) - toolCall.startedAt!;

  return <span className="tool-duration">{formatDuration(elapsed)}</span>;
};
```

**显示格式**：

| 耗时范围 | 格式 | 示例 |
|----------|------|------|
| < 1s | `< 1s` | — |
| 1s - 60s | `Xs` | `12s` |
| 60s - 99m | `Xm Ys` | `1m 23s` |
| > 99m | `Xh Ym` | `2h 15m` |

### 5.3 失败工具的重试按钮

```typescript
// ChatToolCallBlock.tsx
const RetryButton: React.FC<{ toolCall: ToolCallState; sessionId: string }> = ({
  toolCall,
  sessionId,
}) => {
  if (toolCall.status !== 'error' && toolCall.status !== 'timed_out') {
    return null;
  }

  return (
    <button
      className="tool-retry-btn"
      onClick={() => retryToolCall(sessionId, toolCall.id)}
      aria-label="重试此工具"
    >
      <RotateCcwIcon size={14} />
      <span>重试</span>
    </button>
  );
};

// retry 逻辑
async function retryToolCall(sessionId: string, toolCallId: string) {
  const toolCall = useSessionStore.getState().getToolCall(sessionId, toolCallId);
  // 重置状态
  useSessionStore.getState().updateToolCall(toolCallId, {
    status: 'queued',
    error: undefined,
    output: undefined,
  });
  // 向引擎发送重试请求
  await daemonClient.retryToolExecution({
    sessionId,
    toolCallId,
    toolName: toolCall.toolName,
    arguments: toolCall.arguments,
  });
}
```

### 5.4 工具输出搜索

```typescript
// ChatToolCallBlock.tsx
const ToolOutputSearch: React.FC<{ toolCallId: string }> = ({ toolCallId }) => {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [activeMatch, setActiveMatch] = useState(0);

  const handleSearch = useCallback((q: string) => {
    const output = getToolOutput(toolCallId);
    const results = [];
    const regex = new RegExp(escapeRegex(q), 'gi');
    let match;
    while ((match = regex.exec(output)) !== null) {
      results.push({ index: match.index, length: match[0].length });
    }
    setMatches(results);
    setActiveMatch(0);
  }, [toolCallId]);

  return (
    <div className="tool-output-search">
      <input
        type="search"
        value={query}
        onChange={e => { setQuery(e.target.value); handleSearch(e.target.value); }}
        placeholder="在输出中搜索..."
        aria-label="在工具输出中搜索"
      />
      <span className="match-count">
        {matches.length > 0 ? `${activeMatch + 1}/${matches.length}` : ''}
      </span>
      {matches.length > 0 && (
        <>
          <button onClick={() => setActiveMatch(p => Math.max(0, p - 1))}>↑</button>
          <button onClick={() => setActiveMatch(p => Math.min(matches.length - 1, p + 1))}>↓</button>
        </>
      )}
    </div>
  );
};
```

**高亮渲染**：匹配文本包裹 `<mark>` 标签，支持 `scrollIntoView`。

### 5.5 嵌套工具调用的展开

**问题**（#107, #114）：当前 `flattenRenderTools` 丢失分组信息，子工具调用不能嵌套展开。

**方案**：树形工具视图

```typescript
// ChatToolCallBlock.tsx
interface ToolCallTreeNode {
  toolCall: ToolCallState;
  children: ToolCallTreeNode[];     // 子工具调用
  parentId?: string;                // 父工具调用 ID
  isNested: boolean;
}

function buildToolCallTree(toolCalls: ToolCallState[]): ToolCallTreeNode[] {
  const nodeMap = new Map<string, ToolCallTreeNode>();
  const roots: ToolCallTreeNode[] = [];

  for (const tc of toolCalls) {
    nodeMap.set(tc.id, { toolCall: tc, children: [], isNested: false });
  }

  for (const tc of toolCalls) {
    const node = nodeMap.get(tc.id)!;
    if (tc.parentToolCallId && nodeMap.has(tc.parentToolCallId)) {
      node.isNested = true;
      node.parentId = tc.parentToolCallId;
      nodeMap.get(tc.parentToolCallId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
```

**UI 渲染**：

```
┌─ 📄 readFile("src/config.ts") ─ 0.3s ─ ✓ ─┐
│ 输出: content loaded                        │
└─────────────────────────────────────────────┘

┌─ 📝 editFile("src/config.ts") ─ 1.2s ─ ✓ ─┐  ← 父工具
│ ┌─ 🔍 readFile("src/config.ts") ─ 0.2s ─┐ │  ← 子工具（缩进）
│ │ 输出: (子工具输出)                      │ │
│ └─────────────────────────────────────────┘ │
│ 输出: patch applied                         │
└─────────────────────────────────────────────┘
```

**嵌套交互**：
- 父工具默认展开，子工具默认折叠
- 点击父工具行展开/收起所有子工具
- 子工具有独立的展开/收起状态
- 深度大于 3 层的嵌套自动折叠，显示"N 层嵌套（点击展开）"提示

---

## 附录：配置常量汇总

```typescript
export const APPROVAL_TOOL_PIPELINE_CONFIG = {
  // 审批流程
  APPROVAL: {
    PENDING_TIMEOUT_MS: 60_000,       // #412: 审批等待超时
    DISCONNECT_TIMEOUT_MS: 30_000,    // #412: 断连后自动拒绝超时
    REMIND_INTERVAL_MS: 30_000,       // 超时提醒间隔
    MAX_PENDING_AGE_MS: 300_000,      // 持久化审批最大存活时间
    ROLLBACK_WINDOW_MS: 10_000,       // #414: 乐观更新回滚窗口
    BATCH_MAX_ITEMS: 50,              // 批量审批上限
  },

  // 工具执行
  TOOL_EXECUTION: {
    TIMEOUT_MS: 120_000,              // #413: 单工具最大执行时间
    QUERY_INTERVAL_MS: 5_000,         // #413: 超时后查询引擎间隔
    MAX_QUERY_RETRIES: 3,             // #413: 最大查询次数
  },

  // 输出存储
  OUTPUT: {
    STORE_MAX_BYTES: 512 * 1024,      // 工具输出存储上限
    DOM_AUTO_EXPAND_CHARS: 2_000,     // DOM 自动展开字符数
    DOM_MAX_HEIGHT_VH: 60,            // DOM 最大高度
    FULL_OUTPUT_LINK_THRESHOLD: 1 * 1024 * 1024, // 显示"查看完整"的阈值
  },

  // diff
  DIFF: {
    MAX_DIFF_FILES_PER_SESSION: 50,   // 每会话最大 diff 文件数
    MAX_DIFF_AGE_MS: 24 * 60 * 60 * 1000, // diff 老化时间
    TRANSACTION_ID_PREFIX: 'diff_tx_', // 事务 ID 前缀
  },
};
```

## 附录：关联审计问题对照表

| 审计 # | 问题 | 方案位置 |
|--------|------|----------|
| #106 | 工具行嵌套不支持 | 5.5 嵌套工具调用展开 |
| #107 | 工具输出不支持搜索 | 5.4 工具输出搜索 |
| #108 | 工具失败无重试按钮 | 5.3 重试按钮 |
| #109 | 工具无耗时显示 | 5.2 耗时显示 |
| #110 | ToolResultBody 局部类型 | 统一共享类型（隐含在整体设计） |
| #111 | toolRowHead 用 div 模拟 button | 改为 `<button>`（隐含修复） |
| #112 | findAgentForTool 子串匹配 | 改为精确匹配（隐含修复） |
| #113 | flattenRenderTools 丢失分组 | 5.5 树形视图 |
| #114 | toolResultBody max-height 固定 | 2.3 DOM 展示策略 |
| #412 | 审批断连卡死 | 1.1-1.4 审批流程机重构 |
| #413 | tool-end 丢失永久 running | 2.2 超时恢复 |
| #414 | daemonApproveTool 失败无回滚 | 3.2 回滚机制 |
| #415 | publishToolDiffs 重复条目 | 2.4 原子发布 + 4.2 冲突解决 |
| #416 | onToolError 覆盖 diffs | 2.5 保留已有 diff |
| #417 | 二次确认乐观更新变谎言 | 3.1-3.3 乐观更新设计 |
| #418 | commitLockRef 480ms 锁 | 3.1 引入 approaving/denying 态取代锁 |
| #419 | 无"全部拒绝" | 3.4 批量操作 |
| #420 | 无"查看上下文"跳转 | 审批卡片添加跳转按钮 |
| #421 | 审批无超时自动拒绝 | 1.2 超时策略 |
| #422 | collectPendingApprovals 容忍空值 | 过滤空 id 条目 |
| #423 | diffFiles 全局不隔离 | 4.1 SessionRuntimeRegistry 隔离 |
| #425 | withdrawMessage 不清理 tc.diffs | 4.3 清理逻辑 |
| #426 | removeDiffFile 不清理 tc.diffs | 4.3 清理逻辑 |
| #427 | 分叉会话共享 diffFiles | 4.4 分叉隔离 |
