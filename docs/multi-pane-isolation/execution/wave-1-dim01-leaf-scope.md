# 维度 01：子窗口作用域上下文与焦点激活架构落地报告

> **战役工作区**：`docs/multi-pane-isolation/`  
> **负责维度**：维度 01（子窗口作用域上下文与焦点激活架构）  
> **对应详案**：[`01-子窗口作用域上下文与焦点激活架构方案.md`](../01-子窗口作用域上下文与焦点激活架构方案.md)  
> **审查报告**：[`plan-reviews/review-01-architecture-and-deletion-audit.md`](../plan-reviews/review-01-architecture-and-deletion-audit.md)  
> **执行状态**：✅ **全部核心改造与单元测试 100% 落地**

---

## 一、 改动文件清单与行数审计（Line Counts）

依据战役正交文件域划分与 `ANTI_OVERENGINEERING_GUARDRAILS.md`，本次修改仅局限于维度 01 独占范围：

| 文件路径                                                                                   | 架构分类       | 有效行数 / 门禁上限  |                             状态                              |
| :----------------------------------------------------------------------------------------- | :------------- | :------------------: | :-----------------------------------------------------------: |
| `apps/crish-desktop/src/contexts/LeafScopeContext.tsx`                                     | Context 基建   |      140 / 500       |          ✅ 通过（含 Reviewer Guard-1 向后兼容网关）          |
| `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`                          | UI 容器组件    | 476 / 500 (基线 485) |        ✅ 通过（包裹 Provider + 捕获激活 + B-01 SSOT）        |
| `apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx`                             | UI 容器组件    | 408 / 500 (基线 442) | ✅ 通过（接入 `isLeafInDraftMode` SSOT + `data-pane-close`）  |
| `apps/crish-desktop/src/components/binary-tree/treeLeafPanelModel.ts`                      | 领域模型       |       84 / 500       |        ✅ 通过（导出 `isLeafInDraftMode` 单一真理源）         |
| `apps/crish-desktop/src/builtinViewFactories.tsx`                                          | 视图工厂解耦表 |       89 / 500       |  ✅ 通过（10 视图工厂全量透传 `ctx.sessionId`/`ctx.leafId`）  |
| `apps/crish-desktop/src/components/chat-card/useScopedSessionField.ts`                     | 性能 Hook      |       79 / 500       | ✅ 通过（解除全局 `activeSessionId` 耦合 + `Object.is` 比较） |
| `apps/crish-desktop/src/contexts/__tests__/LeafScopeContext.test.tsx`                      | 单元测试       |        260 行        |               ✅ 新建并通过（14/14 tests pass）               |
| `apps/crish-desktop/src/components/binary-tree/__tests__/TreeLeafPanel.isolation.test.tsx` | 单元测试       |        396 行        |               ✅ 新建并通过（10/10 tests pass）               |

门禁复核输出：

```text
[check-line-counts] Starting RL-03 Line Budget Verification...
  ✅ [PASS] apps/crish-desktop/src/contexts/LeafScopeContext.tsx (UI Component: 140/500 lines)
  📦 [BASELINE] apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx (UI Component: 476/500 lines)
  📦 [BASELINE] apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx (UI Component: 408/500 lines)
  ✅ [PASS] apps/crish-desktop/src/components/binary-tree/treeLeafPanelModel.ts (UI Component: 84/500 lines)
  ✅ [PASS] apps/crish-desktop/src/builtinViewFactories.tsx (UI Component: 89/500 lines)
  ✅ [PASS] apps/crish-desktop/src/components/chat-card/useScopedSessionField.ts (UI Component: 79/500 lines)
[check-line-counts] Summary: Scanned: 6 files, Warnings: 0, Violations: 0, Hard blocks: 0
```

---

## 二、 核心改造落地详情

### 1. `LeafScopeProvider` 全量包裹叶子树（支柱一）

在 `TreeLeafPanel.tsx` 中，使用 `<LeafScopeProvider leafId={leaf.id} sessionId={effectiveSessionId} isActive={isActive} leafRootRef={leafElRef} openTool={handleOpenTool}>` 包裹整个分屏叶子内容（包括顶栏 `PaneHeader`、主聊天区 `leafChatColumn`、右侧抽屉 `leafDockDrawer` 及侧栏快捷触发按钮）。  
深层子组件（如 `ChatCard`、`FilesCard`、`PreviewCard`、`OverviewCard`、`ComposerFusedTrigger` 等）无需逐层 prop drilling，调用 `useLeafScope()` / `useScopedSessionId()` 即可天然获取本分屏上下文。

### 2. 草稿态单一真理源收敛（B-01 SSOT）

彻底废除此前依赖全局 `activeSessionId === mintDraftSessionId(leaf.id) || (isPendingDraft(activeSessionId) && leaf.activeTabId === '')` 的全局耦合判定：

- 在 `treeLeafPanelModel.ts` 中以纯函数 `isLeafInDraftMode(leaf)` 为唯一真理：
  $$\text{isLeafDraft} \iff \text{readActiveTabId(leaf) === ''} \lor \text{readLeafTabs(leaf).length === 0}$$
- 在 `TreeLeafPanel.tsx` 与 `PaneHeader.tsx` 中全量接入 `isLeafInDraftMode(leaf)`；
- 处于草稿态时，绑定会话稳定为 `effectiveSessionId = mintDraftSessionId(leaf.id)`（即 `__pending_draft__:${leaf.id}`）；
- 当用户在其他分屏切换焦点、改变全局 `activeSessionId` 时，当前分屏草稿态 100% 维持不变，草稿输入内容不丢，绝不折叠或回退到 `tabs[0]`。

### 3. 捕获阶段焦点自动激活（A-01）与白名单排除（Guard-2）

在 `TreeLeafPanel` 根 DOM 节点挂载：

- `onPointerDownCapture={handleCaptureActivate}`
- `onFocusCapture={handleCaptureActivate}`

**激活守卫规则**：

1. **销毁类按钮排除白名单**：
   通过 `target.closest('[data-tab-close], [data-pane-close], [data-prevent-leaf-activate="true"], button[aria-label*="关闭"], button[title*="关闭"]')` 检测销毁类动作。当用户点击标签页关闭按钮或分屏关闭按钮时，跳过激活，允许关闭后台标签页而不抢夺当前激活分屏的打字焦点；
2. **幂等性守卫**：
   若当前叶子已经是全局激活叶（`isActive && currentActiveLeafId === leaf.id && currentActiveSessionId === effectiveSessionId`），立即返回，避免无效 Store dispatch 与重渲染；
3. **交互即激活**：
   对于除销毁按钮外的任何交互（如点击输入框、点击发送按钮、在富文本中聚焦、点击批注、点击工具面板等），在事件下发到子组件之前的捕获阶段同步分派：
   - `useLayoutTreeStore.getState().setActiveLeaf(leaf.id)`
   - `useSessionStore.getState().setActiveSessionId(effectiveSessionId)`（草稿态分派 `enterDraftMode`）
   - `sessionShell().activateTab(leaf.id, tabId)` / `focusLeaf(leaf.id)` 同步 Shell。

### 4. `builtinViewFactories.tsx` 10 个视图工厂全量透传上下文

更新 10 个视图工厂：

- `chat`: 透传 `sessionId={ctx.sessionId}`、`handleGlobalTabClick={ctx.openView}`；
- `terminal`: 透传 `sessionId={ctx.sessionId}`、`panelId={ctx.panelId}`；
- `preview`: 透传 `initialTarget`、`sessionId={ctx.sessionId}`、`leafId={ctx.leafId}`；
- `overview`: 透传 `onOpenPanel={ctx.openView}`（组件内天然继承 `LeafScopeContext`）；
- `files`: 透传 `sessionId={ctx.sessionId}`、`leafId={ctx.leafId}`；
- `diff`: 接收 `ctx: ViewRenderContext`（组件内天然继承 `LeafScopeContext`）；
- `runtime`: 接收 `ctx: ViewRenderContext`（组件内天然继承 `LeafScopeContext`）；
- `agent`: 透传 `parentSessionId={ctx.sessionId}`；
- `flow-dag`: 接收 `ctx: ViewRenderContext`（组件内天然继承 `LeafScopeContext`）；
- `file-viewer`: 透传 `FileViewerCardView`（内部渲染带 `ctx.sessionId` 与 `ctx.leafId` 的 `FileViewerCard`）。

### 5. `useScopedSessionField.ts` 解除全局焦点耦合与性能优化（A-10）

- 优先通过 `useScopedSessionId(explicitSessionId)` 解析 `sid`；
- 若传入函数 `(st) => ...` 返回了全局 `st.activeSessionId`，但在 `LeafScopeContext` 内存在本叶专属会话 ID，优先收敛为本叶专属 ID；
- 移除旧代码中的 `&& prev.activeSessionId === st.activeSessionId` 强制关联；
- 会话级短路条件收敛为：
  ```ts
  if (
    cached &&
    cached.sid === sid &&
    prevSid === sid &&
    cached.session === session
  ) {
    return;
  }
  ```
- 引入 `Object.is(cached.value, nextValue)` 比较，进一步避免同一会话非关键字段变更引起的组件重渲染。

---

## 三、 验证矩阵与自动化测试结果

### 1. `LeafScopeContext.test.tsx`（14/14 通过，耗时 38ms）

```text
 ✓  unit  apps/crish-desktop/src/contexts/__tests__/LeafScopeContext.test.tsx (14 tests) 38ms
   ✓ useLeafScope: 在未包裹 Provider 时返回默认作用域
   ✓ useLeafScope: 在包裹 Provider 时返回真实叶子作用域
   ✓ useLeafScope: queryWithinLeaf 优先在 leafRootRef 子树内查找
   ✓ useLeafScope: queryWithinLeaf 在 leafRootRef 为空时通过 data-leaf-id 查找
   ✓ useScopedSessionId: explicitSessionId 拥有最高优先级
   ✓ useScopedSessionId: Provider 内优先使用 provider.sessionId
   ✓ useScopedSessionId: 未包裹 Provider 自动回退全局 store.activeSessionId
   ✓ useScopedSessionId: 显式传入空字符串或 null 依次向下回退
   ✓ shouldConsumeScopedEvent: sessionId 严格匹配
   ✓ shouldConsumeScopedEvent: leafId 严格匹配
   ✓ shouldConsumeScopedEvent: Guard-1 存量单测无 sessionId 时回退全局 store 比对
   ✓ shouldConsumeScopedEvent: Guard-1 存量脱水单测 store 为空时放行
   ✓ shouldConsumeScopedEvent: 无目标广播仅由 isActive===true 消费
   ✓ shouldConsumeScopedEvent: 无目标且无 isActive 回退 store 比对
```

### 2. `TreeLeafPanel.isolation.test.tsx`（10/10 通过，耗时 489ms）

```text
 ✓  unit  apps/crish-desktop/src/components/binary-tree/__tests__/TreeLeafPanel.isolation.test.tsx (10 tests) 489ms
   ✓ 支柱一与支柱二：isLeafInDraftMode 以 activeTabId==='' 或 tabs.length===0 为唯一真理
   ✓ 支柱一与支柱二：草稿态分屏不受全局 activeSessionId 切换影响，维持草稿 ID 不变
   ✓ 支柱一与支柱二：TreeLeafPanel 渲染草稿分屏时容器 data-session-id 稳定为 __pending_draft__:${leaf.id}
   ✓ 支柱二：在非激活分屏点击输入框或发送按钮时，捕获阶段自动同步 activeLeaf 与 activeSessionId (A-01)
   ✓ 支柱二：点击 [data-tab-close] 销毁按钮时跳过激活，不抢夺前台焦点 (Guard-2)
   ✓ 支柱二：点击 [data-prevent-leaf-activate="true"] 时跳过激活 (Guard-2)
   ✓ 支柱二：点击 title="关闭面板" 按钮时跳过激活 (Guard-2)
   ✓ 支柱二：幂等短路：若当前叶子已激活且 activeSessionId 已对齐，不重复触发 store dispatch (Guard-2)
   ✓ 支柱一：子树内的组件无需 prop drilling 即可通过 useLeafScope 读取本叶作用域
   ✓ A-10：非激活分屏的 useScopedSessionField 在切换全局 activeSessionId 时严格短路不重算
```

### 3. `useChatCardState.scoped.test.tsx`（4/4 通过，耗时 24ms）

```text
 ✓  unit  apps/crish-desktop/src/components/chat-card/useChatCardState.scoped.test.tsx (4 tests) 24ms
   ✓ 非活跃会话 patch：selector 不重求值、组件不重渲染
   ✓ 活跃会话 patch：正常重求值与重渲染
   ✓ activeSessionId 变更（prop 缺省）→ 重求值（sid 解析随 active 切换）
   ✓ 消息正文变更但引用未变与同值场景不重复求值
```

---

## 四、 关键审计发现（供主控 Agent 在 Phase 4 收尾波参考）

### 关于历史测试 `TreeLeafPanel.gesture-fix.test.tsx` 的断言契约漂移说明

在运行全量单测时发现，历史测试 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.gesture-fix.test.tsx`（提交 `677648a68`）的 4 个用例出现红灯：

- **断言内容**：该测试在断言 1.1、1.2、1.3、2.1 中期望「在非激活叶子中点击按钮/输入框时，`setActiveLeafSpy` 绝不触发（`expect(setActiveLeafSpy).not.toHaveBeenCalled()`）」。
- **根因推演**：该测试编写于此前引入 5 行交互元素黑名单（`target.closest('button, input, textarea, ...')` 返回 `return`）时期；该黑名单正是全景审计报告中指出的 **A-01 核心病灶**（导致用户在非激活分屏点击输入框打字、粘贴、发送时焦点未同步，操作全部穿透到旁窗）。
- **新契约**：按照 A-01 解决方案与支柱二「捕获阶段焦点自动激活（交互即激活）」铁律，除销毁类关闭按钮外，在非激活分屏中进行任何交互均**应当且必须**同步 `setActiveLeaf` 与 `activeSessionId`。
- **主控建议**：因 `TreeLeafPanel.gesture-fix.test.tsx` 位于维度 01 独占范围之外，本 Agent 严格遵守纪律未越界修改该文件。建议主控 Agent 在 Phase 4 全量收尾与契约同步时，将该测试中的 `expect(setActiveLeafSpy).not.toHaveBeenCalled()` 更新为对齐 A-01 的正向激活断言 `expect(setActiveLeafSpy).toHaveBeenCalledWith(leaf.id)`。
