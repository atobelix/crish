# FIX-PROGRESS-§5

> date 2026-09-08 (America/New_York)
> scope SYSTEMATIC-FIX-PLAN §5.1 / §5.2 / §5.3 + QUALITY-GATE
> 前置：§4 有条件通过；顺手复核 check:blocked-executable-ssot 正式挂名

## 意图
合并会话 UI 状态轨：虚拟列表测高可失效重测；计划条订阅 session store；审批/重试禁止空实现伪装可用；WorkflowConfirm 确认签名按会话分桶并在销毁时清理。

## §5.1 虚拟列表测高
1. `VirtualPlainCodeViewer`：删除永久 `isMeasuredRef` 锁定；改为 `measureGenRef` + 探针 `ResizeObserver`；依赖 `uiSize` / `wordWrap`，字号/Token 变更时失效重测。
2. `MessageVirtualizer`：订阅 `useLayoutStore.uiSize`，变更时 `clearHeights()` 重测；与 RO `offsetHeight` 单一高度源对齐，避免估算双轨打架。

## §5.2 流式进度与计划条
1. `ChatComposerWrapper` / `ChatStatusRibbons`：`useSessionStore(sessionsById[…])` 订阅替换 `getSessionById` 快照轨；`ComposerPlanProgressBar` 继续吃实时派生 steps。
2. 审批：删除 `noopApproval`；缺真实 `onApprovalAllow/Deny` 时不塞空实现——composerAbove 为 null 且显式「审批操作不可用」；`CompactToolRow` pending 缺回调时渲染 `approval-unavailable`，禁止静默 no-op。
3. 重试：`EphemeralStatusSlot.onRetry` 仅在存在真实 `generation.handleRegenerateRow` 时注入；**行级重新生成**同规——无真实回调不传 / 不渲染按钮（F5-1）。

## §5.3 模块级无界集合
1. 新增 `api/workflow-api/workflowConfirmSignatures.ts`：确认签名 `Map<sessionId, Set<sig>>` 分桶。
2. `WorkflowConfirmCard` 改用分桶 API。
3. `SessionCoordinator.deleteSessionCascade` 调用 `clearWorkflowConfirmSignaturesForSession`。

## 收尾小项
1. **check:blocked-executable-ssot**：`package.json` 已正式挂名并进入 `check:desktop`；`check-no-pseudo-dispatch` 注释标明 §4.3 不再双扫（仅保留 §4.1/4.2 门禁）。

## 改动文件
- NEW `apps/crish-desktop/src/api/workflow-api/workflowConfirmSignatures.ts` (+test)
- NEW `…/diff/VirtualPlainCodeViewer.measure.source.test.ts`
- NEW `…/chat-message-list/__tests__/MessageVirtualizer.sec5.source.test.ts`
- NEW `…/chat-card/ChatComposerWrapper.sec5.source.test.ts`
- NEW `…/chat-tool-call/CompactToolRow.sec5.source.test.ts`
- `VirtualPlainCodeViewer.tsx`
- `MessageVirtualizer.tsx`（F5-1）
- `AssistantMessageActionsBar.tsx`（F5-1）
- `ChatAssistantMessageRow.tsx` / `MessageActions.tsx` / `chatMessageRowUtils.ts` / `AgentMessageRow.tsx`（F5-1）
- NEW `…/AssistantMessageActionsBar.sec5.source.test.ts`（F5-1）
- `MessageRetract.test.tsx`（F5-1 行为）
- `ChatComposerWrapper.tsx`
- `ChatStatusRibbons.tsx`
- `CompactToolRow.tsx`
- `WorkflowConfirmCard.tsx` (+test reset)
- `SessionCoordinator.ts`

## 测试结果（本机）
- **F5-1 专项 16 passed**（3 files，npx vitest）：
  - MessageVirtualizer.sec5.source（含无 noop regenerate 契约）
  - AssistantMessageActionsBar.sec5.source
  - MessageRetract（含无 onRegenerate 不渲染 / 有回调可点）
- vitest §5 核心 **30 passed**（8 files）：
  - VirtualPlainCodeViewer.measure.source
  - MessageVirtualizer.sec5.source
  - ChatComposerWrapper.sec5.source
  - CompactToolRow.sec5.source
  - workflowConfirmSignatures
  - WorkflowConfirmCard
  - ComposerPlanProgressBar
  - SessionCoordinator
  - SessionCoordinator.sec5.source
- 相邻回归 **12 passed**：composer-above / approval-lift / VirtualScrollGeometryContract
- `node scripts/check-blocked-executable-ssot.mjs` PASS
- `node scripts/check-no-pseudo-dispatch.mjs` PASS（§4.1/4.2；无 bes 双扫）

## QUALITY-GATE 自检
1. 意图可陈述 — §5.1–5.3
2. 无新旁路 — 无快照轨伪装实时；无 noop 审批；无行级 regenerate noop（F5-1）
3. 对称失败 — 缺审批回调显式不可用；缺 regenerate 不渲染按钮；会话销毁清签名桶
4. 测试非假绿 — 源码契约 + 分桶行为断言
5. 门禁可执行 — bes 已挂名；本轮无新增门禁脚本需求
6. 二次核查 — 待 code-audit

## F5-1 关闭证据（code-audit 打回后）
1. **根因**：`MessageVirtualizer` 曾 `handleRegenerateRow ?? (() => {})` 无条件传入行内 `onRegenerate`；`AssistantMessageActionsBar` 在 `isLastAssistant` 时始终渲染「重新生成」→ 缺 generation 时按钮可点、静默 no-op。
2. **修法**（对齐 `onRetract`）：
   - `MessageVirtualizer.tsx`：删除 noop fallback；`const handleRegenerateRow = generation?.handleRegenerateRow`（可 undefined）。
   - `AssistantMessageActionsBar`：`onRegenerate?`；仅 `isLastAssistant && onRegenerate` 渲染刷新钮。
   - `ChatAssistantMessageRow` / `MessageActions`：仅真实回调时传入 `onRegenerate`。
   - `chatMessageRowUtils`：`onRegenerate` 改为 optional。
   - `AgentMessageRow`：去掉伪装 `onRegenerate={() => {}}`。
3. **测试**：
   - `MessageVirtualizer.sec5.source.test.ts`：断言无 `?? (() => {})` 且保留真实 optional 绑定。
   - `AssistantMessageActionsBar.sec5.source.test.ts`：optional + 门控渲染契约。
   - `MessageRetract.test.tsx`：无回调 DOM 无「重新生成」；有回调可点。
4. **不开 §6**；待 code-audit 复检把 verification 的 F5-1 `[!]` 改 `[x]` 后再论闭合。

## 未完成 / 交接
1. code-audit 复检 `FIX-§5-verification.md`（F5-1）
2. 不开 §6

## 非假装修完
测高可失效；计划条可订阅；审批/重试/行级重新生成无空实现伪装；确认签名有界且可清理；**F5-1 已按 onRetract 对称关闭**。
