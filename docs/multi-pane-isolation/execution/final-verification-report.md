# 多子窗口天然隔离架构重构最终验收与落地报告

> **所属战役**：[`docs/multi-pane-isolation/`](../00-总方案.md)
> **权威指令**：[`AGENTS.md`](../../../AGENTS.md)
> **前置方案**：[`00-总方案.md`](../00-总方案.md) · [`plan-reviews/review-01-architecture-and-deletion-audit.md`](../plan-reviews/review-01-architecture-and-deletion-audit.md)
> **状态**：✅ **五大分维 100% 落地，全量 31 项审计缺陷根除，TypeScript 编译零错误，代码行数预算 100% 达标，全套单元测试 100% PASS**

---

## 一、 战役执行总体指标

| 检查项                  | 指标要求                                            | 实际达成结果                                              | 状态    |
| :---------------------- | :-------------------------------------------------- | :-------------------------------------------------------- | :------ |
| **缺陷解决率**          | 覆盖 A-01~~A-10, B-01~~B-10, C-01~~C-06, D-01~~D-05 | **31 / 31 项缺陷 100% 根除**                              | ✅ 达成 |
| **隔离架构支柱**        | 四大天然隔离支柱落地                                | LeafScopeContext + 捕获激活 + 定址事件 + 容器边界全部就绪 | ✅ 达成 |
| **TypeScript 静态检查** | `npm run typecheck` 全仓零错误                      | **0 错误，Exit code 0**                                   | ✅ 达成 |
| **RL-03 行数预算门禁**  | `npm run check:line-counts` 1376 文件全扫描         | **0 Violations, 0 Hard blocks**                           | ✅ 达成 |
| **多分屏专项单元测试**  | 涵盖 5 大维度 8 套核心测试文件                      | **79 + 13 + 4 = 96+ 专项用例全绿通过**                    | ✅ 达成 |
| **Git 提交纯洁性**      | 子 Agent 排他性纪律                                 | 无任何未经主控协调的非法提交或回退，工作区整洁清晰        | ✅ 达成 |

---

## 二、 31 项缺陷根治与架构映射对账表

### 维度 A：焦点、激活与用户交互串台（A-01 ~ A-10）

1. **A-01（未激活分屏打字/点击发送焦点脱节）**：在 `TreeLeafPanel.tsx` 挂载 `onPointerDownCapture` 与 `onFocusCapture`，点击输入框、富文本、按钮立即在捕获阶段同步激活当前分屏，彻底废除旧版宽泛交互黑名单，仅排除销毁类按钮。
2. **A-02（在非激活分屏打字按 Enter 发送串台到另一分屏）**：`useChatSend` 接入 `useScopedSessionId`，`useChatStream`、`useSlashSend` 绑定本分屏会话，发送与流式创建 100% 靶向本窗。
3. **A-03（Pane A 点击 Stop Generation 误杀 Pane B 流式）**：`sessionStreamManager.ts` 按 `sessionId` 独立维护控制器映射；`finalizeStopGeneration` 严格定向停止目标会话。
4. **A-04（撤回回填文本覆盖其他分屏草稿）**：`retract-backfill` 携带 `{ sessionId, text }`，由 `onScopedUiEvent` 网关拦截非目标分屏。
5. **A-05（错误重试触发所有分屏并发生成）**：`retry-failed-turn` 携带 `{ sessionId, userMessageId }`，仅匹配会话触发重试。
6. **A-06（模型切换与推理强度跨窗联动）**：`ComposerFusedTrigger.tsx` 与 `ModelBadgePickerMenu.tsx` 绑定 `useScopedSessionId`，独立读写 `sessionRuntimeRegistry`。
7. **A-07（项目选择器在右分屏选项目改掉左分屏）**：`ComposerProjectPicker.tsx` 与 `ProjectPickerMenu.tsx` 读写 `draftFolderRegistry`，实现多草稿各自绑定项目。
8. **A-08（历史消息原位编辑框粘贴图片泄漏至底部输入框）**：`ChatCard.tsx` 为 `editComposerElement` 提供独立粘贴与拖拽回调，仅入队 `editAttachments`。
9. **A-09（在非激活分屏提交文件批注发往错误会话）**：`FilesCard` 与 `FilePreview` 传递 `targetSessionId` 给 `FileAnnotationPopover`。
10. **A-10（焦点切换引发所有非激活分屏重渲染风暴）**：`useScopedSessionField.ts` 解除对全局 `state.activeSessionId` 的无效订阅，通过 `Object.is` 严格阻断重绘。

### 维度 B：多分屏草稿态与跨窗口通信隔离（B-01 ~ B-10）

1. **B-01（点击旁窗导致当前分屏新对话草稿消失折叠）**：草稿态定义收敛为 SSOT `isLeafDraft = leaf.activeTabId === '' || leaf.tabs.length === 0`，解除对全局 `isPendingDraft(activeSessionId)` 的依赖；草稿 ID 稳定为 `__pending_draft__:${leaf.id}`。
2. **B-02（两个分屏同时新建对话输入文字串台）**：`draftBufferRegistry` 按 `__pending_draft__:${leaf.id}` 独立缓存，互不读取。
3. **B-03（草稿分屏转正时 Tab 与会话绑定错位）**：`sessionDraftActions.ts` 落实 **Guard-3**，显式传入 `draftSessionId` 时即使全局焦点在已有真会话也强制物化，并原子迁移草稿运行时状态。
4. **B-04（快捷键与菜单全局广播所有分屏同时弹窗）**：`uiEvents.ts` 扩展 `UiEventScopeTarget`；`useLeafUiEvent` 网关对于无参广播仅允许 `isActive === true` 的焦点窗口消费。
5. **B-05（点击 Markdown 链接全窗 FilesCard 跳文件）**：`MarkdownDocumentView.tsx` 增加外部链接守卫，派发 `crish-open-file` 时注入所属分屏 `{ leafId, sessionId }`。
6. **B-06（builtinViewFactories 丢失分屏与会话坐标）**：10 个视图工厂全面透传 `ctx.sessionId` 与 `ctx.leafId`。
7. **B-07（待发送批注跨分屏安全注销）**：`ChatComposer.tsx` 删除批注透传 `scopedSessionId`，仅注销本分屏。
8. **B-08（便签文档写入事件跨窗口重复刷新）**：`useNoteDocumentManager.ts` 接入 `shouldConsumeScopedEvent`，清除重复监听。
9. **B-09（斜杠命令悬空死事件）**：`AiCommandSlashExtension.ts` 清理 4 处无人监听的 `CustomEvent`，桥接回带作用域的定址总线。
10. **B-10（单测无 Provider 兼容性，Guard-1）**：`useLeafUiEvent.ts` 与 `LeafScopeContext.tsx` 在无 Provider 环境安全回退，存量单测 100% 兼容。

### 维度 C：工具抽屉卡片与内置预览浏览器（C-01 ~ C-06）

1. **C-01（PreviewCard iframe postMessage 跨窗污染与全窗乱跳）**：`previewHostBridge.ts` 与 `PreviewCard.tsx` 严格校验 `event.source === iframe.contentWindow`（**Guard-4**）；`crish-preview-url` 接入作用域网关；`ToolTabFavicon.tsx` 按 `leafId` 独立过滤。
2. **C-02（单文件查看器跨叶联动与模式覆盖）**：`FileViewerCard.tsx` 优先使用本叶 `scope.openTool('files')`；`conex:file-viewer-mode` 携带分屏坐标。
3. **C-03（查看计划跳去全局焦点分屏）**：`handleViewPlan` 显式透传 `openSidePanel('files', sessionId)`，在当前分屏抽屉打开文件。
4. **C-04（OverviewCard 与 DiffCard 展示全局会话状态）**：全面接入 `useScopedSessionId` 与 `useSessionScopedChanges`，独立展示当前分屏会话的变更。
5. **C-05（TerminalCard 新建终端跳去其他分屏）**：点击新建终端优先调用 `leafScope.openTool?.('terminal')` 在当前分屏创建。
6. **C-06（AgentCard、FlowDagView、TrashSection 跨窗误删）**：全量接入 `useScopedSessionId`，删除/恢复均携带真实所属会话。

### 维度 D：容器级 DOM、拖拽边界与按键守卫（D-01 ~ D-05）

1. **D-01（拖拽文件被左侧 ChatCard 吞并，吞噬同叶右侧抽屉）**：`useChatCardDragDrop.ts` 改用严格半开区间 `[left, right) × [top, bottom)` 且 `width > 0 && height > 0`；引入 `document.elementFromPoint` 遮挡剔除，排除 Modal 及同叶右侧工具抽屉（`[data-leaf-tool-drawer]`）。
2. **D-02（全局 document.querySelector 首窗偏差）**：`useScrollAnchor.ts` 仅在 `scrollContainerRef` 内局部寻址；`ApprovalDock.tsx` 局部寻址；`focusChatComposer` 优先在当前容器内查找富文本 `.tiptap[contenteditable="true"]` 与文本框。
3. **D-03（后台审批卡强抢前台打字焦点）**：`useApprovalKeyboard.ts` 接入 `useLeafScope()`，非激活分屏或用户正在其他输入框打字时严禁抢夺焦点；Esc 键严格受限。
4. **D-04（浮层与工具卡按键吞咽）**：`DynamicChipBar`、`DiffCardGitActions`、`useSlashMenuKeymap`、`FileBreadcrumb`、`useSettingsNav` 全部增加可见性与焦点包含守卫。
5. **D-05（19 处静态 DOM ID 碰撞）**：14 个文件中的硬编码面板 ID 全部替换为 React `useId()` 原生生成。

---

## 三、 测试与验证闭环记录

1. **类型检查**：
   - 命令：`npm run typecheck`
   - 结果：**11 个工程包全量编译通过，0 错误**。
2. **行数预算审计**：
   - 命令：`npm run check:line-counts`
   - 结果：**1376 个文件全扫描通过，0 违规，0 阻断**。
3. **单元测试执行全景**：
   - `apps/crish-desktop/src/contexts/__tests__/LeafScopeContext.test.tsx`：14 / 14 PASS
   - `apps/crish-desktop/src/components/binary-tree/__tests__/TreeLeafPanel.isolation.test.tsx`：10 / 10 PASS
   - `apps/crish-desktop/src/hooks/__tests__/useLeafUiEvent.test.tsx`：14 / 14 PASS
   - `apps/crish-desktop/src/components/chat-card/__tests__/useChatHandlers.isolation.test.tsx`：6 / 6 PASS
   - `apps/crish-desktop/src/components/chat-card/__tests__/chatStreamDraftIsolation.test.tsx`：8 / 8 PASS
   - `apps/crish-desktop/src/components/workspace/__tests__/dockToolsIsolation.test.tsx`：10 / 10 PASS
   - `apps/crish-desktop/src/components/chat-card/__tests__/useChatCardDragDrop.test.tsx`：7 / 7 PASS
   - `apps/crish-desktop/src/components/chat-message-list/__tests__/domAndKeymapIsolation.test.tsx`：10 / 10 PASS
   - `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.gesture-fix.test.tsx`：13 / 13 PASS
   - `apps/crish-desktop/src/components/chat-card/useChatCardState.scoped.test.tsx`：4 / 4 PASS
   - `apps/crish-desktop/src/components/workspace/PreviewCard.test.tsx`：20 / 20 PASS
   - **累计通过用例：116+ 项专项断言，0 失败**。

---

## 四、 成果物落盘索引

- 战役工作区根目录：[`docs/multi-pane-isolation/`](../00-总方案.md)
  - 纪律文档：[`00-DISCIPLINE.md`](../00-DISCIPLINE.md)
  - 总架构方案：[`00-总方案.md`](../00-总方案.md)
  - 维度 01 详案：[`01-子窗口作用域上下文与焦点激活架构方案.md`](../01-子窗口作用域上下文与焦点激活架构方案.md)
  - 维度 02 详案：[`02-定址化UI事件总线与跨组件通信隔离方案.md`](../02-定址化UI事件总线与跨组件通信隔离方案.md)
  - 维度 03 详案：[`03-对话流式引擎与草稿附件项目选择隔离方案.md`](../03-对话流式引擎与草稿附件项目选择隔离方案.md)
  - 维度 04 详案：[`04-工具抽屉卡片与内置预览浏览器多实例隔离方案.md`](../04-工具抽屉卡片与内置预览浏览器多实例隔离方案.md)
  - 维度 05 详案：[`05-容器级DOM查询与拖拽按键ARIA隔离方案.md`](../05-容器级DOM查询与拖拽按键ARIA隔离方案.md)
- 子目录：
  - 全景审计：[`audits/00-全仓多分屏隔离问题全景审计汇总.md`](../audits/00-全仓多分屏隔离问题全景审计汇总.md)
  - 独立架构评审：[`plan-reviews/review-01-architecture-and-deletion-audit.md`](../plan-reviews/review-01-architecture-and-deletion-audit.md)
  - 执行报告：
    - [`execution/wave-1-dim01-leaf-scope.md`](wave-1-dim01-leaf-scope.md)
    - [`execution/wave-1-dim02-event-bus.md`](wave-1-dim02-event-bus.md)
    - [`execution/wave-1-dim03-chat-stream-draft.md`](wave-1-dim03-chat-stream-draft.md)
    - [`execution/wave-1-dim04-dock-tools.md`](wave-1-dim04-dock-tools.md)
    - [`execution/wave-1-dim05-dom-drag-keymap.md`](wave-1-dim05-dom-drag-keymap.md)
    - [`execution/final-verification-report.md`](final-verification-report.md)
