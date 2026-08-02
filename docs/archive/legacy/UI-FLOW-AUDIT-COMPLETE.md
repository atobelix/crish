# Crish 桌面应用 UI 流程审计完整问题清单

> 生成日期: 2026-07-20
> 检查范围: 24 个 Agent，4 轮深度审计
> 覆盖文件: 全部 60+ UI 组件 + 100+ API/Store/Hooks 文件

---

## 目录

1. [App 骨架/顶栏/布局](#1-app-骨架顶栏布局)
2. [侧栏 (Sidebar)](#2-侧栏-sidebar)
3. [工作区/列/面板 (Workspace/CardPanel)](#3-工作区列面板-workspacecardpanel)
4. [对话面板 (ChatCard/Composer/MessageList)](#4-对话面板-chatcardcomposermessagelist)
5. [工具面板](#5-工具面板)
6. [设置面板](#6-设置面板)
7. [Workspace Chrome Bars](#7-workspace-chrome-bars)
8. [辅助/额外功能](#8-辅助额外功能)
9. [API/Store/Hooks 层](#9-apistorehooks-层)
10. [Daemon 连接与同步](#10-daemon-连接与同步)
11. [消息完整性与状态管理](#11-消息完整性与状态管理)
12. [持久化与存储](#12-持久化与存储)
13. [审批与工具执行](#13-审批与工具执行)
14. [多会话/工作区/项目隔离](#14-多会话工作区项目隔离)
15. [错误处理与恢复](#15-错误处理与恢复)
16. [并发操作竞态条件](#16-并发操作竞态条件)
17. [跨标签页/窗口协调](#17-跨标签页窗口协调)
18. [无障碍 (A11Y)](#18-无障碍-a11y)
19. [性能问题](#19-性能问题)
20. [代码质量/重复/遗留](#20-代码质量重复遗留)

---

## 1. App 骨架/顶栏/布局

### 1.1 严重缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 1 | 双击 Escape 分叉永远无法触发 | `shortcutBindings.ts:101` | `matchShortcutActions` 跳过所有含空格且不含 `+` 的绑定，使 `"Escape Escape"` 分支快捷键永久失效 |
| 2 | `lastEscTime` 计时器在 effect 重建时重置 | `App.tsx:369` | effect 依赖 `handleShowToast`(toast 队列变化时重建)，导致 `lastEscTime` 本地变量归零，双击分叉不可靠 |
| 3 | 顶栏缺少 ErrorBoundary | `App.tsx:601-693` | classic 模式顶栏完全无 ErrorBoundary 包裹，渲染崩溃直接白屏 |
| 4 | engineReady 双重 Source of Truth | `App.tsx:137-144,264-306` | 两个 effect 都调用 `setEngineReady(true)`，productShell 模式下 12s 超时可能强制置为 true 即使引擎未就绪 |

### 1.2 中等缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 5 | 窗口控件在浏览器中可见但无功能 | `App.tsx:520-530` | `winCtl()` 静默空 catch，浏览器中按钮可见但无效果，无视觉提示 |
| 6 | 侧栏 hover 触发条过窄(8px) | `App.tsx:748-758` | `sidebar-hover-trigger` 仅 8px 宽，高 DPI 下难以命中 |
| 7 | 折叠时 `overflow: visible` 可能泄漏内容 | `App.tsx:771` | 侧栏折叠 CSS `width:0` + `overflow:visible`，过渡期间子内容可能可见 |
| 8 | 6 个懒加载图标各带独立 Suspense | `App.tsx:38-43` | IconSidebarLeft/Right + 4 个 Lucide 图标各独立 `lazy()`，6 次额外网络请求 |
| 9 | 键盘处理器在 toast 变化时重建 | `App.tsx:494-501` | `handleShowToast` 是 effect 依赖项，toast 出现/消失时 keydown 监听器被移除并重新添加 |
| 10 | 设置覆盖层 z-index 与 Cheatsheet 可能冲突 | `App.tsx:817,829` | 设置 `zIndex:13000`，Cheatsheet CSS `z-index:12000`，两者未互斥可同时打开 |
| 11 | 首次运行向导 Escape 未 preventDefault | `App.tsx:395-398` | `showFirstRun` 路径无 `e.preventDefault()`，原生 Escape 行为(退出全屏等)仍会触发 |
| 12 | 设置面板无动画退出过渡 | `App.tsx:823-860` | `showSettingsOverlay=false` 时立即从 DOM 移除，无动画退出(Cheatsheet 有) |
| 13 | `data-engine-ready`/`data-first-run`/`data-perf-level` 无人消费 | `App.tsx:543-545` | 属性已设置但无 CSS 选择器或 JS 读取 |

### 1.3 代码/设计问题

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 14 | `main.tsx` 阶段 1.5 无进度指示器 | `main.tsx:46` | 骨架屏到 React 渲染之间无视觉反馈 |
| 15 | `main.tsx` 无重试按钮处理启动失败 | `main.tsx:32-36` | React/App 模块加载失败时仅静态错误 div，无重试 |
| 16 | `main.tsx` catch 路径渲染 App 不带 ErrorBoundary | `main.tsx:56-60` | 主 try 块失败后 catch 块直接渲染 `<App />` 无边界保护 |
| 17 | `index.css` 始终导入所有 UI 样式 | `index.css` | chat.css/panels.css/6 个 settings.css 总是导入，增大初始 CSS 体积 |
| 18 | `index.css` 始终加载 dark 主题 | `index.css` | `theme-dark.css` 总是被导入，无论当前主题 |
| 19 | AppErrorBoundary compact/全屏模式下按钮顺序不一致 | `AppErrorBoundary.tsx` | 紧凑模式: 重试→重新加载；全屏模式: 重新加载→重试 |
| 20 | AppErrorBoundary `dismiss` 后无焦点管理 | `AppErrorBoundary.tsx` | 重置错误后焦点不恢复，键盘用户难以继续操作 |
| 21 | AppErrorBoundary 无错误报告回调 | `AppErrorBoundary.tsx` | 没有 `onError` prop 将错误发送给监控服务 |
| 22 | SidebarToggleIcons `aria-hidden` prop 定义但未使用 | `SidebarToggleIcons.tsx` | `IconProps` 声明了 `'aria-hidden'` 但 svgProps 工厂函数始终写死 `true` |
| 23 | Toast CSS 动画 `slideInUp` 无对应 @keyframes | `ToastStack.tsx` CSS | 第 26-46 行引用未声明的 `slideInUp` 关键帧 |
| 24 | Toast `aria-live="polite"` 对错误 toast 优先级过低 | `ToastStack.tsx` | 错误/紧急 toast 应使用 `assertive` |
| 25 | Toast 无手动关闭(点击关闭)功能 | `ToastStack.tsx` | Toast 只能通过撤销按钮或超时消失 |

---

## 2. 侧栏 (Sidebar)

### 2.1 严重缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 26 | `groupType: 'none'`(平铺列表)形同虚设 | `SidebarSessionList.tsx:513` | `_groupType` 前导下划线标记未使用，代码始终按项目分组 |
| 27 | 键盘无法从折叠状态展开侧栏 | `Sidebar.tsx:548-563` | `handleSidebarResizeKeyDown` 在 `sidebarCollapsed=true` 时按 → 不会自动展开 |

### 2.2 中等缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 28 | 拖拽缺少 `setPointerCapture` | `Sidebar.tsx:504` | `handleSidebarResizeStart` 未调用 `setPointerCapture`，快速拖拽可能丢失事件 |
| 29 | 排序菜单每次选择后自动关闭 | `SidebarContextMenus.tsx:374-376` | 用户不可连续调整排序/分组/筛选多项设置 |
| 30 | 搜索框无 Esc 清空和快捷键聚焦 | `SidebarNav.tsx` | 缺少全局快捷键聚焦搜索框；无 Esc 清空搜索 |
| 31 | `expandedProjectFolders` 与 `collapsedProjects` 双状态可能冲突 | `SidebarSessionList.tsx` | 两个独立状态控制文件夹展开/折叠，语义冲突 |
| 32 | `newSessionLockRef` 防抖不充分 | `Sidebar.tsx:218,415-432` | 微任务锁只防同帧，快速连续点击仍可创建多个会话 |
| 33 | 侧栏首次加载无 skeleton/loading 态 | `SidebarSessionList.tsx` | 数据未就绪时显示空白 |
| 34 | 排序子菜单仅支持鼠标悬停 | `SidebarContextMenus.tsx` | 飞延子菜单通过 `onMouseEnter` 触发，触屏设备不可用 |
| 35 | 分隔条默认不可见 | `Sidebar.module.css` | `::after` 伪元素竖线只在拖拽时显示，用户不知可拖拽 |
| 36 | `navigateSession` 使用 `.session-item` 类选择器 | `SidebarSessionList.tsx:812-828` | 通用类名可能与其他元素冲突 |
| 37 | 点击 session 行时 readonly 会话仍可点击 | `SidebarSessionList.tsx` | 虽被 `partitionSidebarSessions` 过滤，搜索场景下仍可能出现 |
| 38 | 排序菜单飞延子菜单仅向右展开 | `SidebarContextMenus.tsx` | 靠近屏幕右边缘时无自动切换到左侧展开 |
| 39 | `useLayoutEffect` 直接操作 DOM style | `SidebarContextMenus.tsx:169-183` | 绕过 React CSS 控制，反模式 |
| 40 | 搜索框隐藏了 `search-cancel-button` 但无自定义清空按钮 | `SidebarNav.tsx` CSS | `::-webkit-search-cancel-button { display:none }` 但无替代 |

### 2.3 代码/设计问题

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 41 | `AgentContextMenuState` 及多个 `@deprecated` 参数残留 | `SidebarContextMenus.tsx:13-18` | 增加不必要的复杂度 |
| 42 | `openSessionInNewWindow` 无 popup blocker 提示 | `Sidebar.tsx:98-160` | `window.open` 被拦截时无提示 |
| 43 | `SettingsQuickMenu` 中 `onShowToast` 参数声明但 unused | `SettingsQuickMenu.tsx:204` | `void onShowToast;` 显式忽略 |
| 44 | 拖拽到列表边缘时不自动滚动 | `SidebarSessionList.tsx` | 用户体验不佳 |
| 45 | 分隔条 CSS 注释重复 | `Sidebar.module.css:4,29` | 两次 `/* Removed vertical border line */` 注释 |
| 46 | SettingsQuickMenu 无系统主题跟随 | `SettingsQuickMenu.tsx` | 主题只有浅色和深色，缺少"跟随系统" |
| 47 | SettingsQuickMenu 菜单关闭时焦点还原不够健壮 | `SettingsQuickMenu.tsx:151-154` | `chromeHidden` 状态下聚焦到不可见元素 |

---

## 3. 工作区/列/面板 (Workspace/CardPanel)

### 3.1 严重缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 48 | Inset 模式 Chat 状态下标签栏完全消失 | `CardPanel.tsx:579-589` | `showCardHeader=false` 时用户无法切换到工具面板 |
| 49 | `dropIndicator` CSS 类已定义但 JSX 未使用 | `Workspace.module.css:254` | CSS 定义 `dropIndicator` 但 Workspace.tsx 使用 `id` + 内联样式 |

### 3.2 中等缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 50 | `WorkspaceEmptyState` 无键盘支持 | `WorkspaceEmptyState.tsx:18` | `onPointerDown` 只响应指针事件，键盘用户无法激活工作区 |
| 51 | `VirtualList` 的 `ResizeObserver` 卸载时不断开 | `VirtualList.tsx:48-63` | 内存泄漏 |
| 52 | 加号菜单无 Tab/Shift+Tab 循环 | `CardPanel.tsx:528-549` | 键盘用户打开菜单后无法用 Tab 遍历选项 |
| 53 | 组分隔条缺少 Home/End 键盘操作 | `Workspace.tsx:656-665` | 与列分隔条(有 Home/End)不对称 |
| 54 | 非 tab 拖拽(拖整组)无落点视觉反馈 | `CardPanel.tsx:199-247` | `showDockOverlay` 仅对 `isTabDrag` 有效 |
| 55 | `overview` 可添加不可关闭 | `CardPanel.tsx:70,433` | `isClosableTab('overview')=false` 但出现在 `PANEL_ADD_IDS` |
| 56 | `focusTabByIndex` 可能在 DOM 未渲染前查询 | `CardPanel.tsx:475-486` | 异步 `setState` 后立即 `rAF`，可能找不到 DOM 节点 |
| 57 | 列分隔条居中偏差 0.5px | `Workspace.tsx:578` | 5px 宽的分隔条用 `-3px` 而非 `-2.5px` |
| 58 | 组分隔条居中偏差 0.5px | `Workspace.tsx:668` | 同上理 |
| 59 | agent 面板关闭逻辑不一致 | `CardPanel.tsx:845` | `closeToolTab('agent')` 调用 `closeAgentSidePanel` 而非通用 `closeTabInGroup` |
| 60 | `VirtualList` 无 `role` 和 `aria` 属性 | `VirtualList.tsx` | 应添加 `role="list"` 和子项 `role="listitem"` |
| 61 | `VirtualList` 固定 `itemHeight`，不支持动态高度 | `VirtualList.tsx` | 所有项必须等宽高 |
| 62 | `VirtualList` 无 `scrollToIndex` 命令式 API | `VirtualList.tsx` | 无法编程滚动到指定项 |
| 63 | `VirtualList` 使用 index 作为 key | `VirtualList.tsx` | 列表排序/过滤时引起错误 DOM 复用 |
| 64 | Tabs 加号菜单 + 按钮无键盘快捷键 | `CardPanel.tsx` | 没有 `Ctrl+Shift+P` 之类快捷键打开面板添加菜单 |
| 65 | 面板切换无过渡动画 | `CardPanel.module.css` | `hidden`/`display:none` 直接硬切换 |
| 66 | 无面板加载骨架屏 | `CardPanel.tsx` | 各面板首次挂载时无 loading 态过渡 |
| 67 | 无面板级错误恢复 UI | `CardPanel.tsx` | 除通用 AppErrorBoundary 外无"重试"或"关闭此面板"入口 |
| 68 | `data-resizing` 属性已定义 CSS 但 JSX 从未设置 | `Workspace.tsx` / CSS | CSS `.column[data-resizing="true"]{transition:none}` 但 JSX 只依赖 `body.resizing-active` |
| 69 | `WorkspaceEmptyState` 无快捷操作按钮 | `WorkspaceEmptyState.tsx` | 无"新建对话"或"添加面板"按钮 |
| 70 | 拖拽过程中组件卸载时指针事件可能残留 | `Workspace.tsx` | `finishPointer` 中 `getWorkspaceStoreState()` 在 unmount 后可能仍执行 |
| 71 | 极端窗口缩小(<400px)时可能水平溢出 | `Workspace.tsx` / CSS | 列最小宽度 `min-width: 250px` |

---

## 4. 对话面板 (ChatCard/Composer/MessageList)

### 4.1 严重缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 72 | `userMsgId` 毫秒级碰撞 | `useChatStream.ts:1280`, `ChatCard.tsx:946` | `user-msg-${Date.now()}` 无随机后缀，同毫秒两条消息 ID 相同 |
| 73 | `onRunError` 不更新消息状态 | `useChatStream.ts:895-923` | 网络失败后不调用 `setSessionMessageStatus`，消息永久 `'processing'` |
| 74 | 发送后强制切回旧会话 | `useChatStream.ts:1442-1443` | `store.activeSessionId !== sessionId` 时强制 `setActiveSessionId`，覆盖用户导航 |
| 75 | 粘贴图片时剪贴板文本丢失 | `ChatCard.tsx:371-394` | `handlePasteImage` 检测到图片后 `e.preventDefault()` 但不提取 `text/plain` 内容 |

### 4.2 中等缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 76 | 同名非图片附件被静默丢弃 | `ChatCard.tsx:360-366` | `addAttachments` 中重复名称的非图片附件因无 `dataUrl` 被 `filter(Boolean)` 删除 |
| 77 | 附件列表与会话解耦 | `ChatCard.tsx:349` | `attachments` 是组件本地 state，切换会话时不清空也不恢复 |
| 78 | `composerDrafts` 未持久化 | `layoutStore.ts:766` | 页面刷新后所有会话草稿丢失 |
| 79 | 审批 busy 锁无队列机制 | `ChatCard.tsx:581-620` | 多个审批可并行排队，第二个请求被静默丢弃 |
| 80 | 审批乐观更新后 daemon 拒绝时无回滚 | `ChatCard.tsx:617` | `daemonApproveTool` 失败后 toolCall 永远卡在 `running` |
| 81 | 空态 composer 使用 `React.cloneElement` | `ChatCard.tsx:892` | 反模式，应通过 prop drilling 或 context 传递 className |
| 82 | scrollToBottom FAB 硬编码 `bottom:148px` | `ChatStatusRibbons.css` | composer 多行时可能遮挡 |
| 83 | 空态 loading 时完全空白(无骨架屏) | `ChatCard.tsx:674-688` | `messagesLoading` 时 DOM 为空 |
| 84 | 模型切换后不重载会话数据 | `ChatCard.tsx:210-216` | `model-changed` 事件只更新显示不重载数据 |
| 85 | 搜索高亮只做跳转不做视觉高亮 | `ChatCard.tsx:296-300` | `localMsgFilter` 只过滤，不展示匹配文本高亮 |
| 86 | 消息窗口化无 DOM 虚拟化 | `ChatMessageList.tsx` | 展开全部时 500 条消息全部挂载，DOM 节点线性增长 |
| 87 | IME 合成期间鼠标点击发送按钮不被阻止 | `ChatComposer.tsx:126-129` | `trySend` 不检查 `isComposing`，可能发送未完成的中文输入 |
| 88 | 附件移除按名称匹配 | `ChatCard.tsx:575` | 同名附件移除可能误删 |
| 89 | 水合超时硬编码 3000ms | `ChatCard.tsx:673` | 无配置/重试/自适应 |
| 90 | 空态无骨架屏/占位 | `ChatCard.tsx:674-688` | loading 时 DOM 完全为空 |
| 91 | `handleRegenerateRow` 线性扫描找 user 消息 | `ChatMessageList.tsx:428-435` | 每次重生成都 O(n) 从后往前扫描 |
| 92 | Pinned bar 的 `content-visibility: auto` 可能导致 subpixel 渲染问题 | `ChatMessageList.tsx CSS:9` | sticky 定位的 pinnedBar 使用 `content-visibility: auto` |
| 93 | 展开消息步进值固定，非动态计算 | `ChatMessageList.tsx:222,344` | `expandOlderStepCount` 返回固定步长而非根据屏幕高度 |
| 94 | 用户消息长气泡点击展开检测 `window.getSelection()` 冲突 | `ChatMessageRow.tsx` | 用户想选中文本时也会触发展开 |
| 95 | 助手消息 Markdown 渲染失败无重试 | `ChatMessageRow.tsx` | `parseMarkdownToHtmlAsync` 失败时只纯文本 fallback |
| 96 | 消息无时间戳 tooltip 显示完整日期 | `ChatMessageRow.tsx` | 行内只显示 HH:mm |
| 97 | 消息无评价/反馈按钮 | `ChatMessageRow.tsx` | 无 👍/👎 反馈 |
| 98 | 审批 dock 无"全部允许"批量操作 | `ChatStatusRibbons.tsx` | 只能点击跳转，不能批量通过 |
| 99 | 计划批准后无撤销 | `ChatStatusRibbons.tsx` | `approve plan` 后不能 unapprove |
| 100 | 引擎同步无进度反馈 | `ChatStatusRibbons.tsx` | "sync-engine" soft-hint 点击后无同步进度指示 |
| 101 | `listBackgroundTasks` 错误静默 | `ChatStatusRibbons.tsx:428-431` | catch 块完全忽略错误 |
| 102 | 后台任务轮询永不停止(跨 ChatCard 实例) | `ChatStatusRibbons.tsx:434` | 多个 ChatCard 实例每个都会轮询 |
| 103 | 审批 dock 脉冲动画无 `prefers-reduced-motion` 兼容 | `ChatStatusRibbons.tsx CSS:370-377` | 只停了 dock dot 和 goal meter，动态芯片动画未禁用 |
| 104 | `runNotice` 不从组件卸载时清理 | `ChatStatusRibbons.tsx` | 组件卸载后 `runNotice` 可能残留 |
| 105 | ChatHeaderMore 菜单项太少 | `ChatHeaderMore.tsx` | 只有搜索和导出 2 项 |
| 106 | `runSearch`/`runExport` 通过 `emitUiEvent` 间接通信 | `ChatHeaderMore.tsx:121-131` | 链路过长，增加调试难度 |
| 107 | 工具行嵌套不支持 | `ChatToolCallBlock.tsx` | 子工具调用不能嵌套展开 |
| 108 | 工具输出不支持搜索 | `ChatToolCallBlock.tsx` | 展开体内容不支持在工具输出中搜索 |
| 109 | 工具失败无重试按钮 | `ChatToolCallBlock.tsx` | 需要用户重新生成整个助手消息 |
| 110 | 工具无耗时显示 | `ChatToolCallBlock.tsx` | 不显示每个工具的运行时长 |
| 111 | `ToolResultBody` 使用局部类型而非共享类型 | `ChatToolCallBlock.tsx:138-155` | 与 `MessageToolCall` 可能漂移 |
| 112 | 工具行 `toolRowHead` 用 div 模拟 button | `ChatToolCallBlock.tsx:523-545` | `div + role="button" + tabIndex` 常见但不够规范 |
| 113 | `findAgentForTool` 子串匹配有误报风险 | `ChatToolCallBlock.tsx:90-95` | `exp.includes(a.description.slice(0,24))` 模糊匹配 |
| 114 | `flattenRenderTools` 丢失分组信息 | `ChatToolCallBlock.tsx:578-585` | 所有工具在同一层级展平 |
| 115 | `toolResultBody` `max-height: 40vh` 固定 | tool CSS:189 | 容器高度变化时可能过短或过长 |
| 116 | ChatEmptyState 快捷 prompt 硬编码 | `ChatEmptyState.tsx:354-370` | 不能根据项目上下文动态生成 |
| 117 | ChatEmptyState `session-empty` 副标题 CSS `display:none` | `ChatEmptyState.module.css:34-36` | 副标题被全局隐藏 |

---

## 5. 工具面板

### 5.1 代码重复

| # | 问题 | 文件 | 描述 |
|---|------|------|------|
| 118 | OverviewCard 与 RuntimePanel ~300 行重复 | `OverviewCard.tsx` + `RuntimePanel.tsx` | daemon 连接管理、轮询、审批操作逻辑完全一致 |
| 119 | AgentCard 与 InlineAgentPanel 大量重复 | `AgentCard.tsx` + `InlineAgentPanel.tsx` | `streamCollaboratorRun` 回调处理几乎完全相同 |
| 120 | FileIcon 组件重复定义 | `OverviewCard.tsx` + `FilesCard.tsx` | 两个组件各自定义了相同功能的 FileIcon |

### 5.2 OverviewCard

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 121 | 无"全部收起/展开"一键操作 | - | - |
| 122 | 改动区段无 `git diff` 增量搜索 | - | - |
| 123 | 无定时任务 CRUD(创建/编辑/删除) | - | 仅展示 |
| 124 | 后台任务无法停止/取消 | - | 仅可查看输出 |
| 125 | 无用量历史趋势图表 | - | - |
| 126 | 协作体区段无直接展开详情的功能 | - | 只能点开侧栏 |
| 127 | 计划任务区段不支持排序/筛选 | - | - |
| 128 | `onShowToast` prop `@deprecated` 但保留 | - | 被误用的可能 |
| 129 | 各折叠区段 empty 态不够细致 | - | 只有"无"或 `emptyQuiet` |
| 130 | 协作体运行排前但无优先级分组视觉区分 | - | - |
| 131 | `tokenPercent` 计算了但从未在 JSX 中使用 | - | 无进度条 |
| 132 | 审批按钮使用全局 class 依赖全局 CSS | - | 全局样式未定义时视觉异常 |
| 133 | Git 操作错误行内提示定时自动消除，但无手动关闭 | - | - |

### 5.3 FilesCard

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 134 | 无文件重命名(Rename)操作 | - | - |
| 135 | 无创建新文件/目录功能 | - | 只能选择已有项目文件夹 |
| 136 | 无多选、批量操作 | - | - |
| 137 | 无 Git 状态标记在文件树上 | - | 只在 Overview 有 |
| 138 | 无文件搜索/全局搜索 | - | 只有当前目录筛选 |
| 139 | 无文件最近打开历史 | - | - |
| 140 | 无图片缩略图(只显示类型图标) | - | - |
| 141 | 虚拟滚动仅有垂直方向，overscan 只有 10 行 | - | 高速滚动可能出现短暂白屏 |
| 142 | 展开状态用 `expanded` map 存储在内存中 | - | 大目录树展开多个层级时性能下降 |
| 143 | 编辑能力有限(只支持文本/CSV) | - | 无语法错误提示、自动补全、diff |
| 144 | CSV 解析不支持转义引号、多行字段 | - | `parseCsvPreview` 简单实现 |
| 145 | 面包屑 flyout 加载后保持 state，大目录性能下降 | - | 几千文件时列表渲染下降 |
| 146 | 无 ErrorBoundary 包裹 | - | hljs 高亮异常导致整个详情面板崩溃 |
| 147 | 编辑保存无冲突检测(文件已被外部修改) | - | 直接 `writeTextFile` |

### 5.4 DiffCard

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 148 | 无 inline edit / 手动编辑 diff 后应用 | - | - |
| 149 | 无 diff 统计图表(增减行趋势) | - | - |
| 150 | 无 Stash 操作 | - | - |
| 151 | 无交互式 rebase / merge 工具 | - | - |
| 152 | 无 blame / 历史查看 | - | - |
| 153 | 文件级对比模式切换后不持久化 | - | `fileCompareModes` 存在但不持久 |
| 154 | 无 diff 导出功能 | - | - |
| 155 | 代码冗长(1942 行)，三个虚拟 viewer 大量重复 | - | 巨型组件 |
| 156 | `renderItems` 多处使用 `any` | - | 丧失 TypeScript 类型安全 |
| 157 | 折叠算法索引在展开/压缩后可能漂移 | - | `expandedBlocks[fileKey]?.[i]` |
| 158 | Git 加载过程复杂，可能慢 | - | 占位→batch→逐个最多 8 个 |
| 159 | 提交面板无分支名显示 | - | - |
| 160 | 虚拟滚动无 `tabIndex`，键盘无法滚动 | - | - |
| 161 | 中文/英文混用提示 | - | - |

### 5.5 TerminalCard

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 162 | 无真正的交互式 shell(不支持 `top`/`vim`/`ssh` 等) | - | 只有命令输入+输出回显 |
| 163 | 无终端 Tab/多标签页 | - | - |
| 164 | 无自定义字体/字号设置 | - | - |
| 165 | 无 ANSI 颜色解析 | - | 纯文本输出 |
| 166 | 无命令补全(Tab) | - | - |
| 167 | 无当前工作目录指示 | - | 只显示项目名，无实时 pwd |
| 168 | 无终端分屏 | - | - |
| 169 | 无输出搜索 | - | - |
| 170 | `getLineType` 错误行检测依赖于中英文混用关键词 | - | 漏报率较高 |
| 171 | 命令历史 80 条硬限制 | - | 大型会话可能丢失历史 |
| 172 | 非 PTY 实现，对实时输出流支持有限 | - | - |

### 5.6 PreviewCard

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 173 | 无 HTTPS 降级警告 | - | - |
| 174 | 无 SSL 证书错误处理 | - | - |
| 175 | 无移动端视口模拟 | - | - |
| 176 | 无 DevTools 集成 | - | - |
| 177 | 无请求拦截/日志 | - | - |
| 178 | 无多标签页 | - | - |
| 179 | 无页面截图功能 | - | - |
| 180 | 无 URL 自动补全 | - | - |
| 181 | iframe sandbox `allow-scripts + allow-same-origin` 可被利用 | - | CSP 需要更严格 |
| 182 | 跨域 iframe 加载失败时 `onError` 可能不会被触发 | - | CORS 问题 |

### 5.7 RuntimePanel

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 183 | 无 CRUD 操作(不能创建/编辑/删除计划任务) | - | 只有"管理"按钮 emit 事件 |
| 184 | 无引擎日志/详情查看 | - | - |
| 185 | 无用量按会话/按时间段归因 | - | - |
| 186 | 无代理/daemon 状态详情 | - | 连接延迟、版本号 |
| 187 | 无资源使用监控(CPU/内存) | - | - |

### 5.8 ScheduledTasksPanel

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 188 | 无复杂 cron 表达式编辑器 | - | 只能使用 preset/daily/interval |
| 189 | 无日历视图 | - | - |
| 190 | 无运行日志详情 | - | - |
| 191 | 无任务依赖关系设置 | - | - |
| 192 | 无通知设置(完成/失败时通知) | - | - |
| 193 | 无失败重试策略设置 | - | - |
| 194 | localStorage 缓存可能与其他窗口不同步 | - | 无 `storage` 事件监听 |
| 195 | `busy` 状态控制所有交互按钮，精细度不够 | - | 一个 workflow 触发中，其他全禁用 |

### 5.9 AgentCard / InlineAgentPanel

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 196 | 无人工委派 agent 功能 | - | 只能由主 AI 自动拉起 |
| 197 | 无 agent 模式选择/创建 | - | 只能使用已有 agent |
| 198 | 无 agent 配置(temperature, system prompt) | - | - |
| 199 | 无 agent 运行耗时详情 | - | 只显示总时长 |
| 200 | 无并行多 agent 同时显示 | - | - |
| 201 | AgentBrowsePad 骨架屏静态 3 个卡片与实际不符 | - | - |
| 202 | `chat-footer` 依赖全局 class (与 ChatCard CSS 冲突可能) | - | - |
| 203 | 焦点/代数管理复杂(多个 ref) | - | 出错概率高 |
| 204 | `handleSend` → `startFollowUpRun` 流程复杂，可能流双开 | - | - |
| 205 | AgentCard 和 InlineAgentPanel 状态同步不一致(一个轮询一个不轮询) | - | - |

### 5.10 其他工具组件

| # | 问题 | 文件 | 描述 |
|---|------|------|------|
| 206 | ApprovalAskCard `fireAllow` 480ms 锁在慢速网络下仍可能重复提交 | `ApprovalAskCard.tsx` | - |
| 207 | ApprovalAskCard Enter 快捷键永远不会触发"记住"路径 | `ApprovalAskCard.tsx` | `fireAllow(false)` 传固定值 |
| 208 | ApprovalAskCard focus trap 只在 confirmArmed 时注册 | `ApprovalAskCard.tsx` | 非武装状态下 Tab 可跳出 |
| 209 | ChangeOverviewCard `resolved` 状态使用本地 `useState`，父组件重挂载时丢失 | `ChangeOverviewCard.tsx` | - |
| 210 | ChangeOverviewCard 无加载态(接受/拒绝过程无进度指示) | `ChangeOverviewCard.tsx` | 只显示"应用中…"文本 |
| 211 | ModelPicker `flatModels` 每次 `tick` 变化重新调用 `listPickerProfiles` | `ModelPicker.tsx` | 打开菜单可能卡顿 |
| 212 | ModelBadgePickerMenu Hover 菜单在触屏设备不可用 | `ModelBadgePickerMenu.tsx` | 完全依赖 `onMouseEnter/Leave` |
| 213 | ModelBadgePickerMenu `ChevronLeft` 图标方向错误 | `ModelBadgePickerMenu.tsx` | 子菜单在右侧但图标指向左 |
| 214 | PermissionModeMenu portal 定位不稳定(使用 `bottom` 定位) | `PermissionModeMenu.tsx` | 按钮在视口下方时 `pos.bottom` 可能为负 |
| 215 | ProjectPickerMenu 使用 `Function('return import(...)')()` 动态加载 | `ProjectPickerMenu.tsx` | CSP 严格环境会被禁止 |
| 216 | ComposePlusMenu 所有插件项跳转到同一页面(无细分导航) | `ComposePlusMenu.tsx` | "插件"/"MCP 工具"/"扩展中心"都调用 `openSettings('plugins')` |
| 217 | AgentTeamBoard `summarySnippet` 内容过长，Tooltip 可能溢出 | `AgentTeamBoard.tsx` | 最大 72 字符 |
| 218 | AgentTeamBoard `CSS.escape` 在旧浏览器中可能不存在 | `AgentTeamBoard.tsx` | - |
| 219 | FontSettingsSection `apply` 函数快速调用时可能产生竞态 | `FontSettingsSection.tsx` | `setFontPreferences` 是异步的 |

---

## 6. 设置面板

### 6.1 SettingsPanel 框架

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 220 | `allowedTabIds` 形同虚设 | `SettingsPanel.tsx:89-91` | 始终返回 `[...FORMAL_TAB_IDS]`，`mcpAvailable` 参数未用于过滤 |
| 221 | 无设置重置入口(恢复所有设置出厂值) | - | - |
| 222 | 无 tab 拖拽排序(侧栏 tab 固定顺序) | - | - |
| 223 | 搜索匹配算法粗糙(用 `includes` 而非分词) | `SettingsPanel.tsx:211-217` | 输入"模型密钥"匹配不到"模型"tab |
| 224 | 无焦点陷阱，Tab 键可能跳出设置弹层 | `SettingsPanel.tsx:436` | - |
| 225 | 无 loading 骨架屏 | `SettingsPanel.tsx:53-57` | 仅文本"加载 {tabName}…" |
| 226 | `safeActiveTab` 回退链冗余 | `SettingsPanel.tsx:286-289` | 三层回退中有两层是多余的 |

### 6.2 SettingsProfileTab

| # | 问题 | 描述 |
|---|------|------|
| 227 | 无用户登录/登出(无账户头像、邮箱、注销) | - |
| 228 | 无多工作区管理 | - |
| 229 | 无云端同步 | - |
| 230 | 无数据清理按钮 | - |
| 231 | 无应用版本号显示 | - |
| 232 | 导出导入无成功反馈 | - |
| 233 | Daemon WS 测试结果处理不一致(成功行内不 toast，失败既行内又 toast) | - |

### 6.3 SettingsAppearanceTab

| # | 问题 | 描述 |
|---|------|------|
| 234 | 10 秒定时器在 tab 不可见时仍在运行 | - |
| 235 | Schema 和传统渲染混合(风格不统一) | - |
| 236 | `handleSave` 每个 prop 单独 `if`(多次 save 调用) | - |
| 237 | 皮肤选项按主题重建后，当前选中皮肤可能在新主题中不存在 | - |
| 238 | 无字体预览 | - |

### 6.4 SettingsPersonalizeTab

| # | 问题 | 描述 |
|---|------|------|
| 239 | `sendShortcut` 通过 localStorage 直接存取，不走 settings schema | - |
| 240 | `handleSave` 中 `tabModeEnabled` 做了乐观更新+回滚，其他 boolean 字段没有 | - |
| 241 | 无加载态区分(设置 null 时 Schema 完全不渲染) | - |

### 6.5 ModelsSettingsTab

| # | 问题 | 描述 |
|---|------|------|
| 242 | `parseInt` 缺少 radix 参数 | 第 480 行 |
| 243 | 大量内联样式(20+ 处) | - |
| 244 | 级联选择器使用 `createPortal` 到 body，未正确处理滚动容器边界 | - |
| 245 | `addFromTemplate` 创建的服务商 baseUrl 硬编码 | - |
| 246 | 模型展开配置面板状态管理复杂(`cfgDraft`/`configOpenId`/`manualOpen` 交织) | - |
| 247 | 删除服务商使用 `window.confirm` | - |

### 6.6 SettingsUsageTab

| # | 问题 | 描述 |
|---|------|------|
| 248 | 无 API 调用次数统计 | - |
| 249 | 无按时间范围筛选 | - |
| 250 | 无导出用量数据 CSV | - |
| 251 | 无预算/限额告警设置 | - |
| 252 | `chartBarStack` 最小高度 4%(数据为 0 时仍有空白) | - |
| 253 | 柱状图颜色固定，不跟随主题 | - |
| 254 | 价格弹窗无 Esc 关闭 | - |
| 255 | 价格编辑未聚焦到第一个输入 | - |

### 6.7 SettingsRulesTab

| # | 问题 | 描述 |
|---|------|------|
| 256 | 无规则排序/拖拽调整 | - |
| 257 | 无规则版本历史 | - |
| 258 | 无规则导入/导出 | - |
| 259 | 全文编辑器的 `aria-describedby` 指向一个 `hidden` 的 p 标签 | - |
| 260 | 保存和同步混合触发(引擎失败时用户无法区分保存还是同步失败) | - |

### 6.8 SettingsScheduleTab

| # | 问题 | 描述 |
|---|------|------|
| 261 | 无编辑已有任务(只能删除重建) | - |
| 262 | 12 秒超时硬编码 | - |
| 263 | `handleAiCreateSchedule` 调用 `closeSettings()` 后 `emitUiEvent('open-chat')`，异步关闭可能导致事件丢失 | - |
| 264 | 表单验证仅返回字符串错误，无字段级精确提示 | - |
| 265 | 筛选操作后没有重置 `createMode` | - |

### 6.9 SettingsExtensionsTab

| # | 问题 | 描述 |
|---|------|------|
| 266 | 搜索不高亮匹配文本 | - |
| 267 | 无扩展版本号显示 | - |
| 268 | 无扩展更新机制 | - |
| 269 | 无分类浏览 | - |
| 270 | SkillsSettingsTab 被 lazy 加载两次 | - |
| 271 | `hydratedRef` 逻辑与 `refresh` 耦合(一方为空才显示 loading) | - |
| 272 | MCP 工具列表最多显示 12 个，无展开全部 | - |
| 273 | 安装插件后 `refresh()` 有 4 秒超时 | - |

### 6.10 SkillsSettingsTab

| # | 问题 | 描述 |
|---|------|------|
| 274 | `discoverCandidates` 弹窗使用 `role="dialog"` 但 `aria-modal="false"` | - |
| 275 | 批量确认 4 秒超时自动取消 | - |
| 276 | `handleSyncAll` 无同步进度显示 | - |
| 277 | 文件系统不可用时只一行警告，无引导 | - |
| 278 | `scopeFilter` 改变时 `refresh` 读到的 `scopeFilter` 可能是旧值 | - |

### 6.11 McpSettingsTab

| # | 问题 | 描述 |
|---|------|------|
| 279 | 正式模式只读(不能编辑/添加 MCP 配置) | - |
| 280 | Demo 模式与正式模式代码高度重复 | - |
| 281 | 无自动刷新机制，需手动点刷新 | - |
| 282 | 状态显示 `aria-label` 未随 `mcpStateLabel` 更新 | - |

### 6.12 SettingsShortcutsTab

| # | 问题 | 描述 |
|---|------|------|
| 283 | 存储仅用 localStorage，不走 `clientApi.saveSettingsEx` | - |
| 284 | `isValidShortcutValue` 验证宽松(64 字符限制) | - |
| 285 | 录制期间全局键盘监听，Tab 等组合键可能与焦点行为冲突 | - |
| 286 | `flatIds` 长度变化时 `focusIndex` 不自动调整到可见项 | - |

### 6.13 SettingsSecurityTab

| # | 问题 | 描述 |
|---|------|------|
| 287 | 无文件系统权限设置 | - |
| 288 | 无网络访问权限设置 | - |
| 289 | 无环境变量白名单 | - |
| 290 | 无安全日志/审计 | - |
| 291 | `transitionPermissionMode` catch 不显示具体原因 | - |
| 292 | 白名单 `isBlockedWhitelistRisk` 合并了 hardDeny 和 critical/high | - |
| 293 | 清除白名单用 `window.confirm` | - |
| 294 | 工作区路径只显示最多 3 个 | - |

### 6.14 SettingsSelect / SettingsUI / SettingsSchemaRenderer

| # | 问题 | 文件 | 描述 |
|---|------|------|------|
| 295 | SettingsSelect 严重缺失键盘导航 | `SettingsSelect.tsx` | 方向键/Enter/Esc 均无处理 |
| 296 | SettingsSelect 的 `place()` 无 resize 监听 | `SettingsSelect.tsx` | resize/scroll 时位置不准确 |
| 297 | SettingsUI Tooltip 使用 `React.cloneElement` | `SettingsUI.tsx` | 子元素为函数组件且不接受额外 prop 时出错 |
| 298 | SettingsUI Tooltip 定位不更新 | `SettingsUI.tsx` | 只在 `mouseEnter` 时取一次 rect |
| 299 | SettingsUI SettingsRow 中嵌套 button | `SettingsUI.tsx` | `SettingsRow` 用 `<button>` 包裹，内部 control 又是 button，语义不合法 |
| 300 | SettingsSchemaRenderer `idsMap` 用 `Math.random()` 生成 id | `SettingsSchemaRenderer.tsx` | SSR 或测试环境下不同渲染的 id 不同 |
| 301 | SettingsSchemaRenderer Range 滑块使用内联 `accentColor` | `SettingsSchemaRenderer.tsx` | 主题色可能与滑块耦合不佳 |
| 302 | SettingsSchemaRenderer 所有属性变更立即触发 save | `SettingsSchemaRenderer.tsx` | 无"取消/确认"机制 |

---

## 7. Workspace Chrome Bars

### 7.1 严重缺陷

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 303 | 会话标签嵌套 role 冲突 | `WorkspaceChromeBars.tsx:488-513` | 外层 `role="tab"` div + 内层 button，屏幕阅读器双焦点 |
| 304 | `sessionTabs` 依赖完整 `sessions` 数组 | `WorkspaceChromeBars.tsx:137-149` | 任何流式消息更新都引起 `knownMap`/`sessionsInWorkspace`/`sessionTabs` 重算 |

### 7.2 中等缺陷

| # | 问题 | 行 | 描述 |
|---|------|-----|------|
| 305 | `crish-sidebar-resize` 事件未处理 | `WorkspaceChromeBars.tsx` | 右侧面板切换按钮状态可能不反映实际折叠状态 |
| 306 | `variant='both'` 时创建两个独立 hook 实例 | `WorkspaceChromeBars.tsx:562-567` | 重复的事件监听和 localStorage 读取 |
| 307 | 关闭最后一个标签后 `activeSessionId` 为幽灵 ID | `WorkspaceChromeBars.tsx:207-208` | `nextActiveId=null` 时不调用 `setActiveSessionId` |
| 308 | 活动会话追踪可能无限加标签 | `WorkspaceChromeBars.tsx:74-85` | 快速点击侧栏会填满 16 个标签槽位 |
| 309 | 加号菜单溢出视窗风险 | `WorkspaceChromeBars.tsx` CSS | `left: 0` 绝对定位未适配滚动位置 |
| 310 | 隐藏滚动条降低可发现性 | `WorkspaceChromeBars.module.css` | `scrollbar-width:none` Windows 用户无法发现可滚动区域 |
| 311 | 无 focus-visible 样式 | `WorkspaceChromeBars.module.css` | - |
| 312 | Pin 图标无交互(不可点击切换置顶) | `WorkspaceChromeBars.tsx:499-501` | 只能通过侧栏切换 pin 状态 |
| 313 | 会话标签无拖拽排序 | - | - |
| 314 | 标签无右键菜单 | - | - |
| 315 | 关闭按钮 `aria-label` 正确但图标无 `aria-hidden` | `WorkspaceChromeBars.tsx:511` | 应验证 |
| 316 | `selectWorkspace` 中 `getState()` 的竞态风险 | `WorkspaceChromeBars.tsx:156` | starch closure(zombie child) |
| 317 | `SessionStrip` 不接受 `onAddProject` prop | `WorkspaceChromeBars.tsx:472` | 会话行 + 号永远不会触发"添加本地项目" |
| 318 | 标签超 16 个无声裁掉 | `workspaceChromeTabs.ts:152` | `slice(-16)` 无 UI 提示 |
| 319 | 归档会话标签残留(只在 UI 消失不清理 localStorage) | `WorkspaceChromeBars.tsx:104-149` | - |
| 320 | 播种与 `activeSessionId` 可能不一致 | `WorkspaceChromeBars.tsx:137-149` | 关闭最后一个标签后播种的 6 个不一定包含活动会话 |
| 321 | CSS `!important` 过多 | `WorkspaceChromeBars.module.css` | 多处 `!important` 表明与外部样式冲突 |

---

## 8. 辅助/额外功能

### 8.1 CheatsheetModal

| # | 问题 | 描述 |
|---|------|------|
| 322 | 快捷键列表只显示 4 个，App 实际支持 12+ 个 | - |
| 323 | 无可搜索/过滤的快捷键列表 | - |
| 324 | 模态框无自己的 Escape 处理器(完全依赖 App 全局 keydown) | - |
| 325 | `Tooltip` 从 `SettingsUI` 同步导入(触发 SettingsPanel chunk 加载) | - |
| 326 | 动画状态与 CSS 类名重复(`animation: sheetIn` + 外部过渡同时运行) | - |

### 8.2 FirstRunWizard

| # | 问题 | 描述 |
|---|------|------|
| 327 | 无步骤动画/过渡 | - |
| 328 | 无进度保存(刷新后进度丢失) | - |
| 329 | `projectTick` 状态变量是无意义的空访问 | 第 304 行 |
| 330 | 选择文件夹无 busy 加载指示器 | - |
| 331 | 原生对话框在浏览器中失败时错误信息笼统 | - |
| 332 | 步骤 0 无法通过键盘关闭 | - |
| 333 | 模型输入选择/手填存在双向绑定冲突 | - |
| 334 | FirstRunWizard 未被 AppErrorBoundary 包裹 | - |
| 335 | 跳过项目后，用户首次"新对话"创建在 GENERAL_FOLDER，无法引导用户选工作目录 | - |
| 336 | 避控制符验证规则过于严格 | 第 99 行 |

### 8.3 openSessionInNewWindow

| # | 问题 | 描述 |
|---|------|------|
| 337 | 使用 Blob URL + document.write 方式生成只读快照，功能有限 | - |
| 338 | 样式简陋(内联 style)，不是完整应用体验 | - |
| 339 | 无 popup blocker 提示 | - |
| 340 | 消息截断 2000 字符 | - |

---

## 9. API/Store/Hooks 层

### 9.1 Store 架构

| # | 问题 | 文件 | 描述 |
|---|------|------|------|
| 341 | 三个 store(session/workspace/settingsUi) 仍是同一 zustand 实例的别名 | `store/` | 任何状态更改触发所有其他订阅者的重选择 |
| 342 | `sessionsById` 索引在 10+ 个位置手动调用 `reindexSessionsById` | `sessionActions.ts` | 任何修改 sessions 数组的代码路径都必须显式调用 |
| 343 | `folderOrder` 删除文件夹时无自动 cleanup | `layoutStore.ts` | - |
| 344 | `composerDrafts` 在 `deleteSession` 时未清理 | `sessionActions.ts:859-890` | 内存泄漏 |

### 9.2 sessionActions

| # | 问题 | 描述 |
|---|------|------|
| 345 | `addMessage` 在 `text` 和 `toolCalls` 上调用 `blocks.push` 两次 | 未清除可能已存在的现有块 |
| 346 | `setSessions` 全量替换(无增量/补丁更新) | daemon sync 场景中产生不必要全量渲染 |
| 347 | `deleteSession` 后 `activeSessionId` 可能为空 | `pickFallbackActiveSessionId` 找不到候选时返回 `''` |
| 348 | `pinSession`/`unpinSession` 不主动触发持久化 | 浏览器关闭时最近的 pin 切换可能未保存 |
| 349 | `setSessionMessageStatus` 无状态转换验证 | 任何状态到任何状态的转换都允许 |

### 9.3 themeStore / fontStore

| # | 问题 | 描述 |
|---|------|------|
| 350 | `applyPersonalization` 约 350 行，过度设计的硬编码 HSL 计算 | - |
| 351 | 模板化 `color-mix` 在不同浏览器渲染效果可能不同 | - |
| 352 | 60 秒时光过渡轮询可能产生明显亮度跳变 | - |
| 353 | 主题引擎在 JS 中动态计算 ~40 个 CSS 变量 | 使调试困难 |
| 354 | `isFontInstalled` canvas 测宽法在沙盒环境中不可靠 | - |
| 355 | `listLocalFonts` 同步运行可能阻塞 | - |
| 356 | 内嵌字体仅为拉丁子集(不包含 CJK 字符) | - |

### 9.4 providerProfiles

| # | 问题 | 描述 |
|---|------|------|
| 357 | `resolvePreferredModelSelection` 优先级 4(引擎模型匹配)在 5(密钥+模型)之后检查 | 可能阻止引擎默认模型被使用 |
| 358 | `activateProfileModel` 1 秒超时内不重试 | 引擎异步切换时返回过时状态 |
| 359 | 无 `/v1/models` 端点自动发现 | - |
| 360 | 密钥明文存储在 localStorage | - |

### 9.5 Hooks

| # | 问题 | 文件 | 描述 |
|---|------|------|------|
| 361 | `useChatStream` 批处理器位于 refs 中，不会在 React StrictMode 中正确重新挂载 | - |
| 362 | `useChatAutoScroll` 流式传输时 `userScrolledRef` 可能被覆盖 | - |
| 363 | `useTabDrag` 无触摸/拖放的后备 | - |
| 364 | `useAnimatedPresence` `exitDurationMs` 250ms 硬编码 | - |
| 365 | `useToastQueue` `FORBIDDEN_SUCCESS_TOAST_PATTERNS` 约 60 条正则，维护开销大 | - |

### 9.6 快捷键绑定

| # | 问题 | 描述 |
|---|------|------|
| 366 | `branch_session` 绑定 `Escape Escape` 被 `matchShortcutActions` 永远跳过 | 导致双击 Escape 分叉永久不可用 |
| 367 | 无 Command Palette 默认快捷键(`Ctrl+P`) | - |
| 368 | 无 Diff 面板默认快捷键 | - |
| 369 | macOs 上 `Ctrl` 应显示为 `Cmd`/`⌘` | - |

---

## 10. Daemon 连接与同步

### 10.1 严重缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 370 | 流中断时无恢复机制 | `daemonChatBridge.ts` | `streamViaDaemon` 无 `onState` 监听器，引擎断开会话永远 `processing` |
| 371 | 重连后不自动同步会话 | `App.tsx:286-291` | `syncSessionsFromDaemon` 仅在初始引导时调用 |
| 372 | `keep-alive` 状态遮蔽屏蔽了真正的连接问题 | `engineConfig.ts:497-548` | `fetchEngineStatus` 返回 `{ ok: true, reconnecting: true }`，ChatStatusRibbons 从不显示离线 |

### 10.2 中等缺陷

| # | 问题 | 描述 |
|---|------|------|
| 373 | daemonClient 无 `fetch()` 后备连接方案 | - |
| 374 | `request` 无超时参数传播到 `waitUntilConnected` | - |
| 375 | 无 WebSocket 消息级别速率限制 | - |
| 376 | 流中断后引擎已完成的结果永久丢失 | 无重传请求，无查询 |
| 377 | 断网期间用户消息写入 store 但引擎无记录 | 消息写入 store 但永不确认，无重试机制 |
| 378 | `hydratedFromEngine` 不随重启重新触发 | 会话已水合后设置为 true，重启后本地数据可能陈旧但不重新拉取 |
| 379 | `syncSessionsFromDaemon` `sessionDaemonSync.ts` 与 `mergeDaemonSessions` 在 session 无序时可能比较昂贵 | - |
| 380 | `formatRemoteTime` 无有效时间戳时返回 `new Date().toISOString()` | 可能混淆侧栏基于时间的排序 |
| 381 | 引擎侧 `background-task-started/completed` 事件无客户端显式处理 | 后台任务状态完全依赖 4 秒轮询 |
| 382 | OverviewCard/RuntimePanel 每 4 秒轮询即使面板不可见 | - |

---

## 11. 消息完整性与状态管理

### 11.1 消息内容限制

| # | 问题 | 描述 |
|---|------|------|
| 383 | `SessionMessage.text` 无长度上限 | `types.ts:230` — `text?: string` 无约束 |
| 384 | `SessionMessage.thinking` 无存储上限 | DOM 有 4000 字符上限但存储层无限制 |
| 385 | `MessageToolCall.output` 无存储上限(仅子 agent 截断至 1200) | - |
| 386 | `MessageToolCall.arguments` 无大小限制 | - |
| 387 | 工具输出 `diffs` 无存储上限 | 仅 DOM 有限制(前 8 行) |
| 388 | `StreamTextBatcher` 未设置 `maxBufferedChars` | 缓冲区可能无限增长 |
| 389 | `messagesToJsonl` 无 try-catch 保护 | `JSON.stringify` 抛异常时触发整个会话 100 条 fallback |

### 11.2 消息顺序与状态转换

| # | 问题 | 描述 |
|---|------|------|
| 390 | `setSessionMessageStatus` 无状态转换验证 | `completed → processing` 等回退允许 |
| 391 | 重新生成路径存在 `completed → processing` 回退 | 受控回退但无格式保障 |
| 392 | 引擎消息 ID 未保留(仅本地生成 ID) | 无法端到端追溯 |
| 393 | `StreamTextBatcher` FIFO 顺序虽保证但代码无注释说明 | - |
| 394 | `text-delta` 的 `offset` 向后跳时 `blocks` 可能产生重叠文本 | - |
| 395 | `updateMessageText` 使用全文覆盖，无增量保护 | 每次覆盖意味着乱序 `text-delta` 只影响 `blocks` 不影响 `msg.text` |

### 11.3 附件完整性

| # | 问题 | 描述 |
|---|------|------|
| 396 | 大图片(>10MB)粘贴时 `readAsDataURL` 可能造成内存压力 | 下采样在完全读入后才执行 |
| 397 | 512KB 文本文件边界使用 `<` 而非 `<=` | 恰好 512KB 的文件不读取内容 |
| 398 | MIME 类型在 UI 层保留但不持久化到会话消息 | 附件不存储在 `SessionMessage[]` 中 |

---

## 12. 持久化与存储

### 12.1 严重缺陷

| # | 问题 | 文件:行 | 描述 |
|---|------|---------|------|
| 399 | 关闭软件时 350ms debounce 窗口内数据丢失 | `layoutStore.ts:848-852` | cleanup 只 `clearTimeout` 不调用 `persistAllSessions` |
| 400 | localStorage 超配额静默截断到最近 100 条 | `sessionPersistence.ts:525-529` | `saveSessionBody` catch 后 `slice(-100)`，无用户通知 |
| 401 | `composerDrafts` 完全不持久化 | `layoutStore.ts` | 刷新后所有会话的输入草稿全部丢失 |

### 12.2 中等缺陷

| # | 问题 | 描述 |
|---|------|------|
| 402 | `composerDrafts` 无 `beforeunload` flush | - |
| 403 | `persistAllSessions` 全量序列化 1000+ 条消息可能冻结主线程 200-800ms | Web Worker 已存在但未用于持久化路径 |
| 404 | 多阶段写入非原子(先 index 后 body，部分写失败导致不一致) | - |
| 405 | `saveSessionBody` 增量写入依赖 `persistedMessageCounts`，消息编辑(长度不变内容变)不被检测 | - |
| 406 | 磁盘镜像恢复与 `restoreSessionsFromDiskMirror` 有竞态风险(异步) | - |
| 407 | 索引损坏时所有会话从侧栏消失但 body 数据仍在 localStorage 中成为孤儿 | 无自动恢复机制 |
| 408 | `sessionPersistence` 序列化缺失 `__schemaVersion` 字段 | 新版本解析旧数据时静默丢弃新字段 |
| 409 | 磁盘镜像 body 已写但 index 未写时无法检测不完整镜像 | - |
| 410 | `persistAllSessions` 中 `saveSessionIndex` 和 `saveSessionBody` 反向顺序(先 index 后 body)不如磁盘镜像(先 body 后 index)安全 | - |
| 411 | 无 `navigator.storage.estimate()` 预检查 | - |

---

## 13. 审批与工具执行

### 13.1 严重缺陷

| # | 问题 | 描述 |
|---|------|------|
| 412 | 引擎发 `approval-requested` 后断开，审批永久卡死 | `ApprovalFlowMachine` 无 WebSocket close handler，pending 审批永不超时 |
| 413 | `tool-end` 未收到时工具永久 `running` | `finish()` 1200ms 超时只收口流不更新工具状态 |
| 414 | `daemonApproveTool` 失败无回滚 | toolCall 永久卡在 `running` |

### 13.2 中等缺陷

| # | 问题 | 描述 |
|---|------|------|
| 415 | `publishToolDiffs` 第二次调用时可能创建重复条目 | 去重逻辑未检测刚推入的条目 |
| 416 | `onToolError` 覆盖 `tc.diffs` 为 undefined | 状态变为 error 时丢失已有的 diff 信息 |
| 417 | 二次确认后引擎拒绝，UI 先"已批准"再变"未获批准"(乐观更新变永久谎言) | - |
| 418 | `commitLockRef` 480ms 超时释放后用户可再次点击 | 但引擎端静默忽略(仅 UI 层面) |
| 419 | 审批 dock 无"全部拒绝"功能 | - |
| 420 | 审批卡片无"查看上下文"跳转 | - |
| 421 | 审批无超时自动拒绝 | - |
| 422 | `collectPendingApprovals` 容忍空值条目(流式发送 `pending_approval` 无 id 时漏计) | - |

---

## 14. 多会话/工作区/项目隔离

### 14.1 严重缺陷

| # | 问题 | 描述 |
|---|------|------|
| 423 | `diffFiles` 是全局的，不按会话/项目隔离 | 切换项目后项目 A 的改动仍在项目 B 的变更面板中 |
| 424 | `chatMainSurface` 是全局的，不按会话隔离 | 会话 A 打开定时任务后切换到 B，B 也显示定时任务 |

### 14.2 中等缺陷

| # | 问题 | 描述 |
|---|------|------|
| 425 | `withdrawMessage` 清理 `diffFiles` 但不清理 `tc.diffs` | 重新打开时已接受的改动重新出现 |
| 426 | `removeDiffFile` 不清除消息中的 `tc.diffs` | `diffFiles` 与 `tc.diffs` 去同步 |
| 427 | 分叉会话共享 `diffFiles` | 分支 A 和 B 的改动全部混在一起 |
| 428 | 旧 AI 改动无老化机制 | 未接受的改动靠 `MAX_DIFF_FILES`(50)硬上限截断 |
| 429 | 添加项目后旧会话 `folder` 不自动关联 | `canonicalSessionFolder` 对 `GENERAL_FOLDER` 直接返回不匹配新项目 |
| 430 | 所有工作区共享同一个 `activeSessionId` | 无工作区级别的会话隔离 |

---

## 15. 错误处理与恢复

### 15.1 严重缺陷

| # | 问题 | 描述 |
|---|------|------|
| 431 | `withdrawMessage` 不可逆(无 undo) | `slice(0, idx)` 破坏性操作，无消息快照保存 |
| 432 | 重生成时引擎失败，旧 assistant 消息永久丢失 | 先 `withdrawMessage` 截断再新流，引擎失败时无法回退 |

### 15.2 中等缺陷

| # | 问题 | 描述 |
|---|------|------|
| 433 | `onRunError` 不触发 `drainQueuedAfterComplete` | 排队消息永远卡在 `'queued'` |
| 434 | `handleStopGeneration` 后不调用 `drainQueuedAfterComplete` | - |
| 435 | `streamViaDaemon` 无指数退避重试 | - |
| 436 | 无后台定时器检测卡住的 `'processing'` 消息并尝试恢复 | - |
| 437 | main.tsx `StrictMode`/`createRoot` 的动态 import 方式脆弱 | 重命名和解构可能导致 `undefined` |
| 438 | React.lazy chunk 加载失败时 Suspense fallback 无重试按钮 | - |
| 439 | 缓存的大部分 `catch` 块空或仅 `console.warn`，用户无感知 | - |
| 440 | `moveSessionRealtime` / `branchSession` 跳过 `reindexSessionsById` | 正常情况下安全但审计更困难 |

---

## 16. 并发操作竞态条件

### 16.1 严重缺陷

| # | 问题 | 描述 |
|---|------|------|
| 441 | 双击发送同毫秒产生重复 `userMsgId` | `user-msg-${Date.now()}` 无随机后缀 |

### 16.2 中等缺陷

| # | 问题 | 描述 |
|---|------|------|
| 442 | `isAiBusy` 双处理窗口(两次 `handleSendChat` 都读到 `isAiBusy=false`) | 第二个流覆盖第一个，消息内容不丢但流被替换 |
| 443 | 消息排队无最大深度限制 | 用户可无限点击发送，产生大量 `'queued'` 消息 |
| 444 | 关闭标签 + 打开面板交替调用可能导致布局状态短暂不一致 | `focusOrOpenPanel` 三个独立 `set()` 可能被交织的 React effect 打断 |
| 445 | `handleSendChat` 中 `ensureSessionMessages` 两次独立快照 | session 在两次检查之间被删除时存在极短窗口 |
| 446 | `handleStopGeneration` 中 `delete(sid)` 先于 `flushStreamBatchers`，顺序正确但无注释保障 | - |

---

## 17. 跨标签页/窗口协调

| # | 问题 | 描述 |
|---|------|------|
| 447 | 无 `window.addEventListener('storage', ...)` | 多标签页完全不知道彼此的数据变更 |
| 448 | 无 `BroadcastChannel` API | - |
| 449 | 无 `SharedWorker` | - |
| 450 | 无版本号/乐观锁机制 | localStorage 写入互相覆盖 |
| 451 | 两个标签页各自建立独立 WebSocket 到引擎 | 可能发送冲突指令 |
| 452 | 无 `document.visibilitychange` 监听器 | 后台标签页 StreamTextBatcher 不刷新 |
| 453 | 无 `pagehide`/`beforeunload` 刷新 batcher | 关闭标签页可能丢失 in-flight 批处理数据 |
| 454 | `StreamTextBatcher` 未设置 `maxBufferedChars` + 无可见性感知 | 隐藏标签页可能无限累积 |

---

## 18. 无障碍 (A11Y)

| # | 问题 | 描述 |
|---|------|------|
| 455 | 会话标签嵌套 role 冲突(外层 `role="tab"` div + 内层 button) | 屏幕阅读器双焦点 |
| 456 | `WorkspaceEmptyState` 仅响应 `onPointerDown`，键盘不可用 | - |
| 457 | `VirtualList` 无 `role="list"`/`listitem` | - |
| 458 | `SettingsSelect` 无键盘导航(方向键/Enter/Esc) | - |
| 459 | 设置页无 focus trap，Tab 可跳出弹层 | - |
| 460 | `SettingsSchemaRenderer` 预设网格无 `role="grid"` | - |
| 461 | `SettingsSchemaRenderer` 颜色选择器无 `aria-label` | - |
| 462 | `SettingsSchemaRenderer` `idsMap` 用 `Math.random()` 生成 id | 不同渲染的 id 不同 |
| 463 | `SettingsUI` Tooltip 仅鼠标 hover，无键盘聚焦触发 | - |
| 464 | `SettingsUI` `SettingsRow` 中嵌套 button(button 内 button) | 语义不合法 |
| 465 | `prefers-reduced-motion` 未全局处理 | 部分动画已禁用，更多地方遗漏 |
| 466 | Tab close button 在非活跃 tab 上 `tabIndex={-1}` | - |
| 467 | `WorkspaceStrip` 的 `showTrail` 硬编码为 `true`(不支持通过 props 控制) | - |
| 468 | 排序菜单飞延不支持触屏 | - |
| 469 | 审批卡片 `aria-describedby` 动态计算，`descId` 所指元素可能 `hidden` | - |
| 470 | ComposePlusMenu 等浮层无 `aria-modal="true"` | - |
| 471 | AgentTeamBoard 状态圆点 `aria-hidden="true"`，状态信息只在 tooltip 中 | 键盘用户无法直接感知 |

---

## 19. 性能问题

| # | 问题 | 描述 |
|---|------|------|
| 472 | ChromeBars `sessionTabs` 依赖完整 `sessions` 数组，流式消息更新引起不必要重算 | - |
| 473 | `persistAllSessions` 同步全量序列化 1000+ 消息冻结主线程 | Web Worker 存在但未用 |
| 474 | 350ms debounce 到期时主线程冻结影响输入 | - |
| 475 | 侧栏搜索全表扫描无 Web Worker | - |
| 476 | 外观页 10 秒定时器在 tab 不可见时仍在运行 | - |
| 477 | OverviewCard/RuntimePanel 每 4 秒轮询在面板不可见时仍在运行 | - |
| 478 | SettingsSchemaRenderer `React.memo` props 是对象(每次重渲染创建新引用) | memo 基本失效 |
| 479 | AgentCard/InlineAgentPanel 多处 `useLayoutStore.setState` 直接修改嵌套对象 | immer 可工作但可能读到不一致中间状态 |
| 480 | `nowTick` 每次 tick 创建新闭包，`SessionRow` React.memo 失效 | - |
| 481 | 无关键 CSS 内联(所有样式通过 `@import` 加载，阻塞渲染) | - |

---

## 20. 代码质量/重复/遗留

| # | 问题 | 描述 |
|---|------|------|
| 482 | OverviewCard 与 RuntimePanel ~300 行重复代码 | daemon 连接、轮询、approval |
| 483 | AgentCard 与 InlineAgentPanel stream 回调处理重复 | - |
| 484 | FileIcon 在 OverviewCard 和 FilesCard 中重复定义 | - |
| 485 | SettingsAppearanceTab 同时使用 Schema 渲染和手写组件(风格不统一) | - |
| 486 | McpSettingsTab Demo 模式与正式模式代码高度重复 | - |
| 487 | 多处使用 `window.confirm` 而非内联确认 UI | - |
| 488 | `settingsUiStore` 仍是 `layoutStore` 的别名(未物理分离) | - |
| 489 | `terminalLines` 兼容遗留字段与 `terminalBySession` 双写 | 增加复杂度 |
| 490 | `shared-utils` 中 `compactJsonObject`/`isJsonObject` 在 daemon 中重复定义 | - |
| 491 | `cli/` 和 `demo-fixtures.ts` 仍存在于产品路径 | - |
| 492 | `apps/web-ui` 遗留 prototype 可能被误认为活跃产品路径 | - |
| 493 | `card-action-btn`/`ui-btn` 等全局 CSS class 依赖 | 重构全局样式时需要调整所有面板 |
| 494 | `ChatComposer.tsx` 中斜杠菜单关闭检测使用全局类名 `.input-container` | 容易因 CSS 重构断裂 |
| 495 | `useChatStream.ts` 1468 行(巨型 hook) | - |
| 496 | `DiffCard.tsx` 1942 行(巨型组件) | - |
| 497 | `FilesCard.tsx` 1473 行 | - |
| 498 | `OverviewCard.tsx` 1152 行 | - |
| 499 | `AgentCard.tsx` 1041 行 | - |
| 500 | `ChatCard.tsx` 1025 行 | - |
| 501 | 多处 `style={{}}` 内联样式(可维护性差) | - |
| 502 | `handleApprovalAllow`/`handleApprovalDeny` 在 OverviewCard/RuntimePanel/AgentCard 中重复 | - |
| 503 | `fetchEngineLiveStatus` + `listBackgroundTasks` 的 4 秒轮询在多个组件中重复 | - |

---

## 附录：按区域统计

| 区域 | 问题数 |
|------|--------|
| App 骨架/顶栏/布局 | 25 |
| 侧栏 (Sidebar) | 21 |
| 工作区/列/面板 | 23 |
| 对话面板 (ChatCard/Composer/MessageList) | 44 |
| 工具面板 | 99 |
| 设置面板 | 83 |
| Workspace Chrome Bars | 19 |
| 辅助/额外功能 | 18 |
| API/Store/Hooks 层 | 29 |
| Daemon 连接与同步 | 13 |
| 消息完整性与状态管理 | 16 |
| 持久化与存储 | 13 |
| 审批与工具执行 | 11 |
| 多会话/工作区/项目隔离 | 8 |
| 错误处理与恢复 | 10 |
| 并发操作竞态条件 | 6 |
| 跨标签页/窗口协调 | 8 |
| 无障碍 (A11Y) | 17 |
| 性能问题 | 10 |
| 代码质量/重复/遗留 | 22 |
| **总计** | **~503** |
