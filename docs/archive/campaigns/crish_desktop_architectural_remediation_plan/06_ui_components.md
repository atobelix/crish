# 子计划 06：Layer F — UI 组件层深度重构 (React Components)

> **层级编号**：Layer F（Round 5，依赖 Layer E Store 拆分稳定后启动）
> **建议 Agent 数量**：10-12 个
> **涉及维度**：D1（上帝组件）、D3（重复渲染逻辑）、D4（React 18 并发模式问题）、D8（圈复杂度）
> **包路径**：`apps/crish-desktop/src/components/`、`apps/crish-desktop/src/App.tsx`
> **下游依赖方**：Layer G (Performance) 在结构拆分后做性能优化
>
> **本层与其它层的交叉引用**：总览 F-7（useChatStream 拆分）完成后，G-1（SSE 渲染批处理节流）在其拆分子文件中执行。F-2（FilesCard 拆分）完成后，G-1（虚拟滚动内联消除）在拆分出的 `files/FileTree.tsx` 中替换滚动逻辑。F-10（ChatMessageList 拆分）完成后，G-4（Pretext Worker 卸载）在拆分后的子文件中优化渲染管线。

---

## 一、层级目标与文件清单

Layer F 的核心使命是拆分前端上帝组件、消除冗余渲染、优化 React 组件树。

| 编号 | 组件文件 | 行数 | 核心问题 | 职责混合数 |
|------|---------|------|---------|-----------|
| F-1 | [ChatCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/ChatCard.tsx) | 1,602 | 聊天面板上帝组件：流式状态桥接 + Header 工具栏 + 审批逻辑 + Checkpoint | 7 |
| F-2 | [FilesCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/FilesCard.tsx) | 1,629 | 文件管理器上帝组件：27 个 `useState` + 内联 `useVirtualScroll` 重复实现 | 6 |
| F-3 | [DiffCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/DiffCard.tsx) | 1,397 | 变更面板：Git 操作 + Diff 渲染 + 状态管理 | 5 |
| F-4 | [OverviewCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/OverviewCard.tsx) | 1,146 | 总览面板：进度 + Agent 列表 + Git 变更 + 定时任务 | 5 |
| F-5 | [ChatMessageRow.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/ChatMessageRow.tsx) | 1,142 | 消息行：markdown 渲染 + 工具栈 + 操作栏 + 思考面板 | 5 |
| F-6 | [App.tsx](file:///c:/Software/conex/apps/crish-desktop/src/App.tsx) | 1,189 | 根组件：12 个 `useEffect` 引导链 + 全局快捷键 + 双 Chrome 模式 JSX | 8 |
| F-7 | [Sidebar.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/Sidebar.tsx) | ~1,000 | 侧边栏：会话列表 + 搜索 + 文件夹分组 | 4 |
| F-8 | [SkillsSettingsTab.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/SkillsSettingsTab.tsx) | ~1,300 | 技能设置：列表 + 详情 + 编辑 + 文件上传 | 4 |
| F-9 | Settings 面板组 | 多文件 | 6+ 个设置 Tab 各 500-900 行 | 2-3 |
| F-10 | [ChatMessageList.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/ChatMessageList.tsx) | 1,097 | 消息列表：虚拟滚动 + 窗口化 + Pretext 估算 + 固定消息栏 | 6 |

---

## 二、任务 F-1：ChatCard.tsx 深度拆分

### 2.1 内部结构逐行映射

[ChatCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/ChatCard.tsx)（1,602 行）的职责域分布：

| 行范围 | 职责域 | 函数/逻辑块 | 提取目标 |
|--------|--------|------------|---------|
| L1-80 | 导入 + 类型 | 47 个导入项，跨 Store/Hook/API/Component 四层 | 按提取子组件重新分配 |
| L81-180 | Store selector 层 | 18 个 `useLayoutStore` selector（`activeSessionId`, `permissionMode`, `planModeEnabled`, `hideThinkingBlock` 等） | `useChatCardSelectors()` 自定义 Hook |
| L181-280 | 流式状态桥接 | `useChatStream()` 集成 + `isStreaming` / `streamingSessionId` / `thinkingSeconds` 解构 | `ChatStreamController.tsx` |
| L280-420 | Approval 逻辑 | `handleApprovalAllow()` / `handleApprovalDeny()` + `daemonChatBridge` 调用 + `pendingApprovalMsgId` 状态 | `useChatApproval()` Hook |
| L420-560 | Checkpoint/回滚 | `handleCheckpoint()` / `handleRollback()` / `handleRestoreCheckpoint()` + checkpoint 列表管理 | `ChatCheckpointActions.tsx` |
| L560-720 | Provider 检测 | `useEffect` 检测 provider 配置状态 → `providerConfigured` / `showWizard` / 引导 UI | `ChatProviderGuard.tsx` |
| L720-900 | Header 工具栏 | 模型选择器 + 权限模式切换 + 计划模式 + 设置入口 + 状态指示器 | `ChatHeader.tsx` |
| L900-1100 | 消息列表集成 | `ChatMessageList` + `ChatEmptyState` 条件渲染 + 空态逻辑 | 保留在容器中 |
| L1100-1400 | Composer 集成 | `ChatComposer` props 组装 + 附件管理 + `SessionRuntimeRegistry` | `useChatComposerProps()` Hook |
| L1400-1602 | JSX 布局 | 三段式布局（Header + MessageList/Empty + Composer） | 瘦身后保留 |

### 2.2 状态依赖链

```
ChatCard 状态图（关键依赖路径）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
useLayoutStore ──┬── activeSessionId ──→ useChatStream() ──→ isStreaming
                 ├── permissionMode ──→ Approval 逻辑
                 ├── planModeEnabled ──→ Plan 审批 UI
                 ├── sessions[] ──→ 当前会话消息
                 └── appSettings ──→ hideThinkingBlock

useChatStream() ──┬── handleSendChat() ──→ Composer.onSend
                  ├── isStreaming ──→ Header 状态指示
                  ├── streamingSessionId ──→ Approval 守卫
                  └── thinkingSeconds ──→ MessageList.thinkingSeconds

daemonChatBridge ──┬── sendApproval() ──→ handleApprovalAllow()
                   └── sendDeny() ──→ handleApprovalDeny()

SessionRuntimeRegistry ──→ 附件持久化 ──→ Composer.attachments
```

### 2.3 Approval 逻辑提取细节

当前审批逻辑散布在 ChatCard 内部，与 `daemonChatBridge` 深度耦合：

```typescript
// L280-420 当前实现（需提取为 useChatApproval Hook）
// 依赖：activeSessionId, streamingSessionId, permissionMode
// 输出：approvalBusy, pendingApprovalMsgId, handleApprovalAllow, handleApprovalDeny

// 关键竞态条件（必须在提取时保留）：
// 1. approval 请求期间 session 切换 → approvalBusy 必须绑定 sessionId
// 2. 批量审批(onBatchApprove) 需要遍历消息列表 → 依赖 messages ref
// 3. remember 模式下需写回 permissionMode → 双向绑定 layoutStore
```

### 2.4 目标结构与行数预算

```
apps/crish-desktop/src/components/
├── chat/
│   ├── ChatCard.tsx                 # ≤300 行 — 纯布局编排
│   ├── ChatHeader.tsx               # ≤250 行 — Header 工具栏
│   ├── ChatProviderGuard.tsx        # ≤180 行 — Provider 配置检测
│   ├── ChatCheckpointActions.tsx    # ≤200 行 — Checkpoint/回滚
│   └── hooks/
│       ├── useChatCardSelectors.ts  # ≤60 行 — 18 个 selector 聚合
│       ├── useChatApproval.ts       # ≤150 行 — 审批逻辑
│       └── useChatComposerProps.ts  # ≤120 行 — Composer props 组装
├── ChatCard.tsx                     # barrel re-export
```

### 2.5 迁移步骤（严格顺序）

1. **提取 `useChatCardSelectors`**：将 18 个 `useLayoutStore` selector 聚合，减少组件顶层噪声。
2. **提取 `useChatApproval`**：将 L280-420 的审批逻辑封装，保留竞态守卫。
3. **提取 `ChatProviderGuard`**：将 L560-720 的 provider 检测 + 引导 UI 封装为独立组件。
4. **提取 `ChatCheckpointActions`**：将 L420-560 的 checkpoint 逻辑封装。
5. **提取 `ChatHeader`**：将 L720-900 的 Header JSX 提取，接收 selector 值作为 props。
6. **提取 `useChatComposerProps`**：将 L1100-1400 的 Composer props 组装逻辑封装。
7. **瘦身主文件**：ChatCard 仅保留三段式 JSX 布局 + 子组件编排。

### 2.6 质量门槛

- `ChatCard.tsx` ≤ 300 行（纯布局编排 + 子组件组合）
- 每个子组件 ≤ 250 行
- 所有提取的子组件包裹 `React.memo`
- 审批逻辑的竞态守卫必须有对应单元测试

---

## 三、任务 F-2：FilesCard.tsx 深度拆分

### 3.1 问题剖析

[FilesCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/FilesCard.tsx)（1,629 行）是项目中最大的组件文件。

**关键问题 1：27 个 useState 爆炸**

| useState 变量 | 行号 | 职责域 |
|--------------|------|--------|
| `root`, `cwd`, `entries`, `expanded` | L143-146 | 目录导航 |
| `loading`, `error`, `filter`, `selected` | L147-150 | 列表状态 |
| `view`, `content`, `editBuf`, `editing`, `dirty` | L151-155 | 文件预览/编辑 |
| `truncated`, `lineBudget`, `loadingMore` | L156-159 | 分段加载 |
| `mdMode`, `assetUrl`, `detailLoading` | L161-163 | 预览模式 |
| `selText`, `commentDraft`, `selAnchor` | L164-166 | 选区批注 |
| `pendingCount`, `moreOpen`, `openMenuOpen`, `openMenuMore` | L167-170 | 菜单状态 |
| `fileOpeners`, `openDefaultLabel` | L171-172 | Host opener |
| `filterMode`, `gitStatusMap` | L173-174 | Git 状态 |
| `bcFlyout`, `actionHint` | L177-185 | 面包屑下拉 + 操作提示 |

**关键问题 2：内联重复 `useVirtualScroll`**

L67-126 定义了一个**独立的 `useVirtualScroll` 函数**（等高固定行高版本），与全局 `hooks/useVirtualScroll.ts`（不等高动态版本）完全不同。这是典型的 `DUPLICATE_IMPLEMENTATION`：

```typescript
// FilesCard.tsx L67-126 — 内联简化版（固定 itemHeight）
function useVirtualScroll({ itemCount, itemHeight, containerRef, overscan }) {
  // 线性计算：startIndex = floor(scrollTop / itemHeight) - overscan
  // 无 VirtualScrollManager，无 Pretext 估算，无 suffix rebuild
}

// hooks/useVirtualScroll.ts — 全局版（动态高度 + VirtualScrollManager）
export function useVirtualScroll(options) {
  // O(log N) 二分查找，estimated + actual 双层高度，rAF 批量更新
}
```

**修复方案**：删除内联版，迁移到全局 `useVirtualScroll` + 固定 `fallbackHeight` 模式。

### 3.2 目标结构

```
apps/crish-desktop/src/components/
├── files/
│   ├── FilesCard.tsx                # ≤300 行 — 容器 + 视图切换
│   ├── FileTree.tsx                 # ≤350 行 — 目录列表 + 面包屑 + 虚拟滚动
│   ├── FilePreview.tsx              # ≤300 行 — 文件预览（按 kind 分发）
│   ├── FileEditor.tsx               # ≤200 行 — 文本编辑 + 保存
│   ├── FileActions.tsx              # ≤150 行 — Host opener 菜单 + 操作按钮
│   ├── FileBreadcrumb.tsx           # ≤200 行 — 面包屑 + 目录下拉
│   └── hooks/
│       ├── useFileNavigation.ts     # ≤120 行 — root/cwd/entries/expanded 状态
│       └── useFilePreview.ts        # ≤150 行 — content/editBuf/truncated 状态
├── FilesCard.tsx                    # barrel re-export
```

### 3.3 状态拆分方案

将 27 个 useState 按职责域重组为 3 个自定义 Hook：

| Hook | 管理的 state | 暴露的 action |
|------|-------------|--------------|
| `useFileNavigation` | `root`, `cwd`, `entries`, `expanded`, `loading`, `error`, `filter`, `filterMode`, `gitStatusMap` | `refresh()`, `loadDir()`, `toggleExpand()` |
| `useFilePreview` | `selected`, `view`, `content`, `editBuf`, `editing`, `dirty`, `truncated`, `lineBudget`, `loadingMore`, `mdMode`, `assetUrl`, `detailLoading` | `openFile()`, `loadMore()`, `toggleEdit()`, `save()` |
| 内联保留 | `moreOpen`, `openMenuOpen`, `bcFlyout`, `actionHint` 等 UI 瞬态 | 直接在子组件中管理 |

### 3.4 新增子任务

**[新增] F-2g：未保存切换拦截 Guard**
在拆分出的 `files/useFileNavigation.ts` 和 `files/useFilePreview.ts` 中增加 `dirty` 状态追踪：
- `useFileNavigation` 暴露 `isDirty(): boolean` 和 `confirmNavigation(): Promise<boolean>`
- 当 `dirty == true` 且用户触发文件/目录切换时，弹出确认对话框（由 `FileConfirmDialog.tsx` 展示）
- 草稿临时持久化到 `sessionStorage`（key 为 `fileEditDraft:{path}`），切换返回时自动恢复

通信协议：
- useFilePreview 暴露 isDirty: boolean 和 onDirtyChange: (dirty: boolean) => void
- useFileNavigation 接收 isDirty: boolean 参数
- 当用户触发文件/目录切换时，useFileNavigation 检查 isDirty：
  - isDirty === true → 弹出确认对话框（FileConfirmDialog.tsx）
  - 确认后 → 草稿 sessionStorage 持久化 → 执行导航
  - 取消 → 阻止导航
- 跨组件通信通过 FilesCard 容器组件传递 props，不通过全局 store

---

## 四、任务 F-6：App.tsx 深度拆分

### 4.1 引导链瀑布分析

[App.tsx](file:///c:/Software/conex/apps/crish-desktop/src/App.tsx)（1,189 行）包含 **12 个 `useEffect`**，形成复杂的引导瀑布：

| # | 行范围 | 依赖 | 作用 | 可提取 |
|---|--------|------|------|--------|
| 1 | L222-229 | `[]` | 延迟 import daemonClient → `setEngineReady` | `AppBootstrap` |
| 2 | L259-265 | `[]` | 设置 `AUTO_FOLD_DELAY` 全局变量 | `AppBootstrap` |
| 3 | L267-273 | `[]` | 设置 `document.title` 和 `lang` | `AppBootstrap` |
| 4 | L275-279 | `[]` | `initLayoutStorePersistence()` | `AppBootstrap` |
| 5 | L281-286 | `[]` | `bootstrapServices()` | `AppBootstrap` |
| 6 | L288-292 | `[]` | 崩溃检测 `telemetry.hasPreviousCrash()` | `AppBootstrap` |
| 7 | L294-297 | `[]` | `bootstrapStores()` | `AppBootstrap` |
| 8 | L299-354 | `[]` | 项目文件夹重绑定（`useLayoutEffect` + store subscribe） | `useProjectRebind()` |
| 9 | L356-371 | `[]` | `initWorkspaceLayoutSync()` | `AppBootstrap` |
| 10 | L373-411 | `[]` | 主题/字体/设置/TabMode 初始化 | `AppBootstrap` |
| 11 | L413-464 | `[productShell]` | 引擎启动（daemonClient + daemonChatBridge + provider sync + session sync） | `useEngineBootstrap()` |
| 12 | L466-471 | `[]` | `WindowResizeBridge` 连接 | `AppBootstrap` |

**额外 effect**：
- L489-493：hover timeout cleanup
- L495-510：UI size / shell chrome data attributes
- L512-516：demo mode data attribute
- L518-675：**全局快捷键处理**（最大的 effect，157 行）
- L677-684：快捷键冲突检测（DEV only）
- L686-695：遥测订阅
- L697-701：workspace picker 事件

### 4.2 全局快捷键处理提取

L518-675 的快捷键处理是 App.tsx 中最复杂的逻辑块（157 行），包含：

```
ShortcutService.init(document) ─→ svc.onMatch() ─→ switch(actionId) {
  toggle_settings    → toggleSettingsOverlay()
  new_session        → enterDraftMode()
  focus_composer     → emitUiEvent('focus-composer')
  stop_generation    → emitUiEvent('stop-generation')
  open_models        → openSettings('models')
  open_usage         → openSettings('usage')
  open_security      → openSettings('security')
  open_shortcuts     → openSettings('shortcuts')
  open_extensions    → openSettings('plugins')
  open_schedule      → openSettings('schedule')
  toggle_sidebar     → setSidebarCollapsed(!)
  toggle_plan_mode   → setPlanModeEnabled(!)
  branch_session     → branchSession() + formatBranchUndoToast()
  cheatsheet         → setShowCheatsheet(!)
  quick_open         → setShowQuickOpen(!)
  export_logs        → setShowTelemetry(true)
}
```

**依赖项（闭包捕获）**：`handleShowToast`, `showCheatsheet`, `showQuickOpen`, `showSettingsOverlay`, `showFirstRun`, `setShowSettingsOverlay`, `setSidebarCollapsed`

### 4.3 双 Chrome 模式 JSX 重复

L766-926 根据 `shellChromeMode` 渲染两套完全不同的 Header：

- `shellChromeMode !== 'inset'`（L766-884）：经典 `<header className="app-header">` + 窗口控制按钮
- `shellChromeMode === 'inset'`（L885-926）：项目标题栏 `<div className="ws-titlebar-host">` + `WorkspaceChromeBars`

**两套 Header 共享**：sidebar toggle 按钮、Help 按钮、窗口控制函数 `winCtl()`

**修复方案**：提取 `AppHeader.tsx`，内部根据 `shellChromeMode` 分支渲染，复用共享逻辑。

### 4.4 目标结构

```
apps/crish-desktop/src/
├── App.tsx                    # ≤250 行 — Provider 树 + 布局骨架 + 子组件编排
├── app/
│   ├── AppBootstrap.ts        # ≤200 行 — 12 个引导 effect 聚合（纯 Hook，无 JSX）
│   ├── AppHeader.tsx          # ≤250 行 — 双 Chrome 模式 Header（React.memo）
│   ├── AppKeyboardHandler.ts  # ≤120 行 — 全局快捷键 Hook
│   ├── AppGlobalDialogs.tsx   # ≤150 行 — 首次运行/遥测/崩溃/快捷键帮助/快速打开
│   └── useEngineBootstrap.ts  # ≤100 行 — 引擎启动 effect（L413-464）
```

### 4.5 迁移关键守卫

| 守卫 | 位置 | 注意事项 |
|------|------|---------|
| `productShell` 延迟门控 | L449-454 | `gateTimer = 12_000` 仅在 productShell 模式下生效，非 product 模式立即 `setEngineReady(true)` |
| 项目重绑定时序 | L299-354 | 使用 `useLayoutEffect` + 双 rAF 延迟确保 DOM 就绪后执行 |
| 快捷键 escape 优先级 | L526-549 | Escape 按 `showQuickOpen` → `showCheatsheet` → `showSettingsOverlay` → `showFirstRun` 优先级递降 |
| 窗口控制安全 | L703-715 | `winCtl()` 的 `try/catch` 确保在非 Tauri 环境（dev 模式）不崩溃 |

---

## 五、任务 F-10：ChatMessageList.tsx 深度拆分

### 5.1 内部结构映射

[ChatMessageList.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/ChatMessageList.tsx)（1,097 行）是虚拟滚动消息列表，混合了 6 个职责域：

| 行范围 | 职责域 | 关键函数 |
|--------|--------|---------|
| L1-55 | 导入 + 常量 | `EMPTY_PIN_IDS`, `EMPTY_MSGS`, `EMPTY_MUST_INDICES` |
| L56-88 | 固定消息辅助 | `pinSnippet()`, `scrollToMessage()`, `scrollToMessageAfterPaint()` |
| L90-123 | Props 接口 | 24 个 props（审批 + 操作回调 + 显示状态） |
| L125-260 | 窗口化逻辑 | `expandedOlder` 状态 + `windowMessages()` + `mustIncludeIndices` + keep-alive 抬升 |
| L260-560 | 回调层 | `togglePin`, `jumpToPinned`, `expandOlderStep`, `handleRegenerateRow`, `handleMarkdownClick` + `toolStackProps` memo |
| L553-852 | **虚拟滚动集成**（核心） | `useVirtualScroll` + Pretext 高度估算 + ResizeObserver 实际高度回写 + 滚动锚点补偿 |
| L852-877 | 滚动事件处理 | 自动加载更早消息 + 贴底检测 |
| L878-1097 | JSX 渲染 | spacer + 可视消息 slice + 固定消息栏 |

### 5.2 虚拟滚动集成的关键状态机

L577-652 的 `useLayoutEffect` 是整个消息列表最复杂的逻辑（75 行），实现了：

```
虚拟滚动高度生命周期（契约 01-contract §1）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 会话切换检测:
   prevSessionIdForHeightsRef !== activeSessionId
   → clearHeights() + syncOrder(visibleIds) + 重置 generation

2. 初始贴底相位:
   initialScrollSessionIdRef === activeSessionId
   → scrollTop = scrollHeight + 1000000
   → 微任务 + 双 rAF 强制贴底

3. 窗口前移 / expand older（锚点补偿）:
   anchorId = prevIds[0]
   newIndexOfAnchor = nextIds.indexOf(anchorId)
   → 如果 newIndexOfAnchor > 0 且前缀对齐
   → scrollTop += 前置项高度累加

4. 时序守卫:
   - order 为空时跳过补偿
   - generation 不匹配时跳过（防旧 rAF 回填）
```

### 5.3 Pretext 高度估算的分帧处理

L729-792 实现了基于 `@chenglou/pretext` 的文本高度估算：

```
Pretext 估算流程
━━━━━━━━━━━━━━━
visibleMessages.filter(msg => !manager.hasHeight(msg.id))
  → 按 CHUNK_SIZE=5 分帧（rAF 调度）
  → 每条消息:
     globalPretextCache.getOrCreate(msg.id, text, pretextFont)
     → layout(prepared, availWidth, TEXT_LINE_HEIGHT=22)
     → h = result.height + TEXT_PADDING=40
     → toolCalls.length * TOOL_CALL_OVERHEAD=80
  → vs.setEstimated(msg.id, h)

守卫条件:
  - isResizing → 暂停（防止拖拽期间无效估算）
  - isLayoutFrozen → 暂停
  - containerWidth <= 0 → 跳过
  - pretextFont 未就绪 → 跳过
```

### 5.4 提取方案

```
apps/crish-desktop/src/components/chat/
├── ChatMessageList.tsx          # ≤400 行 — 容器 + 虚拟滚动主逻辑
├── PinnedMessagesBar.tsx        # ≤120 行 — 固定消息栏（完全独立 UI 子树）
├── MessageWindowControls.tsx    # ≤80 行 — "显示更早 N 条" + "全部展开" 按钮
├── hooks/
│   ├── useMessageWindow.ts      # ≤100 行 — expandedOlder + windowMessages + mustInclude
│   ├── usePretextHeights.ts     # ≤100 行 — Pretext 分帧估算逻辑
│   └── useScrollAnchor.ts       # ≤80 行 — 滚动锚点补偿 + 贴底检测
```

---

## 六、任务 F-3/F-4/F-5 拆分方案

### 6.1 DiffCard.tsx（1,397 行）

已部分拆分出 `DiffCardFileList`, `DiffCardGitActions`, `DiffCardSplitView`, `DiffCardUnifiedView`。
剩余提取：

| 子组件/Hook | 提取内容 | 预估行数 |
|------------|---------|---------|
| `DiffToolbar.tsx` | 源模式切换 + 比较模式切换 + 搜索输入 | ≤150 |
| `DiffGitPanel.tsx` | Git 分支管理 + commit + push 操作面板 | ≤200 |
| `useDiffData.ts` | diff 数据获取 + 计算 + 缓存管理 | ≤180 |

目标：`DiffCard.tsx` ≤ 400 行。

### 6.2 OverviewCard.tsx（1,146 行）

```
apps/crish-desktop/src/components/overview/
├── OverviewCard.tsx          # ≤250 行 — 容器 + section 编排
├── ProgressSection.tsx       # ≤200 行 — 目标模式进度 + 工具执行状态
├── AgentSection.tsx          # ≤180 行 — 协作体列表 + 状态指示
├── ChangesSection.tsx        # ≤200 行 — Git 变更文件列表 + diff 预览入口
├── ScheduleSection.tsx       # ≤150 行 — 定时任务展示
└── BackgroundSection.tsx     # ≤120 行 — 后台任务展示
```

### 6.3 ChatMessageRow.tsx（1,142 行）

```
apps/crish-desktop/src/components/chat/
├── ChatMessageRow.tsx        # ≤350 行 — 消息行容器（React.memo，分发 user/assistant）
├── MessageContent.tsx        # ≤250 行 — markdown 渲染 + 增量 DOM patch
├── MessageActions.tsx        # ≤150 行 — 操作栏（复制/固定/重试/回退/follow-up）
├── MessageThinking.tsx       # ≤100 行 — 思考面板（折叠/展开 + 计时器）
└── MessageImages.tsx         # ≤80 行 — 图片引用缩略图
```

---

## 六、任务 F-4/F-5：拖拽系统与组件规范化

### 6.4 新增子任务

**[新增] F-4d：拖拽样式 Token 化（归属 Agent F4，与 useTabDrag 配合实现）**
- 创建 `styles/tab-drag.css`，定义 CSS 变量命名空间：`--dnd-indicator-color`, `--dnd-indicator-width`, `--dnd-overlay-opacity`, `--dnd-transition-duration`
- 在主题配置（`layoutStore` 或 CSS 变量文件）中统一定义默认值
- `hooks/useTabDrag.ts` 中的 `<div style={{...}}>` 内联样式替换为引用 CSS 变量的 className
- 清理所有 `::before`/`::after` 拖拽伪元素，替换为独立 DOM 层 + CSS 变量控制

---

## 七、任务 F-7/F-8/F-9：Sidebar 与 Settings

### 7.1 Sidebar.tsx（~1,000 行）

```
apps/crish-desktop/src/components/sidebar/
├── Sidebar.tsx               # ≤250 行 — 容器
├── SidebarHeader.tsx         # ≤120 行 — 新建会话 + 搜索入口
├── SessionList.tsx           # ≤300 行 — 会话列表（虚拟滚动）
├── FolderSection.tsx         # ≤200 行 — 文件夹分组 + 拖拽排序
└── SidebarFooter.tsx         # ≤100 行 — 底部状态/设置入口
```

### 7.2 SkillsSettingsTab.tsx（~1,300 行）

```
apps/crish-desktop/src/components/settings/
├── SkillsSettingsTab.tsx     # ≤250 行 — 容器
├── SkillsList.tsx            # ≤300 行 — 技能列表 + 搜索
├── SkillDetail.tsx           # ≤250 行 — 技能详情展示
├── SkillEditor.tsx           # ≤300 行 — 技能编辑 + 文件上传
└── SkillImportExport.tsx     # ≤150 行 — 导入导出
```

### 7.3 其他 Settings Tab

| Tab | 行数 | 决策 | 拆分方案 |
|-----|------|------|---------|
| `McpSettingsTab.tsx` | ~900 | **拆分** | MCP 服务器列表 + 服务器详情/配置 + 工具列表 |
| `SettingsExtensionsTab.tsx` | ~950 | **拆分** | 扩展列表 + 扩展配置面板 |
| `ModelsSettingsTab.tsx` | ~700 | **拆分** | 模型列表 + Provider 配置 + API Key 管理 |
| `SettingsScheduleTab.tsx` | ~650 | 保持 | 接近阈值但职责单一 |
| `SettingsRulesTab.tsx` | ~650 | 保持 | 职责单一 |
| `SettingsShortcutsTab.tsx` | ~500 | 保持 | 已在阈值内 |

---

## 八、Prop Drilling 热点分析

### 8.1 ChatCard → ChatMessageList 的 24 props 传递

```
ChatCard 传给 ChatMessageList 的 props:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
messages, agents, activeSessionId, thinkingSeconds,
showAllMessages, showProjectPicker, onShowProjectPicker,
onProjectChanged, onSetChatInput, onSendFollowUp,
onWithdraw, onRegenerate, onBranch, onShowToast,
approvalBusy, pendingApprovalMsgId, onOpenDiff, onOpenPath,
onOpenTerminal, onOpenDiffPanel, onApprovalAllow, onApprovalDeny,
onBatchApprove, onBatchDeny
```

**修复方案**：引入 `ChatSessionContext`，将 `activeSessionId`、`agents`、审批相关 props 通过 Context 传递，减少 prop drilling 层数。

### 8.2 ChatMessageList → ChatAssistantMessageRow 的 18 props

```
传给每个 ChatAssistantMessageRow 的 props:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
msg, isFollowUp, isPinned, isSearchHit, isThinkingMsg,
thinkingSeconds, hideThinkingBlock, inPlanMode, planApproved,
isLastAssistant, toolStackProps, onTogglePin, onShowToast,
onRegenerate, onBranch, onOpenDiff, onOpenDiffPanel,
setPermissionMode, setPlanApproved, onFillFollowUp,
onSendFollowUp, followUpDismissed, onDismissFollowUp,
messageIndex, virtualScrollManager
```

**修复方案**：`toolStackProps` 已是 memo 化的聚合对象（L520-551），这是正确方向。进一步将审批 + 计划模式 props 聚合为 `planModeProps` 对象。

---

## 九、多 Agent 并行分配

```
┌──────────────────────────────────────────────────────────────────┐
│                     Round 6: Layer F                              │
│                                                                   │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │
│  │   Agent F1    │  │   Agent F2    │  │   Agent F3    │        │
│  │  ChatCard +   │  │  FilesCard +  │  │  DiffCard +   │        │
│  │  MsgRow +     │  │  OverviewCard │  │  Settings     │        │
│  │  ChatComposer │  │              │  │  Tabs         │        │
│  │  (F-1,F-5)   │  │  (F-2, F-4)  │  │  (F-3,F-8,   │        │
│  │              │  │              │  │   F-9)        │        │
│  └───────────────┘  └───────────────┘  └───────────────┘        │
│                                                                   │
│  ┌────────────────────────┐  ┌────────────────────────┐          │
│  │      Agent F4          │  │      Agent F5          │          │
│  │   App.tsx +            │  │   Sidebar.tsx +        │          │
│  │   全局组件             │  │   ChatMessageList      │          │
│  │   (F-6)               │  │   (F-7, F-10)         │          │
│  └────────────────────────┘  └────────────────────────┘          │
└──────────────────────────────────────────────────────────────────┘
```

### Agent 互斥边界（零冲突文件分配）

| Agent | 独占文件 | 新建文件 |
|-------|---------|---------|
| F1 | `ChatCard.tsx`, `ChatComposer.tsx`, `ChatMessageRow.tsx`, `ChatStatusRibbons.tsx`, `ChatToolCallBlock.tsx` | `chat/ChatHeader.tsx`, `chat/ChatProviderGuard.tsx`, `chat/ChatCheckpointActions.tsx`, `chat/MessageContent.tsx`, `chat/MessageActions.tsx`, `chat/PinnedMessagesBar.tsx`, `chat/hooks/*.ts` |
| F2 | `FilesCard.tsx`, `OverviewCard.tsx` | `files/*.tsx`, `overview/*.tsx`, `files/hooks/*.ts` |
| F3 | `DiffCard.tsx`, `SkillsSettingsTab.tsx`, `McpSettingsTab.tsx`, `SettingsExtensionsTab.tsx`, `ModelsSettingsTab.tsx` | `settings/SkillsList.tsx` 等 |
| F4 | `App.tsx`, `WorkspaceChromeBars.tsx`, `CardPanel.tsx`, `hooks/useTabDrag.ts`, `styles/tab-drag.css`（新建） | `app/AppBootstrap.ts`, `app/AppHeader.tsx`, `app/AppKeyboardHandler.ts`, `app/AppGlobalDialogs.tsx` |
| F5 | `Sidebar.tsx`, `ChatMessageList.tsx`, `ChatEmptyState.tsx` | `sidebar/*.tsx` |

### 冲突文件访问规则

| 冲突文件 | 归属 | 访问规则 |
|---------|------|---------|
| `ChatMessageList.tsx` | F5（Sidebar 组） | F1 只读引用 |
| `CardPanel.tsx` | F4（App 组） | 跨 Round 访问需 F4 批准 |

---

## 十、验收标准

| 编号 | 检查项 | 通过条件 | 验证方法 |
|-----|--------|---------|---------|
| V-1 | ChatCard 瘦身 | ≤ 300 行 | `wc -l ChatCard.tsx` |
| V-2 | FilesCard 瘦身 | ≤ 300 行 | `wc -l FilesCard.tsx` |
| V-3 | DiffCard 瘦身 | ≤ 400 行 | `wc -l DiffCard.tsx` |
| V-4 | OverviewCard 瘦身 | ≤ 250 行 | `wc -l OverviewCard.tsx` |
| V-5 | ChatMessageRow 瘦身 | ≤ 350 行 | `wc -l ChatMessageRow.tsx` |
| V-6 | App.tsx 瘦身 | ≤ 250 行 | `wc -l App.tsx` |
| V-7 | Sidebar 瘦身 | ≤ 250 行 | `wc -l Sidebar.tsx` |
| V-8 | SkillsSettingsTab 瘦身 | ≤ 250 行 | `wc -l SkillsSettingsTab.tsx` |
| V-9 | ChatMessageList 瘦身 | ≤ 400 行 | `wc -l ChatMessageList.tsx` |
| V-10 | FilesCard 内联虚拟滚动删除 | 零内联 `useVirtualScroll` | `grep -n "function useVirtualScroll" FilesCard.tsx` 无结果 |
| V-11 | React.memo 包裹 | 所有提取的子组件使用 `React.memo` | `grep -rn "React.memo" components/chat/ components/files/ components/overview/` |
| V-12 | Prop drilling 减少 | ChatCard→MsgList props ≤ 15 | 手动审计 |
| V-13 | 全量构建 | `npm run build` 零错误 | CI |
| V-14 | 全量测试 | `npm test` 零回归 | CI |
| V-15 | 无 `title` 属性 | 零原生 `title`（使用 `<Tooltip>`） | `grep -rn 'title="' components/*.tsx` |
| V-16 | 虚拟滚动契约 | 会话切换 → clearHeights；窗口平移 → syncOrder（禁止 clear） | 端到端测试 |
| V-17 | Pretext 估算守卫 | isResizing / isLayoutFrozen 期间暂停估算 | 单元测试 |

---

## 十一、风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|-----|------|------|---------|
| ChatCard 拆分导致审批竞态回归 | 中 | **高** | 提取 `useChatApproval` 时保留 `sessionId` 绑定守卫 + 新增竞态单元测试 |
| FilesCard 虚拟滚动迁移导致文件列表闪烁 | 中 | 中 | 分阶段迁移：先将内联版替换为全局版的固定高度模式 |
| App.tsx bootstrap 顺序打乱导致启动崩溃 | **高** | **高** | `AppBootstrap` 内部保持 effect 顺序不变；仅移动文件位置，不改逻辑 |
| ChatMessageList 锚点补偿逻辑提取后失效 | 中 | 高 | `useScrollAnchor` 必须使用 `useLayoutEffect`（非 useEffect），保持同步 layout 相位 |
| CSS Module 类名冲突 | 低 | 低 | 子组件复用父组件的 `.module.css` 或创建独立 module |
| Settings Tab 拆分影响设置持久化 | 低 | 中 | 持久化逻辑保留在 layoutStore，不随 UI 拆分移动 |
