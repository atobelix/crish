# Session Store 数据完整性审计报告

> Agent 4 / Round 12
> 审计范围：`packages/agent-runtime/src/session-store/index.ts`（appendMessage / appendMessages / getAllMessages）
> 关联文件：`apps/crish-desktop/src/store/session-actions/message-actions.ts`（前端截断路径）
>
> **⚠️ HISTORICAL (OPT-E8 / W4-2):** `store/session-actions/` 目录已物理删除。本审计中的 `session-actions/*` 路径为历史快照。现行：`sessionMessageActions.ts` 等 + barrel `sessionActions.ts`。

## 1. 逐行验证结果

| 检查项 | 位置 | 状态 | 说明 |
|--------|------|------|------|
| SS-1 | `session-store/index.ts:146`（要求写142-143） | ✅ PASS | `branch.shards.length >= MAX_SHARDS_PER_BRANCH` 时抛出 `StoreCapacityError`，非 silent return |
| SS-2 | `session-store/index.ts:161`（要求写158） | ✅ PASS | `shard.messages.length >= MAX_MESSAGES_PER_SESSION` 时抛出 `StoreCapacityError`，非 silent return |
| MS-1 | `message-actions.ts:27-40` | ⚠️ 部分通过 | `shift()`前有配对检查，记录 toolCall.id → `truncatedToolChainIds`；但**不验证 msg[1] 是否为工具结果**，不阻拦 shift |
| MS-3 | `session-actions/types.ts:4` | ❌ FAIL | `SessionStoreSlice` 接口中**缺少** `truncatedToolChainIds?: string[]`。该字段实际定义在 `store/types.ts:343` 的 `SessionState` 上 |
| SS-3 | `session-store/types.ts:1-6` | ✅ PASS | `StoreCapacityError extends Error` 正确定义 |

> 注意：要求中的行号（142-143、158）与实际源码行号（146、161）存在偏移，原因是注释/import 行数变化。

## 2. 每条写入/截断路径的防护机制

### 2.1 agent-runtime `SessionStore.appendMessage`（分片存储）

```
appendMessage(msg, turnIdx)
  ├─ branch 不存在 → Error（立即失败）
  ├─ shard 未命中且 branch.shards.length >= MAX_SHARDS_PER_BRANCH (=100) → StoreCapacityError
  ├─ shard 命中且 shard.messages.length >= MAX_MESSAGES_PER_SESSION (=500) → StoreCapacityError
  └─ 正常写入：push → shard → messageCount++ / estimatedTokens +=
```

防护总结：
- **硬上界**：分片数上限 + 每分片消息数上限，双重保护
- **失败语义明确**：`StoreCapacityError` 可被上游捕获并区分于其他异常

### 2.2 agent-runtime `SessionStore.appendMessages`（批量）

```ts
try { for (const msg of messages) appendMessage(msg); }
catch (err) { if (err instanceof StoreCapacityError) { console.warn(...); return; } throw err; }
```

防护总结：
- 遇到 `StoreCapacityError` **静默终止**，已写入的部分被保留，未写入的部分丢失
- 调用方无法区分「全部成功」和「部分成功」

### 2.3 crish-desktop `addMessage`（前端 FIFO 截断）

```
sess.messages.length >= MAX_MESSAGES_PER_SESSION (=500)
  ├─ first.toolCalls?.length → 记录 id 到 truncatedToolChainIds
  └─ shift() → push(newMsg)
```

防护总结：
- **FIFO 淘汰**，不抛异常
- 配对保护**仅记录**已截断的 toolCall ID，不阻止 `shift()`，不清理 msg[1] 的 tool-result

## 3. 边界条件处理正确性

### 3.1 消息数极限

| 场景 | 实际值 | 期望值（审计要求） | 判断 |
|------|--------|-------------------|------|
| `MAX_MESSAGES_PER_SESSION` | 500 | 100（要求写） | 实际值更大，更宽松；但审计假设的场景数值与代码不一致 |
| `MAX_SHARDS_PER_BRANCH` | 100 | 2（要求写） | 实际值更大；要求中的 2 是测试用 mock 值 |

**结论**：边界常数与审计用例的假设存在差异。生产环境中 500/100 的上限组合意味着单分支最多容纳 100×500 = 50,000 条消息，远高于测试场景的 204 条。shard 分裂在实际代码中**只会在不同 turnIndex 时触发**，相同 turnIndex 的消息堆积在同一 shard 内。

### 3.2 shard 分裂与 shift 截断的行为验证

**模拟 1：连续追加 MAX_MESSAGES_PER_SESSION + 10 条（相同 turnIndex）**
- `agent-runtime`：501 条时 `StoreCapacityError`，`appendMessages` 静默丢弃剩余 9 条
- `crish-desktop`：shift 最早 10 条，维持 500 条；但 shift 时不验证 msg[1] 配对

**模拟 2：204 条不同 turnIndex 消息**
- 每个 turnIndex 创建新 shard，第 101 个 shard 时 `StoreCapacityError`
- 错误行为：部分消息已写入（前 100 个 shard），剩余被丢弃
- **风险**：调用方无法感知部分写入

**模拟 3：tool-call(msg[0]) + tool-result(msg[1]) → shift**
- `crish-desktop`：shift(msg[0]) → msg[1] 的 tool-result 变成 msg[0]
- `truncatedToolChainIds` 记录已移除的 toolCall ID
- **配对丢失**：下游读取时看到 tool-result 但找不到对应的 tool-call

### 3.3 类型一致性风险

| 检查 | 结果 |
|------|------|
| `ISessionStore.appendMessage` 返回值类型 | `Promise<AppendResult> \| AppendResult` |
| `SessionStore.appendMessage` 实际返回值 | `void` |
| `AppendResult` 是否导出 | ❌ 未在 `session-store/index.ts` 或 `types.ts` 中定义/导出 |

`SessionStore` 声称实现 `ISessionStore`，但方法签名不匹配（`void` vs `AppendResult`），编译时可能通过结构性类型兼容，但语义上有误。

## 4. 数据不一致风险

| 风险等级 | 描述 | 触发条件 | 影响 |
|----------|------|----------|------|
| 🔴 高 | tool-result 无配对 tool-call | FIFO shift 移除 tool-call 消息，保留 tool-result | UI 或下游渲染出现悬挂的 tool-result |
| 🟡 中 | 批量写入部分成功 | `appendMessages` 在中途捕获 `StoreCapacityError` 后静默返回 | 调用方以为全部写入成功，实际缺失部分消息 |
| 🟡 中 | `SessionStoreSlice` 缺少 `truncatedToolChainIds` | 前端类型检查 | 编译时类型不完整，需通过 `SessionState` 访问 |
| 🟢 低 | `ISessionStore` 与 `SessionStore` 方法签名不一致 | 调用方引用接口类型 | 潜在类型错误或意外行为 |

## 5. 改进建议

### 5.1 MS-4 配对保护（高优先级）

`message-actions.ts` 在 `shift()` 前添加配对清理逻辑：

```ts
// shift 前：若 msg[0] 有 toolCalls，检查 msg[1] 是否为对应 tool-result，一并移除
if (first.toolCalls?.length && sess.messages.length > 1) {
  const second = sess.messages[1];
  if (second.toolCallResults?.some((r) => first.toolCalls.some((tc) => tc.id === r.id))) {
    sess.messages.splice(0, 2); // 配对移除
    // ...
  }
}
```

### 5.2 `appendMessages` 原子化（中优先级）

将 `appendMessages` 改为「全成功或全失败」语义，或返回 `{ written: number, failed: number }` 让调用方感知部分写入。

### 5.3 补全 `SessionStoreSlice`（低优先级）

在 `session-actions/types.ts` 的 `SessionStoreSlice` 中添加 `truncatedToolChainIds?: string[]`，使类型定义与实际数据形状一致。

### 5.4 对齐 `ISessionStore` 与 `SessionStore`（低优先级）

在 `session-store/types.ts` 中定义 `AppendResult`，让 `SessionStore.appendMessage` 返回符合接口声明的类型。

---

*生成时间：2026-07-24*
