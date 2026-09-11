# §5 修复抽查 · FIX-§5-verification

> 核查人：code-audit · 2026-09-08（America/New_York）
> 标准：`QUALITY-GATE.md` 可证伪
> 对照：`FIX-PROGRESS-§5.md` · 前置 §4 已闭合
> **复检**：F5-1 回炉后（同日）

## 总裁定：**§5 已闭合**（无阻断 `[!]`）

| 小节 | 标记 | 说明 |
|------|:----:|------|
| §5.1 测高可失效重测 | `[x]` | 永久 `isMeasuredRef` 已删 |
| §5.2 计划条 / 审批 / 行级重新生成 | `[x]` | F5-1 已对齐 `onRetract` |
| §5.3 确认签名分桶 + 级联清理 | `[x]` | R5-2 仍为建议 `[~]` |
| bes 挂名复核 | `[x]` | 进度自报；前轮已核 |

**允许开 §6**。

---

## §5.1 `[x]`

**证据**

- `VirtualPlainCodeViewer.tsx`：`measureGenRef` + 探针 `ResizeObserver`；`useLayoutEffect` 依赖 `[uiSize, wordWrap]`，无永久 `isMeasuredRef` 锁。
- `MessageVirtualizer.tsx`：订阅 `useLayoutStore.uiSize`，变更 `clearHeights()`；度量用 `offsetHeight`。

---

## §5.2 `[x]`（含 F5-1 复检）

### 既有通过项

- `ChatComposerWrapper` / `ChatStatusRibbons`：`useSessionStore(s => sessionsById[id])`。
- 审批：缺回调 → 显式不可用（composerAbove / `CompactToolRow`）。
- `EphemeralStatusSlot.onRetry`：仅 `generation?.handleRegenerateRow && lastAssistantId`。

### F5-1 `[x]` 行级「重新生成」

**前轮 `[!]`**：`handleRegenerateRow ?? (() => {})` + ActionsBar 无条件渲染 → 静默 no-op。

**复检证据**

| 点 | 现状 |
|----|------|
| `MessageVirtualizer.tsx` L107 | `const handleRegenerateRow = generation?.handleRegenerateRow;`（**无** `?? (()=>{})`） |
| 同文件 L436 | `onRegenerate={handleRegenerateRow}`（可为 `undefined`） |
| `AssistantMessageActionsBar.tsx` | `onRegenerate?`；仅 `isLastAssistant && onRegenerate` 渲染按钮（对齐 `onRetract`） |
| `ChatAssistantMessageRow.tsx` | `...(onRegenerate !== undefined && { onRegenerate })` |
| `MessageActions.tsx` | 同条件展开 |
| `AgentMessageRow.tsx` | **无**伪装 `onRegenerate={() => {}}` |

**测试（本机复跑）**：`npx vitest` 3 files **16 passed**

- `MessageVirtualizer.sec5.source.test.ts`：断言无 noop fallback
- `AssistantMessageActionsBar.sec5.source.test.ts`：optional + 门控契约
- `MessageRetract.test.tsx`：无回调不渲染；有回调可点

**同文件残留（非阻断收尾）**：`MessageVirtualizer` / `AgentMessageRow` 仍有 branch/diff/pin 等 `?? (() => {})`。本轮硬门槛仅为重试/重新生成；建议 §6 前或收尾清。

---

## §5.3 `[x]`

**证据**

- `workflowConfirmSignatures.ts`：`Map<sessionId, Set<sig>>` + `clearWorkflowConfirmSignaturesForSession`
- `WorkflowConfirmCard` 用分桶 API
- `SessionCoordinator.deleteSessionCascade` 调用清理

**R5-2 `[~]`**：无 session 时 `__none__` 桶可能只增不减。建议切换/登出清桶或不入桶——**不阻断 §5/§6**。

---

## QUALITY-GATE 对照

1. 意图可陈述 — 过
2. 无新旁路 — **过**（F5-1 已关）
3. 对称失败 — 过（缺 regenerate 不渲染）
4. 测试 — 过（源码契约 + 行为；16 PASS）
5. 门禁 — bes 已挂名
6. 二次核查 — 本文件；**无 `[!]` → 闭合**

---

## 结论与交接

- **§5 闭合**；F5-1 `[x]`。
- **@main 可开 §6**。
- 可选：清 Virtualizer/Agent 行其它 noop；跟进 R5-2 `__none__`。

_文档由 code-audit 可证伪复检生成_