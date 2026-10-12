# 多子窗口（Split-Pane）天然隔离架构重构 — 独立架构评审与契约/清退审计报告

> **评审角色**：独立架构评审与契约审计官（Review Agent）  
> **评审对象**：[`00-DISCIPLINE.md`](../00-DISCIPLINE.md)、[`audits/00-全仓多分屏隔离问题全景审计汇总.md`](../audits/00-全仓多分屏隔离问题全景审计汇总.md)、[`00-总方案.md`](../00-总方案.md)、[`LeafScopeContext.tsx`](../../../apps/crish-desktop/src/contexts/LeafScopeContext.tsx)、[`useLeafUiEvent.ts`](../../../apps/crish-desktop/src/hooks/useLeafUiEvent.ts) 及五大分维重构契约  
> **对标基线**：[`AGENTS.md`](../../../AGENTS.md) §1/§7/§8/§11、[`.agents/LOGIC_PLAN_NO_RETREAT.md`](../../../.agents/LOGIC_PLAN_NO_RETREAT.md)、[`ANTI_OVERENGINEERING_GUARDRAILS.md`](../../../ANTI_OVERENGINEERING_GUARDRAILS.md)  
> **总体裁决**：**通过（PASS WITH MANDATORY CONTRACT GUARDS）**——四大隔离支柱与五大正交文件域从根因上终结了「隐式全局 `activeSessionId`」、「指针/焦点与激活叶脱节」、「无寻址全局事件广播」与「越界全局 DOM 查询/监听」四大架构病灶。报告同时给出 **4 项跨维契约强制护栏（Contract Guards）** 与 **旧债/死代码净清退清单**，供 Phase 3 各实现波次刚性落地。

---

## 一、 构造即隔离（By-Construction Isolation）全量缺陷覆盖完备性评估

> **核对说明**：全景审计报告 [`audits/00-全仓多分屏隔离问题全景审计汇总.md`](../audits/00-全仓多分屏隔离问题全景审计汇总.md) 共包含 **31 项编号缺陷**（`A-01 ~ A-10` 共 10 项、`B-01 ~ B-10` 共 10 项、`C-01 ~ C-06` 共 6 项、`D-01 ~ D-05` 共 5 项）。下表逐项核对每项缺陷的根因、归属支柱、负责分维、收敛机制及潜在死角审查结果。

### 1.1 维度 A：`ChatCard` / `ChatComposer` 与流式主链路（A-01 ~ A-10）

| 缺陷编号 | 源码精确位置                                                                                                                                                                                        | 归属隔离支柱                                            | 落地分维          | 构造即隔离收敛机制                                                                                                                                                                                                                                                                                                                           | 完备性裁决与潜在死角提示                                                                                                                                                                                                                                                                                                                                 |
| :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------ | :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-01** | `components/chat-card/useChatComposerProps.ts:36-41`<br>`components/chat-card/useChatSend.ts:32-55`<br>`hooks/chat-stream/useSlashSend.ts:71, 106`<br>`components/chat-card/useChatHandlers.ts:193` | 支柱一 (`LeafScopeContext`) + 支柱二 (捕获自动激活)     | 维度 01 + 维度 03 | 1. `TreeLeafPanel` 在捕获阶段先行激活所属叶子；<br>2. `useChatComposerProps` → `useChatSend` → `useChatStream` → `useSlashSend` 全链路显式透传 `scopedSessionId = useScopedSessionId(sessionId)`，不再回退读取全局 `activeSessionId`。                                                                                                       | ✅ **完备**。需确保行内重编辑发送 `useChatHandlers.ts:193` 同样传入当前卡片的 `scopedSessionId`。                                                                                                                                                                                                                                                        |
| **A-02** | `hooks/chat-stream/useStreamCallbacks.ts:70-111`<br>`hooks/chat-stream/useStreamBatchers.ts:32`                                                                                                     | 支柱一 (`LeafScopeContext`) + 支柱三 (`useLeafUiEvent`) | 维度 02 + 维度 03 | 1. `SessionStreamManager` 提升为模块级按 `sessionId` 寻址的共享注册表（或通过 `sessionId` 定向查找）；<br>2. `finalizeStopGeneration(force, targetSessionId?)` 优先停止本叶 `scopedSessionId`；<br>3. 无参全局 `stop-generation` 事件经 `useLeafUiEvent` 仅由 `isActive === true` 的焦点子窗口消费，且非流式窗口不走 `!cur` 误发兜底 Toast。 | ⚠️ **需加护栏（见 §2.2 Guard-2）**：`renderBufferRef` 在单 `ChatCard` 内为实例级（每个 `ChatCard` 绑定一个 `sessionId`），但若跨窗口调用停止，必须通过该 `sessionId` 所属 `ChatCard` 实例或共享句柄触发 `flushFinal()`，防止跨实例 `renderBufferRef` 为空导致残余文本未刷入。                                                                            |
| **A-03** | `components/binary-tree/TreeLeafPanel.tsx:85-91`<br>`components/binary-tree/PaneHeader.tsx:112-116`<br>`components/binary-tree/treeLeafPanelModel.ts:38-50`                                         | 支柱二 (草稿态 SSOT)                                    | 维度 01           | 废除 `activeSessionId === mintDraftSessionId(leaf.id) \|\| (isPendingDraft(activeSessionId) && leaf.activeTabId === '')` 对全局 `activeSessionId` 的依赖；以叶子自身 `leaf.activeTabId === '' \|\| readLeafTabs(leaf).length === 0` 为 `isLeafDraft` 唯一真理源（SSOT）。                                                                    | ✅ **完备**。彻底消除点击另一分屏时本分屏草稿界面消失跳回 `tabs[0]` 的问题。                                                                                                                                                                                                                                                                             |
| **A-04** | `hooks/chat-stream/slashSendDraftManager.ts:129-163`<br>`store/sessionDraftActions.ts:98-123`                                                                                                       | 支柱一 + 支柱二                                         | 维度 03           | `resolveTargetSessionId(targetSessionId, rawInput)` 与 `commitDraftAndOpenShell({ draftSessionId, title, folder })` 接收显式 `draftSessionId`（如 `__pending_draft__:leaf-2`），优先从 `draftFolderRegistry.get(draftSessionId)` 读取项目目录并调用 `promoteDraftTab(draftSessionId, newId, title)` 原地转正该叶标签。                       | ⚠️ **需加护栏（见 §2.2 Guard-3）**：`commitDraftIfNeeded` 内部当前在 `sessionDraftActions.ts:99-107` 仅判断 `isPendingDraft(st.activeSessionId)`。当后台/非全局激活草稿叶直接触发转正时，若 `opts.draftSessionId` 传入了草稿 ID，无论 `st.activeSessionId` 是否为真会话，都必须执行 `createSessionFn` 创建新会话，严禁提前 `return st.activeSessionId`！ |
| **A-05** | `components/chat-card/ProjectPickerMenu.tsx:27-31, 65`<br>`components/chat-card/ComposerProjectPicker.tsx:172-184`<br>`components/chat-card/useChatSessionMeta.ts:71-78`                            | 支柱一 (`useScopedSessionId`)                           | 维度 03           | `ProjectPickerMenu` 与 `ComposerProjectPicker` 通过 `useScopedSessionId()` 获取本叶 `sessionId`；当处于草稿态（`isPendingDraft(scopedSessionId)`）时，同时写入 `draftFolderRegistry.set(scopedSessionId, folder)` 并触发重渲染。                                                                                                             | ✅ **完备**。建议为 `draftFolderRegistry` 增加轻量级版本号订阅或 Zustand slice 映射，确保同叶 `useChatSessionMeta` 立即响应项目名刷新。                                                                                                                                                                                                                  |
| **A-06** | `components/chat-composer/ComposerFusedTrigger.tsx:45, 76-83, 120-128`<br>`components/provider/ModelBadgePickerMenu.tsx:57, 130-151`                                                                | 支柱一 (`useScopedSessionId`)                           | 维度 03           | 将 `useSessionStore(s => s.activeSessionId)` 统一替换为 `useScopedSessionId()`，使思考档位胶囊与模型选择器严格读写所属分屏会话。                                                                                                                                                                                                             | ✅ **完备**。                                                                                                                                                                                                                                                                                                                                            |
| **A-07** | `components/chat-card/ChatCard.tsx:176-177`                                                                                                                                                         | 支柱一 (实例级回调归属)                                 | 维度 03           | 修复行内编辑框 `editComposerElement` 的粘贴回调绑定，使其将粘贴附件写入行内编辑状态而非底部主输入框。                                                                                                                                                                                                                                        | ✅ **完备**。                                                                                                                                                                                                                                                                                                                                            |
| **A-08** | `components/chat-composer/ChatComposer.tsx:166`<br>`api/fileAnnotations.ts:129-133`                                                                                                                 | 支柱一 (`useScopedSessionId`)                           | 维度 03           | `ChatComposer` 移除批注芯片时显式传入 `scopedSessionId` 至 `removeFileAnnotation(id, scopedSessionId)`。                                                                                                                                                                                                                                     | ✅ **完备**。                                                                                                                                                                                                                                                                                                                                            |
| **A-09** | `components/chat-card/useChatHandlers.ts:407-421`                                                                                                                                                   | 支柱一 (`useLeafScope`)                                 | 维度 02 / 维度 03 | `handleBranch` 创建分支会话后，若当前处于 `leafId` 作用域内，调用 shell 在当前 `leafId` 打开并激活新分支 Tab，而非仅修改全局 `activeSessionId`。                                                                                                                                                                                             | ✅ **完备**。注意维度 02（独占 `useChatHandlers.ts`）需包含 `handleBranch` 的本叶 Tab 挂载逻辑。                                                                                                                                                                                                                                                         |
| **A-10** | `components/chat-card/useScopedSessionField.ts:48-55`                                                                                                                                               | 支柱一 (精细化会话订阅)                                 | 维度 01           | 移除 `prev.activeSessionId === st.activeSessionId` 的无条件捆绑短路条件；只要 `resolveSid(state) === resolveSid(prev)` 且 `cached.session === session`，即严格短路，彻底消除切分屏焦点时所有无关分屏的全量重渲染。                                                                                                                           | ✅ **完备**。符合 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 12 的高性能渲染要求。                                                                                                                                                                                                                                                                        |

---

### 1.2 维度 B：UI 事件总线（`uiEvents`）与全局自定义事件广播串扰（B-01 ~ B-10 全量核对）

| 缺陷编号 | 事件名 / 源码位置                                                                                                                                                                                                   | 归属隔离支柱                            | 落地分维          | 构造即隔离收敛机制                                                                                                                                                                                                                                                                                                                   | 完备性裁决与潜在死角提示                            |
| :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------- | :---------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- |
| **B-01** | `'retract-backfill'`<br>`components/chat-card/useChatHandlers.ts:118-123`                                                                                                                                           | 支柱三 (`useLeafUiEvent`)               | 维度 02           | 改用 `useLeafUiEvent('retract-backfill', ...)`（或 `onScopedUiEvent`），由 `shouldConsumeScopedEvent` 自动校验 `detail.sessionId === scopedSessionId`，阻断分屏 A 撤回覆盖分屏 B 输入框草稿。                                                                                                                                        | ✅ **完备**。                                       |
| **B-02** | `'retry-failed-turn'`<br>`components/chat-card/useChatHandlers.ts:398-405`                                                                                                                                          | 支柱三 (`useLeafUiEvent`)               | 维度 02           | 改用作用域事件订阅，严格校验 `detail.sessionId === scopedSessionId`，根除 N 个分屏同时触发 N 次并发重试。                                                                                                                                                                                                                            | ✅ **完备**。                                       |
| **B-03** | `'toggle-msg-filter'` / `'open-project-picker'`<br>`components/chat-card/useChatProjectPicker.ts:44-53, 78-82`                                                                                                      | 支柱三 (`useLeafUiEvent`)               | 维度 02           | 改用 `useLeafUiEvent`；事件可选支持 `{ sessionId?, leafId? }`，无目标载荷时仅 `scope.isActive === true` 的焦点子窗口响应并聚焦。                                                                                                                                                                                                     | ✅ **完备**。                                       |
| **B-04** | `'export-session-md'` / `'open-conversation-rewind'` / `'stop-generation'`<br>`components/chat-card/useChatHandlers.ts:72-108`<br>`components/chat-card/useChatSessionActions.ts:210-213`                           | 支柱三 (`useLeafUiEvent`)               | 维度 02           | 统一接入 `useLeafUiEvent` / `onScopedUiEvent`，支持可选 `{ sessionId?, leafId? }` 定址；快捷键无参广播时仅焦点分屏执行。                                                                                                                                                                                                             | ✅ **完备**。                                       |
| **B-05** | `'crish-open-file'`<br>`components/files/FilesCard.tsx:216-226`<br>`components/chat-card/useChatSessionActions.ts:112, 133`<br>`components/markdown/MarkdownDocumentView.tsx:185-192`                               | 支柱一 (`openTool`) + 支柱三 (定址事件) | 维度 02 + 维度 04 | 1. `useChatSessionActions` 使用本叶 `openTool('files')`（或 `openToolInLeaf(leafId, 'files')`）替代全局 `openToolInActiveTab('files')`，并在 `crish-open-file` detail 中携带 `{ path, leafId, sessionId }`；<br>2. `FilesCard` 校验 `shouldConsumeScopedEvent(ev.detail, scope)`；<br>3. `MarkdownDocumentView` 清理重复无条件派发。 | ✅ **完备**。                                       |
| **B-06** | `'crish-preview-url'` & `'crish-preview-favicon'`<br>`components/workspace/usePreviewNavigation.ts:126, 141-159`<br>`components/binary-tree/ToolTabFavicon.tsx:27-36, 80-81`                                        | 支柱三 + 支柱四                         | 维度 04           | `crish-preview-url` 与 `crish-preview-favicon` 载荷携带 `{ leafId, sessionId, panelId }`；`usePreviewNavigation` 仅消费发给本叶/本实例的外部跳转命令，内部导航不再广播劫持其他分屏 `PreviewCard`；`ToolTabFavicon` 按 `leafId`/`sessionId` 隔离图标更新。                                                                            | ✅ **完备**。                                       |
| **B-07** | `'conex:file-viewer-mode'`<br>`store/workspace-shell/openTool.ts:328-332`<br>`components/files/FileViewerCard.tsx:82-98`                                                                                            | 支柱三 (定址事件)                       | 维度 04           | `openTool.ts` 派发 `conex:file-viewer-mode` 时在 `detail` 中附带 `leafId: activeId`；`FileViewerCard` 校验 `detail.leafId === scope.leafId && detail.canonicalTabId === panelId`。                                                                                                                                                   | ✅ **完备**。                                       |
| **B-08** | `'crish-attachments-changed'`<br>`components/chat-card/useChatAttachments.ts:23, 45, 98-119`                                                                                                                        | 支柱一 + 支柱三                         | 维度 03           | 废除共享静态常量 `'__composer_draft_session__'` 回退，使用 `useScopedSessionId()`（含本叶专属 `__pending_draft__:${leafId}`）；`crish-attachments-changed` 强制携带 `sessionId` 并精确匹配本叶 `scopedSessionId`。                                                                                                                   | ✅ **完备**。                                       |
| **B-09** | `'crish:chat-stop'` / `'crish:chat-clear'` / `'crish:chat-compact'` / `'crish:open-settings'`<br>`components/workspace/PreviewCard.tsx:71`<br>`components/chat-composer/AiCommandSlashExtension.ts:31, 44, 77, 160` | 支柱三 (死事件清退与定址收敛)           | 维度 02 + 维度 04 | 清理无人监听的 `crish:chat-*` 悬空死事件：`PreviewCard.handleStopAi` 改为派发带本叶 `{ sessionId, leafId }` 的 `emitUiEvent('stop-generation', ...)`；`AiCommandSlashExtension` 对齐真实命令总线。                                                                                                                                   | ✅ **完备**。符合 `AGENTS.md` §7.1 死代码清退纪律。 |
| **B-10** | `'conex:note-doc-written'`<br>`components/note-paper/useNoteDocumentManager.ts:117-123`                                                                                                                             | 支柱三 (去重单轨化)                     | 维度 04           | 移除重复的 `window.addEventListener('conex:note-doc-written')` 监听，仅保留单一权威内存订阅 `subscribeNoteDocWritten`，消除每次笔记写入 2 倍重复刷新。                                                                                                                                                                               | ✅ **完备**。                                       |

---

### 1.3 维度 C：右侧工具抽屉视图工厂断链与组件全局耦合（C-01 ~ C-06）

| 缺陷编号 | 模块与源码位置                                                                                                                                                                  | 归属隔离支柱                               | 落地分维 | 构造即隔离收敛机制                                                                                                                                                                                                                                                                                               | 完备性裁决与潜在死角提示                                                                                                                                                          |
| :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------- | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C-01** | `builtinViewFactories.tsx:15-93`<br>`components/binary-tree/TreeLeafPanel.tsx:314-464`                                                                                          | 支柱一 (`LeafScopeContext` + 工厂全量透传) | 维度 01  | 1. `TreeLeafPanel` 根节点包裹 `<LeafScopeProvider leafId={leaf.id} sessionId={sessionForPanel} isActive={isActive} leafRootRef={leafElRef} openTool={handleOpenTool}>`；<br>2. `builtinViewFactories.tsx` 10 个视图工厂全量接收并透传 `ctx: ViewRenderContext`（`sessionId`、`leafId`、`openView`、`panelId`）。 | ✅ **完备**。Context + Props 双保险，使深层子组件无需 prop drilling 即可通过 `useLeafScope()` / `useScopedSessionId()` 拿取本叶上下文。                                           |
| **C-02** | `components/workspace/PreviewCard.tsx:58, 184-204, 251-265`<br>`components/workspace/previewHostBridge.ts:248-272`                                                              | 支柱一 + 支柱四 (源窗口刚性校验)           | 维度 04  | 1. `PreviewCard` 与 `previewHostBridge` 校验 `event.source === iframeRef.current?.contentWindow`；<br>2. `PreviewCard` 使用 `useScopedSessionId()` 替代 `selectActiveSession` 与 `useSessionStore.getState().activeSessionId`，确保「发送到 AI」与流式状态严格绑定本分屏会话。                                   | ✅ **完备**。需注意 `previewHostBridge.subscribeToInspector` 应支持传入 `iframeRef` 或源 `Window` 过滤器，避免多 `PreviewCard` 同时开启 Inspector 时互相串扰（见 §2.2 Guard-4）。 |
| **C-03** | `components/overview/OverviewCard.tsx:41-42`<br>`components/overview/changes/useSessionScopedChanges.ts:23-27`                                                                  | 支柱一 (`useScopedSessionId`)              | 维度 04  | `OverviewCard` 与 `useSessionScopedChanges` 改用 `useScopedSessionId()` 查询 `sessionsById[scopedSessionId]`，使各分屏概览面板与变更文件列表独立锁定本分屏会话。                                                                                                                                                 | ✅ **完备**。                                                                                                                                                                     |
| **C-04** | `components/files/FilePreview.tsx:279-283`<br>`components/files/FileViewerCard.tsx:220-227, 448-451`<br>`components/files/FilesCard.tsx:59, 230`                                | 支柱一 (`useScopedSessionId`)              | 维度 04  | `FilesCard`、`FilePreview`、`FileViewerCard` 通过 `useScopedSessionId()` 传入 `targetSessionId` 给 `FileAnnotationPopover` 与 `countPendingFileAnnotations(scopedSessionId)`。                                                                                                                                   | ✅ **完备**。                                                                                                                                                                     |
| **C-05** | `components/workspace/TerminalCard.tsx:86-89, 118-120`                                                                                                                          | 支柱一 (`useLeafScope`)                    | 维度 04  | `TerminalCard` 点击 `+` 新建终端时优先使用当前叶子 `leafId`（通过 `openNewTerminalInLeaf(leafId)` 或 `scope.openTool`）在当前分屏抽屉打开新终端标签。                                                                                                                                                            | ✅ **完备**。                                                                                                                                                                     |
| **C-06** | `components/agent-card/AgentCard.tsx:48-58`<br>`components/diff/DiffCard.tsx:36-41`<br>`components/workspace/FlowDagView.tsx:131`<br>`components/workspace/TrashSection.tsx:35` | 支柱一 (`useScopedSessionId`)              | 维度 04  | 全部替换 `selectActiveSession` / `activeSessionId` 为 `useScopedSessionId()` 派生的本分屏会话数据。                                                                                                                                                                                                              | ✅ **完备**。                                                                                                                                                                     |

---

### 1.4 维度 D：全局 DOM 查询、拖拽边界、全局按键拦截与重复 DOM `id`（D-01 ~ D-05）

| 缺陷编号 | 问题与源码位置                                                                                                                                                                                                                                                                              | 归属隔离支柱                  | 落地分维          | 构造即隔离收敛机制                                                                                                                                                                                                                                                                                                   | 完备性裁决与潜在死角提示                                                                                                  |
| :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------- | :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| **D-01** | `components/chat-message-list/useScrollAnchor.ts:12-40`                                                                                                                                                                                                                                     | 支柱四 (容器级 DOM 查询)      | 维度 05           | 废除 `findScrollContainer` 首行无条件的 `document.querySelector('[data-chat-scroll-container]')`；优先使用传入的本组件 `scrollContainerRef` / `queryWithinLeaf`，仅在无容器上下文时降级回退。                                                                                                                        | ✅ **完备**。注意 `ChatMessageList` 需将自身的滚动容器 `ref` 或 `useLeafScope().queryWithinLeaf` 接入 `useScrollAnchor`。 |
| **D-02** | `components/chat-card/useChatProjectPicker.ts:54-66`<br>`components/chat-message-row/chatMessageRowUtils.ts:157-167`<br>`components/chat-card/ApprovalDock.tsx:45-67`                                                                                                                       | 支柱四 (容器级 DOM 查询)      | 维度 02 + 维度 05 | 统一使用 `queryWithinLeaf` 或组件本地 `rootRef.current.querySelector` 查找输入框，同时兼容 Tiptap `[contenteditable="true"]` 与 `<textarea>`。                                                                                                                                                                       | ✅ **完备**。                                                                                                             |
| **D-03** | `components/chat-card/useChatCardDragDrop.ts:68-91`                                                                                                                                                                                                                                         | 支柱四 (拖拽边界与遮挡收敛)   | 维度 05           | `isPointInsideTarget` 直接以 `ChatCard` 自身 `.chatBody`（`element`）为边界（不再向上膨胀至 `[data-leaf-id]`），采用半开区间 `[left, right) × [top, bottom)` 且要求 `width > 0 && height > 0`，并结合 `document.elementFromPoint` 验证落点未被右侧抽屉（含最大化 Dock）或顶层 Modal 遮挡。                           | ✅ **完备**。彻底解决拖入同叶右侧 `FilesCard` 被左侧 `ChatCard` 吞并及分屏边界双命中问题。                                |
| **D-04** | `components/chat-card/DynamicChipBar.tsx:199`<br>`components/diff/DiffCardGitActions.tsx:40`<br>`components/note-paper/useSlashMenuKeymap.ts:57`<br>`components/agent-card/useApprovalKeyboard.ts:40, 60`<br>`components/files/FileBreadcrumb.tsx:250`<br>`components/useSettingsNav.ts:93` | 支柱四 (焦点包含守卫)         | 维度 05           | 1. 全局 `keydown` 监听器校验 `containerRef.current?.contains(document.activeElement)` 或所属叶子 `isActive` 且容器可见（`offsetParent !== null`）；<br>2. `useApprovalKeyboard` 仅当所属分屏 `isActive === true` 且当前焦点不在其他输入框（`input / textarea / [contenteditable="true"]`）时才允许自动聚焦审批按钮。 | ✅ **完备**。                                                                                                             |
| **D-05** | `components/overview/*` (8处)<br>`components/workspace/*` (10处)<br>`components/agent-card/AgentBrowsePad.tsx:152`                                                                                                                                                                          | 支柱四 (`useId()` 实例唯一化) | 维度 05           | 将 19 处硬编码静态 DOM `id`（`overview-sec-*`, `rt-sec-*`, `preview-hist-panel`, `agent-browse-pad-grid`）全部替换为 `React.useId()` 动态前缀，确保多分屏并存与 `display: none` 保活时 ARIA 引用 100% 唯一对应。                                                                                                     | ✅ **完备**。                                                                                                             |

---

## 二、 跨维度接口契约一致性与向后兼容性审查

### 2.1 五大维度跨界接口对账表

| 接口 / 契约点                                                                            | 提供方维度                                                           | 消费方维度                 | 契约签名与行为核查                                                                                                                                                                                                                                                                                                                                                                                            |                         一致性状态                          |
| :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------- | :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------: |
| `LeafScopeProvider` / `useLeafScope()` / `useScopedSessionId(explicit?)`                 | **维度 01** (`src/contexts/LeafScopeContext.tsx`)                    | **维度 02 / 03 / 04 / 05** | `useScopedSessionId` 优先级：`explicitSessionId` (非空串) > `scope.sessionId` (`inLeafScope === true` 时) > `useSessionStore(s => s.activeSessionId)`。单窗口或未包裹 `LeafScopeProvider` 的单元测试自动回退全局 store。                                                                                                                                                                                      |                        ✅ 已落盘对齐                        |
| `shouldConsumeScopedEvent(detail, target)` & `useLeafUiEvent(name, handler, overrides?)` | **维度 01 + 维度 02** (`LeafScopeContext.tsx` + `useLeafUiEvent.ts`) | **维度 02 / 03 / 04**      | 事件网关支持 `{ sessionId?, leafId? }` 定址；无目标 ID 的全局快捷键事件按 `target.isActive` 路由，未包裹 Provider 时 `inLeafScope === false` 回退放行。                                                                                                                                                                                                                                                       |        ⚠️ **需补强 1 处单测回退（见 §2.2 Guard-1）**        |
| `UiEventMap` 定址载荷扩展                                                                | **维度 02** (`src/api/uiEvents.ts`)                                  | **维度 02 / 03 / 04**      | `toggle-msg-filter`、`open-project-picker`、`export-session-md`、`open-conversation-rewind`、`focus-composer`、`stop-generation` 在 `UiEventMap` 中当前定义为 `void`。维度 02 需将其扩展为 `{ sessionId?: string; leafId?: string } \| void`（可选载荷），确保无参调用 `emitUiEvent('stop-generation')` 与带参定址调用 `emitUiEvent('stop-generation', { sessionId, leafId })` 同时通过 TypeScript 严格检查。 |                   📌 **维度 02 必做契约**                   |
| `ViewRenderContext` → 10 视图 Props                                                      | **维度 01** (`src/builtinViewFactories.tsx`)                         | **维度 03 / 04**           | `TreeLeafPanel` 已包裹 `LeafScopeProvider`，因此维度 04 的 `FilesCard`、`DiffCard`、`RuntimePanel`、`AgentCard`、`FlowDagView` 即使 Props 不改，内部调用 `useLeafScope()` / `useScopedSessionId()` 也能直接拿到上下文；同时 `builtinViewFactories.tsx` 透传 `ctx` Props 实现双保险。                                                                                                                          |                        ✅ 正交无阻塞                        |
| `commitDraftIfNeeded` & `draftFolderRegistry`                                            | **维度 03** (`sessionDraftActions.ts` + `slashSendDraftManager.ts`)  | **维度 01 / 03**           | 维度 01 的 `TreeLeafPanel` 为草稿叶生成稳定的 `mintDraftSessionId(leaf.id)`（即 `__pending_draft__:${leaf.id}`）注入 `LeafScopeProvider.sessionId`；维度 03 的 `ProjectPickerMenu` 按该 ID 写入 `draftFolderRegistry`，发送时 `resolveTargetSessionId` 按该 ID 提交并原地 `promoteDraftTab`。                                                                                                                 | ⚠️ **需对齐 `commitDraftIfNeeded` 签名（见 §2.2 Guard-3）** |

### 2.2 四项必须落地的跨维契约强制护栏（Mandatory Contract Guards）

在审查已落盘的 [`LeafScopeContext.tsx`](../../../apps/crish-desktop/src/contexts/LeafScopeContext.tsx) 与 [`useLeafUiEvent.ts`](../../../apps/crish-desktop/src/hooks/useLeafUiEvent.ts) 以及存量代码时，发现以下 **4 处微妙的边界契约陷阱**，必须在 Phase 3 实现波中刚性闭合：

#### 🛡️ Guard-1：`shouldConsumeScopedEvent` 在未包裹 `LeafScopeProvider` 的单元测试中的 `eventSessionId` 匹配回退

- **代码位置**：[`LeafScopeContext.tsx:168-177`](../../../apps/crish-desktop/src/contexts/LeafScopeContext.tsx#L168-L177) 与 [`useLeafUiEvent.ts:58-78`](../../../apps/crish-desktop/src/hooks/useLeafUiEvent.ts#L58-L78)
- **问题推演**：
  当存量单元测试直接渲染组件（未包裹 `<LeafScopeProvider>`，故 `scope.inLeafScope === false, scope.sessionId === null`），且组件调用 `useLeafUiEvent('retract-backfill', handler)` 时未传 `overrides.sessionId`，此时 `target.sessionId` 为 `null`。当测试派发 `emitUiEvent('retract-backfill', { sessionId: 'sess-1', text: 'abc' })` 时，[`LeafScopeContext.tsx:175`](../../../apps/crish-desktop/src/contexts/LeafScopeContext.tsx#L175) 的 `if (!target.sessionId) return false;` 会直接拦截丢弃该事件，导致单窗口单元测试挂掉！
- **修复契约**：
  1. 在 `useLeafUiEvent.ts` 中，使用 `const scopedSessionId = useScopedSessionId(overrides?.sessionId);` 作为 `targetRef.current.sessionId` 的默认值（当未包裹 Provider 时自动回退 `useSessionStore(s => s.activeSessionId)`）；
  2. 同时在 [`LeafScopeContext.tsx:174-177`](../../../apps/crish-desktop/src/contexts/LeafScopeContext.tsx#L174-L177) 中，若 `!target.sessionId && !target.leafId`，先尝试读取 `useSessionStore.getState()?.activeSessionId` 比对；若 store 中 `activeSessionId` 也为空（纯脱离 store 的裸测试），则放行返回 `true`。

#### 🛡️ Guard-2：`TreeLeafPanel` 捕获阶段激活的精确排除白名单与幂等守卫

- **代码位置**：[`TreeLeafPanel.tsx:108-131`](../../../apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L108-L131)
- **问题推演**：
  原 `handleActivate` 把 `button, input, textarea, [contenteditable="true"], [role="tab"]` 全部排除，导致非激活分屏交互脱节；但若改为 `onPointerDownCapture` / `onFocusCapture` 全量无差别触发 `activateTab` / `focusLeaf`，会有两个隐患：
  1. 点击**后台分屏的关闭标签按钮**（`[data-tab-close]` / `aria-label*="关闭"`）或**关闭分屏按钮**时，若先触发了 `activateTab`，会把焦点抢到正在关闭的后台分屏；
  2. 点击**标签栏上的非当前 Tab**（`[role="tab"]`）时，`PaneTabItem` 自己的 `onClick` 随后会切换到被点击的 Tab，若捕获阶段用旧的 `readActiveTabId(leaf)` 调了 `activateTab(leaf.id, oldTabId)`，会产生一次向旧 Tab 的多余激活抖动。
- **修复契约**：
  - `onPointerDownCapture` / `onFocusCapture` 仅排除：`[data-tab-close], [data-pane-close], [data-prevent-leaf-activate="true"]`；
  - 若点击目标位于会话标签项 `[data-tab-id]`（且非关闭按钮）上，直接由标签自身的激活逻辑处理或直接激活该 `data-tab-id`；
  - **幂等短路**：若 `isActive === true && activeSessionId === sessionForPanel`，`handleActivate` 立即 `return`，零 Store 写入、零重渲染开销。

#### 🛡️ Guard-3：`commitDraftIfNeeded` 支持显式 `targetDraftSessionId`（解除对 `st.activeSessionId` 的硬编码耦合）

- **代码位置**：[`sessionDraftActions.ts:98-123`](../../../apps/crish-desktop/src/store/sessionDraftActions.ts#L98-L123) 与 [`slashSendDraftManager.ts:129-163`](../../../apps/crish-desktop/src/hooks/chat-stream/slashSendDraftManager.ts#L129-L163)
- **问题推演**：
  在 [`sessionDraftActions.ts:100`](../../../apps/crish-desktop/src/store/sessionDraftActions.ts#L100) 中：
  ```ts
  if (!isPendingDraft(st.activeSessionId)) {
    if (st.activeSessionId && getSessionById(st, st.activeSessionId)) {
      return st.activeSessionId;
    }
  }
  ```
  如果分屏 B 处于草稿态（`__pending_draft__:leaf-B`），因某种异步路径（如行内动作、快捷键或捕获未同步的测试环境）触发发送时 `st.activeSessionId` 仍指向分屏 A 的真实会话 `'sess-A'`，`commitDraftIfNeeded` 会直接返回 `'sess-A'`，把分屏 B 的新对话草稿错误发送进分屏 A！
- **修复契约**：
  - `commitDraftIfNeeded(opts?: { title?: string; folder?: string; draftSessionId?: string })`：当传入 `opts?.draftSessionId` 且 `isPendingDraft(opts.draftSessionId)` 为真时，**强制走新建会话分支**，并优先从 `draftFolderRegistry.get(opts.draftSessionId)` 读取 `folder`，创建完成后清除 `draftFolderRegistry.delete(opts.draftSessionId)`。

#### 🛡️ Guard-4：`previewHostBridge.subscribeToInspector` 必须支持按 `iframe` 源窗口过滤

- **代码位置**：[`PreviewCard.tsx:142-167`](../../../apps/crish-desktop/src/components/workspace/PreviewCard.tsx#L142-L167)
- **问题推演**：
  `PreviewCard.tsx:185` 的 `handleMessage` 和 `142` 行的 `subscribeToInspector` 都是全局 `window.addEventListener('message')`。当左右两个分屏同时打开 `PreviewCard` 时，如果 `subscribeToInspector` 不校验 `event.source === iframeRef.current?.contentWindow`，分屏 A 的 iframe 发送 `INSPECT_HOVER` / `INSPECT_SELECT` / `INSPECT_READY` 会同时触发分屏 B 的 Inspector 浮层和选中卡片！
- **修复契约**：
  - `subscribeToInspector(handler, getIframeWindow?: () => Window | null | undefined)`（或在 `PreviewCard` 侧与 `previewHostBridge` 内部同时校验 `event.source === iframeRef.current?.contentWindow`），当 `getIframeWindow()` 非空时，严格要求 `event.source === expectedWindow`。

---

## 三、 边缘与退化场景魔鬼用例推演（Devil's Advocate Cases）

为验证架构在极端并发与退化状态下的完备性，以下推演 **10 个高危魔鬼用例**，每个用例均给出完整的因果链路与必须满足的**刚性不变量断言（Invariants）**。

### 用例 1：双分屏同时处于 `__pending_draft__` 草稿态，各自选择不同项目并先后发送首条消息

- **前置状态**：左分屏 `leaf-L`（草稿 `__pending_draft__:leaf-L`）选择项目 `Project-Alpha`；右分屏 `leaf-R`（草稿 `__pending_draft__:leaf-R`）选择项目 `Project-Beta`。
- **操作序列**：
  1. 在 `leaf-L` 选 `Project-Alpha`，再在 `leaf-R` 选 `Project-Beta`；
  2. 点击 `leaf-L` 输入 `"Hello Alpha"` 并按 Enter 发送；
  3. 立即点击 `leaf-R` 输入 `"Hello Beta"` 并按 Enter 发送。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{1.1}$：`draftFolderRegistry.get('__pending_draft__:leaf-L') === 'Project-Alpha'` 且 `draftFolderRegistry.get('__pending_draft__:leaf-R') === 'Project-Beta'`，互不覆盖。
  - $\text{Inv}_{1.2}$：`leaf-L` 发送首条消息时，新创建的 `sess-1.folder === 'Project-Alpha'`，且 `promoteDraftTab('__pending_draft__:leaf-L', 'sess-1')` 仅将 `leaf-L` 转正为 `sess-1`；**此时 `leaf-R` 仍保持草稿态界面**（`leaf-R.activeTabId === ''`），绝不跳变或消失。
  - $\text{Inv}_{1.3}$：`leaf-R` 随后发送时，新创建的 `sess-2.folder === 'Project-Beta'`，且 `sess-1 !== sess-2`。

### 用例 2：已有真实会话标签的分屏点击 `+` 新建草稿，未发送前切换到另一分屏操作

- **前置状态**：`leaf-L` 已有标签 `[tab-1 (sess-1)]`，用户点击 `leaf-L` 顶栏 `+` 进入新对话草稿态（`leaf-L.activeTabId = ''`）；`leaf-R` 显示 `sess-2`。
- **操作序列**：用户点击 `leaf-R` 的输入框打字或切换 `leaf-R` 的工具面板。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{2.1}$：`leaf-L` 的 `isLeafDraft` 恒为 `true`（仅由 `leaf-L.activeTabId === ''` 决定，不随全局 `activeSessionId` 变为 `sess-2` 而改变）。
  - $\text{Inv}_{2.2}$：`leaf-L` 主画面保持新对话欢迎页与正在编写的草稿文本，`PaneHeader` 中 `tab-1` 保持未高亮态，绝不自动跳回 `tab-1`。

### 用例 3：非激活分屏直接点击编辑器、`Ctrl+V` 粘贴图片并按 Enter 发送

- **前置状态**：全局焦点在 `leaf-L (sess-1)`；用户鼠标直接点击 `leaf-R (sess-2)` 的 Tiptap 编辑器区域，立即按 `Ctrl+V` 粘贴截图并按 Enter。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{3.1}$：指针按下 `leaf-R` 编辑器的捕获阶段（`onPointerDownCapture`），在 Tiptap 处理 focus/paste 之前，`activeLeafId` 已同步切换为 `leaf-R`，`activeSessionId` 已同步为 `sess-2`。
  - $\text{Inv}_{3.2}$：粘贴生成的图片附件写入 `useChatAttachments(sess-2)`，`crish-attachments-changed` 事件携带 `{ sessionId: 'sess-2' }`，`leaf-L` 附件池为 0。
  - $\text{Inv}_{3.3}$：按 Enter 后，`useSlashSend` 向 `sess-2` 发起流式请求，`sess-1` 消息列表零新增。

### 用例 4：分屏 A 正在流式生成中，用户在分屏 B 按停止快捷键或点击分屏 A 的停止按钮

- **前置状态**：`leaf-A (sess-A)` 正在流式输出；`leaf-B (sess-B)` 处于空闲状态。
- **操作序列**：
  - **子场景 4a**：焦点在 `leaf-B` 时，用户按下全局停止生成快捷键（派发无参 `emitUiEvent('stop-generation')`）；
  - **子场景 4b**：焦点在 `leaf-B` 时，用户直接用鼠标点击 `leaf-A` 气泡/底栏上的「停止」按钮。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{4.1}$（子场景 4a）：无参 `stop-generation` 仅路由至 `isActive === true` 的 `leaf-B`；若 `leaf-B` 无活跃流且无 processing 消息，静默忽略或仅针对 `sess-B` 处理，**绝不误杀后台正在运行的 `sess-A` 流**，且 `leaf-A` 不触发 `!cur` 兜底 Toast。
  - $\text{Inv}_{4.2}$（子场景 4b）：点击 `leaf-A` 的停止按钮时，`leaf-A` 的 `handleStopGeneration` 精确按 `scopedSessionId = 'sess-A'` 从共享 `SessionStreamManager` 中取出 `sess-A` 的流句柄并终止，`sess-B` 不受任何影响。

### 用例 5：关闭后台（非激活）分屏的标签页或关闭分屏自身时，不劫持当前激活分屏的打字焦点

- **前置状态**：用户正在 `leaf-A` 的输入框内连续打字（`document.activeElement` 在 `leaf-A` 的编辑器内）；`leaf-B` 有两个标签 `tab-B1, tab-B2`。
- **操作序列**：用户将鼠标移到 `leaf-B` 的 `tab-B1` 关闭按钮（`×`）上点击关闭。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{5.1}$：`TreeLeafPanel` 的捕获激活守卫识别出点击目标匹配 `[data-tab-close]`，跳过 `activateLeaf(leaf-B)`。
  - $\text{Inv}_{5.2}$：`tab-B1` 被移除后，`activeLeafId` 仍为 `leaf-A`，`activeSessionId` 仍为 `sess-A`，用户继续敲击键盘的字符仍输入在 `leaf-A` 中。

### 用例 6：拖拽外部文件跨过左右分屏分界线，或拖入同叶右侧 `FilesCard` / 最大化抽屉

- **前置状态**：`leaf-L` 展开了右侧工具抽屉 `FilesCard`（占右半边），左侧为 `ChatCard`（`.chatBody`）；右侧还有另一分屏 `leaf-R`。
- **操作序列**：
  1. 拖着文件从 `leaf-L` 的 `.chatBody` 移入同叶右侧的 `FilesCard` 并松手；
  2. 将 `leaf-L` 的右侧抽屉点击「最大化」（遮盖 `.chatBody`），再拖文件到 `leaf-L` 区域松手；
  3. 拖文件恰好停留在 `leaf-L` 与 `leaf-R` 交界线上（`x === rectL.right === rectR.left`）。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{6.1}$：`isPointInsideTarget` 仅检测 `.chatBody` 自身矩形，拖入同叶右侧 `FilesCard` 时 `leaf-L` 的 `ChatCard` `isDragOver === false`，松手不向 `ChatCard` 注入附件。
  - $\text{Inv}_{6.2}$：当右侧抽屉最大化或存在顶层 Modal 遮罩时，`document.elementFromPoint(x, y)` 命中的元素不在 `.chatBody` 内部，`isPointInsideTarget` 返回 `false`。
  - $\text{Inv}_{6.3}$：半开区间 `[left, right) × [top, bottom)` 保证任意物理坐标点 $(x, y)$ 最多命中 **1** 个 `ChatCard`，交界线绝不双命中。

### 用例 7：双 `PreviewCard` 同时加载网页并开启 DOM Inspector 拾取元素 + 点击「发送到 AI」

- **前置状态**：`leaf-A` 的 `PreviewCard` 加载 `http://localhost:3000` 并开启 Inspector；`leaf-B` 的 `PreviewCard` 加载 `http://localhost:5173` 并开启 Inspector。
- **操作序列**：
  1. 在 `leaf-A` 的 iframe 内点击链接触发 `preview:navigate` `postMessage`；
  2. 在 `leaf-A` 的 iframe 内悬停并选中 `<button id="submit">`，点击「发送到 AI」。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{7.1}$：因 `event.source === iframeRef.current?.contentWindow` 严格校验，`leaf-B` 的 `PreviewCard` 不会跟随跳转到 `localhost:3000` 的链接，也不会弹出 `<button id="submit">` 的拾取卡片。
  - $\text{Inv}_{7.2}$：点击 `leaf-A` 的「发送到 AI」后，DOM 摘要被写入 `setComposerDraft(sess-A, text)`，`leaf-B (sess-B)` 的输入框草稿保持原样。

### 用例 8：分屏 A 执行消息撤回（`retract-backfill`）或原位编辑重发时，分屏 B 正在输入长文本

- **前置状态**：用户在 `leaf-B (sess-B)` 的输入框中已编写 500 字草稿（未发送）；在 `leaf-A (sess-A)` 点击上一条用户消息的「撤回」按钮。
- **操作序列**：引擎返回 `timeline-truncate` 并派发 `emitUiEvent('retract-backfill', { sessionId: 'sess-A', text: '旧问题 A' })`。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{8.1}$：`leaf-A` 的 `useLeafUiEvent('retract-backfill')` 匹配 `detail.sessionId === 'sess-A'`，将 `'旧问题 A'` 回填至 `leaf-A` 输入框。
  - $\text{Inv}_{8.2}$：`leaf-B` 的 `useLeafUiEvent('retract-backfill')` 因 `'sess-A' !== 'sess-B'` 在网关层直接短路拦截，`leaf-B` 的 500 字草稿零丢失、零覆盖。

### 用例 9：后台分屏 B 的 Agent 触发工具权限审批（`ApprovalCard`），用户正在前景分屏 A 打字

- **前置状态**：`leaf-B (sess-B)` 在后台运行 Agent 工具调用，弹出工具审批卡片；此时用户正在 `leaf-A (sess-A)` 的输入框中通过 IME 输入中文。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{9.1}$：`leaf-B` 的 `useApprovalKeyboard` 检测到当前叶子 `scope.isActive === false`（且 `document.activeElement` 位于 `leaf-A` 的编辑器内），**严禁执行 `approveBtnRef.current?.focus()`**，绝不打断 `leaf-A` 的 IME 组合输入。
  - $\text{Inv}_{9.2}$：用户在 `leaf-A` 按 `Enter` 或 `Escape` 键时，`leaf-B` 的审批快捷键监听与浮层监听均不拦截该按键。

### 用例 10：单窗口模式与无 `LeafScopeProvider` 包裹的存量单元测试退化兼容

- **前置状态**：存量单元测试直接挂载 `<ChatCard sessionId="test-sid" />`、`<OverviewCard onOpenPanel={fn} />` 或 `<FilesCard />`，外层未包裹 `<TreeLeafPanel>` / `<LeafScopeProvider>`。
- **不变量断言（Invariants）**：
  - $\text{Inv}_{10.1}$：`useLeafScope()` 返回 `DEFAULT_LEAF_SCOPE`（`inLeafScope: false, isActive: true, queryWithinLeaf: document.querySelector`）。
  - $\text{Inv}_{10.2}$：`useScopedSessionId(explicitProp)` 按 `explicitProp ?? globalActiveSessionId` 正常返回，所有单测无需修改测试包装器即可 100% 保持向后兼容通过。

---

## 四、 反过度设计与架构净收敛审计（Deletion & Clean Convergence Audit）

### 4.1 对照 `ANTI_OVERENGINEERING_GUARDRAILS.md` 13 项禁令合规性核查

| 红线条款                                              | 本方案设计核查                                                                                                                                                                       |  合规裁决   |
| :---------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------: |
| **禁令 7：单一真相源 (SSOT)**                         | 1. 子窗口会话归属统一收敛至 `LeafScopeContext` + `useScopedSessionId`；<br>2. 叶子草稿态统一收敛至 `leaf.activeTabId === '' \|\| leaf.tabs.length === 0`，废除多处不一致的派生公式。 | ✅ 完全合规 |
| **禁令 10 / 11：严禁多层洋葱中间件与虚假 Store 套娃** | `shouldConsumeScopedEvent` 是仅 40 行的纯函数网关，`useLeafUiEvent` 直接薄封装于 `onUiEvent` 之上，零中间件流水线、零嵌套序列化、零轮询定时器。                                      | ✅ 完全合规 |
| **禁令 12：严禁高频状态穿透与盲目重渲染**             | 维度 01 修复 `useScopedSessionField.ts:52` 的 `prev.activeSessionId === st.activeSessionId` 耦合，使非关联分屏在焦点切换时 100% 命中缓存短路，减少跨窗无效重渲染。                   | ✅ 完全合规 |
| **`AGENTS.md` §7：严禁打补丁与魔术延时**              | 方案未采用 `setTimeout` 抢焦点或散装 `if (sessionId !== activeSessionId)` 补丁，而是通过 React Context 树 + 捕获阶段激活 + 容器级 `queryWithinLeaf` 原生解决。                       | ✅ 完全合规 |

### 4.2 必须清退的历史债务与死代码清单（Net Deletion Audit）

为实现 `AGENTS.md` §7.1 要求的**架构净收敛（Net Convergence）**，各维度在落地新机制的同时，必须同步清退以下旧债务与死代码：

| 序号 | 待清退的旧债 / 死代码模式                                                                                                                                                     | 精确文件位置                                                                                                       |     负责维度      | 清退后的替代权威路径（SSOT）                                                                                               |
| :--: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- | :---------------: | :------------------------------------------------------------------------------------------------------------------------- |
|  1   | 耦合全局 `activeSessionId` 的旧 `isLeafDraft` 判定式：<br>`activeSessionId === mintDraftSessionId(leaf.id) \|\| (isPendingDraft(activeSessionId) && leaf.activeTabId === '')` | `components/binary-tree/TreeLeafPanel.tsx:86-88`<br>`components/binary-tree/PaneHeader.tsx:113-115`                |      维度 01      | 统一收敛为纯函数 `isLeafInDraftMode(leaf)`（仅判定 `readActiveTabId(leaf) === '' \|\| readLeafTabs(leaf).length === 0`）。 |
|  2   | `TreeLeafPanel.handleActivate` 中长达 5 行的宽泛交互元素黑名单（拦截 `button, input, textarea, [contenteditable="true"]`）                                                    | `components/binary-tree/TreeLeafPanel.tsx:112-118`                                                                 |      维度 01      | 替换为捕获阶段激活 + 仅排除关闭销毁按钮 `[data-tab-close], [data-pane-close], [data-prevent-leaf-activate="true"]`。       |
|  3   | `useScopedSessionField` 中耦合全局焦点切换的条件：<br>`&& prev.activeSessionId === st.activeSessionId`                                                                        | `components/chat-card/useScopedSessionField.ts:52`                                                                 |      维度 01      | 直接删除该条件，仅按本组件解析出的 `sid` 与 `session` 引用相等性短路。                                                     |
|  4   | 4 个全仓无人监听的悬空死事件派发：<br>`crish:chat-stop`、`crish:chat-clear`、`crish:chat-compact`、`crish:open-settings`                                                      | `components/workspace/PreviewCard.tsx:71`<br>`components/chat-composer/AiCommandSlashExtension.ts:31, 44, 77, 160` | 维度 02 + 维度 04 | 彻底删除 `new CustomEvent('crish:chat-*')`，统一改走 `emitUiEvent` 定址事件或真实命令接口。                                |
|  5   | `MarkdownDocumentView` 中重复且无条件触发右侧抽屉的 `crish-open-file` 广播                                                                                                    | `components/markdown/MarkdownDocumentView.tsx:185-192`                                                             |      维度 02      | 删除无条件全局广播，统一经由带 `leafId` 作用域的打开文件动作处理。                                                         |
|  6   | 跨分屏共享的静态草稿附件池常量 `DRAFT_ATTACHMENT_KEY = '__composer_draft_session__'`                                                                                          | `components/chat-card/useChatAttachments.ts:23, 45`                                                                |      维度 03      | 优先使用 `useScopedSessionId()` 提供的本叶唯一草稿 ID `__pending_draft__:${leafId}`，仅在无 `leafId` 的极端退化下兜底。    |
|  7   | `useNoteDocumentManager` 中重复订阅的 DOM 事件 `window.addEventListener('conex:note-doc-written')`                                                                            | `components/note-paper/useNoteDocumentManager.ts:117-123`                                                          |      维度 04      | 删除 DOM 事件监听，仅保留 `subscribeNoteDocWritten` 单一内存订阅通道。                                                     |
|  8   | `useChatCardDragDrop` 中将 `ChatCard` 拖拽目标向上膨胀至整个 `leaf` 的 `element.closest('[data-leaf-id]')`                                                                    | `components/chat-card/useChatCardDragDrop.ts:73`                                                                   |      维度 05      | 删除 `.closest('[data-leaf-id]')`，直接以 `ChatCard` 自身的 `.chatBody` 容器 `element` 为唯一几何边界。                    |
|  9   | `useScrollAnchor` 首行无视参数直接查全文档的 `document.querySelector('[data-chat-scroll-container]')`                                                                         | `components/chat-message-list/useScrollAnchor.ts:13-16`                                                            |      维度 05      | 删除首行无条件全局查询，改为容器 `Ref` / `queryWithinLeaf` 优先。                                                          |
|  10  | 19 处硬编码静态面板/折叠区 DOM `id="..."` 字符串常量                                                                                                                          | `Overview` 6 组件、`Runtime/Workspace` 7 组件、`AgentBrowsePad.tsx:152`                                            |      维度 05      | 全部替换为 `useId()` 实例级唯一 ID。                                                                                       |

---

## 五、 最终审查结论与 Phase 3 放行指令

1. **缺陷覆盖率**：全景审计报告中的 **31/31 项缺陷（100%）** 均已在四大天然隔离支柱与五大分维详案中具备明确的根治落点，无遗漏死角。
2. **并行安全性**：五大分维的独占修改文件域（Write Scope）切分严格正交，无交叉写文件冲突。
3. **放行条件**：Phase 3 各实现波次子 Agent 在编写代码时，必须同步落实本报告 **§2.2 的 4 项跨维契约强制护栏（Guard-1 ~ Guard-4）** 与 **§4.2 的 10 项旧债净清退项**，并以 **§3 的 10 个魔鬼用例不变量** 作为新增跨窗口隔离单元测试的断言标准。
