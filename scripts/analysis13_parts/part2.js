export const part2 = `
---

## 2. 实勘对象全景清单与资产档案（Comprehensive File Registry & Metric Inventory）

### 2.1 全量实勘文件统计汇总表

本次实勘覆盖 \`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/\` 与 \`c:/Software/conex/apps/crish-desktop/src/components/workspace/\` 两个目录下的全部文件，共计 **105 个文件**，累计 **23,812 行代码**。

完整资产清单统计表如下：

| 序号 | 目录分类 | 文件名称 | 相对路径（\`apps/crish-desktop/\` 起算） | 真实行数 | 字节大小 | 模块职责与性质 |
| :---: | :--- | :--- | :--- | :---: | :---: | :--- |
| 1 | binary-tree | \`BinaryTreeWorkspace.tsx\` | \`src/components/binary-tree/BinaryTreeWorkspace.tsx\` | 234 | 7,321 B | 二叉树工作区主入口，展平树消费与双缓存稳定化 |
| 2 | binary-tree | \`BinaryTreeWorkspace.module.css\` | \`src/components/binary-tree/BinaryTreeWorkspace.module.css\` | 519 | 12,568 B | 画板、叶子绝对定位、Sash 分割条与叶内抽屉样式 |
| 3 | binary-tree | \`TreeLeafPanel.tsx\` | \`src/components/binary-tree/TreeLeafPanel.tsx\` | 565 | 19,641 B | 几何叶子空间微内核，会话/草稿绑定，插槽 Outlet 挂载 |
| 4 | binary-tree | \`TreeResizeSash.tsx\` | \`src/components/binary-tree/TreeResizeSash.tsx\` | 218 | 7,621 B | 二叉树物理分割手柄，水平/垂直定位与键盘可访问性 |
| 5 | binary-tree | \`LeafDockResizer.tsx\` | \`src/components/binary-tree/LeafDockResizer.tsx\` | 140 | 4,731 B | 叶内右侧工具坞宽度调节手柄，防粘手四重防线 |
| 6 | binary-tree | \`PaneHeader.tsx\` | \`src/components/binary-tree/PaneHeader.tsx\` | 347 | 11,909 B | 窗格独立会话标签栏（36px），Smart Pinning 加号 |
| 7 | binary-tree | \`PaneHeader.module.css\` | \`src/components/binary-tree/PaneHeader.module.css\` | 304 | 8,149 B | 窗格头样式，平台避让规则（macOS 交通灯/Win 窗控） |
| 8 | binary-tree | \`LeafToolTabStrip.tsx\` | \`src/components/binary-tree/LeafToolTabStrip.tsx\` | 604 | 19,187 B | 叶内抽屉工具标签栏（38px），支持 Favicon 与最大化 |
| 9 | binary-tree | \`LeafToolTabStrip.module.css\` | \`src/components/binary-tree/LeafToolTabStrip.module.css\` | 579 | 12,718 B | 工具标签条样式，入场/离场关键帧动画，溢出滚动轨道 |
| 10 | binary-tree | \`SidePanelLauncherHub.tsx\` | \`src/components/binary-tree/SidePanelLauncherHub.tsx\` | 177 | 5,306 B | 工具坞空态启动中枢，自动探测本地运行端口 |
| 11 | binary-tree | \`SidePanelNavToolbar.tsx\` | \`src/components/binary-tree/SidePanelNavToolbar.tsx\` | 69 | 2,152 B | 抽屉二级视图导航工具栏（前进/后退/刷新/外部打开） |
| 12 | binary-tree | \`paneEdgeGeometry.ts\` | \`src/components/binary-tree/paneEdgeGeometry.ts\` | 59 | 1,613 B | 窗格四周物理边缘判定纯算法（引入 Epsilon 消除误差） |
| 13 | binary-tree | \`BinaryTreeWorkspace.leaf-insulate.test.ts\` | \`src/components/binary-tree/BinaryTreeWorkspace.leaf-insulate.test.ts\` | 189 | 7,597 B | 叶子样式绝缘测试，防止全局选择器污染 |
| 14 | binary-tree | \`leafOwnedTabs.ui.source.test.ts\` | \`src/components/binary-tree/leafOwnedTabs.ui.source.test.ts\` | 59 | 1,822 B | 标签所有权单测，断言标签数据源归属 |
| 15 | binary-tree | \`LeafToolTabStrip.scoped.test.tsx\` | \`src/components/binary-tree/LeafToolTabStrip.scoped.test.tsx\` | 572 | 22,525 B | 工具标签栏作用域测试，覆盖 Favicon 刷新与关闭动画 |
| 16 | binary-tree | \`PaneHeader.test.tsx\` | \`src/components/binary-tree/PaneHeader.test.tsx\` | 195 | 6,260 B | 窗格头集成测试，覆盖拖拽避让与中键关闭手势 |
| 17 | binary-tree | \`SidePanelLauncherHub.test.tsx\` | \`src/components/binary-tree/SidePanelLauncherHub.test.tsx\` | 80 | 2,847 B | 启动中枢端口发现单测，覆盖 fetch 超时降级 |
| 18 | binary-tree | \`TreeLeafPanel.gesture-fix.test.tsx\` | \`src/components/binary-tree/TreeLeafPanel.gesture-fix.test.tsx\` | 770 | 26,912 B | 叶子手势修复测试，覆盖全交互元素穿透防线 |
| 19 | binary-tree | \`TreeLeafPanel.routing.test.tsx\` | \`src/components/binary-tree/TreeLeafPanel.routing.test.tsx\` | 483 | 15,051 B | 叶子会话路由测试，覆盖草稿态到已提交态跃迁 |
| 20 | binary-tree | \`TreeResizeSash.memo.test.tsx\` | \`src/components/binary-tree/TreeResizeSash.memo.test.tsx\` | 175 | 5,800 B | 分割条 memo 化性能测试，锁定 D0-7 稳定比对契约 |
| 21 | binary-tree | \`__tests__/paneEdgeGeometry.test.ts\` | \`src/components/binary-tree/__tests__/paneEdgeGeometry.test.ts\` | 70 | 2,034 B | 边缘判定几何单测，覆盖全边界极限浮点值 |
| 22 | binary-tree | \`__tests__/treeLeafDefaultActive.test.tsx\` | \`src/components/binary-tree/__tests__/treeLeafDefaultActive.test.tsx\` | 167 | 5,613 B | 默认激活叶恢复测试，覆盖草稿自愈降级链路 |
| 23 | workspace | \`PreviewCard.tsx\` | \`src/components/workspace/PreviewCard.tsx\` | 579 | 21,090 B | 内置原生预览浏览器，透明代理通信与 DOM 拾取中枢 |
| 24 | workspace | \`PreviewCard.module.css\` | \`src/components/workspace/PreviewCard.module.css\` | 743 | 17,552 B | 预览卡片样式，包含地址栏、Inspect 高亮框与结果徽章 |
| 25 | workspace | \`PreviewToolbar.tsx\` | \`src/components/workspace/PreviewToolbar.tsx\` | 249 | 7,178 B | 预览浏览器地址与操作工具栏（前进后退刷新地址输入） |
| 26 | workspace | \`PreviewHistoryPanel.tsx\` | \`src/components/workspace/PreviewHistoryPanel.tsx\` | 146 | 4,977 B | 浏览器历史记录与书签下拉弹出面板 |
| 27 | workspace | \`previewCardLib.ts\` | \`src/components/workspace/previewCardLib.ts\` | 242 | 7,627 B | 拾取载荷转换、AI Snippet 构造与计算样式过滤 |
| 28 | workspace | \`previewClientBridge.ts\` | \`src/components/workspace/previewClientBridge.ts\` | 218 | 7,528 B | 注入 iframe 内部的 DOM 事件监听客户端桥接脚本 |
| 29 | workspace | \`previewHostBridge.ts\` | \`src/components/workspace/previewHostBridge.ts\` | 250 | 7,880 B | 宿主端跨 iframe postMessage 通信桥与订阅者管理器 |
| 30 | workspace | \`previewDomInspector.ts\` | \`src/components/workspace/previewDomInspector.ts\` | 567 | 18,536 B | 复杂 DOM 选择器生成算法、路径回溯与类名提炼 |
| 31 | workspace | \`previewProtocol.ts\` | \`src/components/workspace/previewProtocol.ts\` | 96 | 2,937 B | 宿主与 iframe 客户端桥跨域通信协议载荷类型定义 |
| 32 | workspace | \`usePreviewNavigation.ts\` | \`src/components/workspace/usePreviewNavigation.ts\` | 354 | 10,689 B | 预览浏览器地址状态、历史栈、书签、iframe 导航 Hook |
| 33 | workspace | \`TerminalCard.tsx\` | \`src/components/workspace/TerminalCard.tsx\` | 229 | 7,673 B | 交互式终端宿主，绑定 Session PTY，内嵌二级分屏 |
| 34 | workspace | \`TerminalCard.module.css\` | \`src/components/workspace/TerminalCard.module.css\` | 629 | 14,999 B | 终端全屏容器、内嵌分屏分界线、紧凑标签与主题样式 |
| 35 | workspace | \`TerminalCard.xterm.tsx\` | \`src/components/workspace/TerminalCard.xterm.tsx\` | 130 | 3,475 B | xterm.js 实例生命周期封装、FitAddon 挂载与 DOM 桥 |
| 36 | workspace | \`TerminalToolbar.tsx\` | \`src/components/workspace/TerminalToolbar.tsx\` | 133 | 4,318 B | 终端操作条（分屏切换、清屏、新建终端、分支指示） |
| 37 | workspace | \`useXtermTerminal.ts\` | \`src/components/workspace/useXtermTerminal.ts\` | 512 | 17,299 B | xterm 终端高级交互、右键菜单、字体缩放、主题注入 |
| 38 | workspace | \`ptyLifecycle.ts\` | \`src/components/workspace/ptyLifecycle.ts\` | 342 | 9,606 B | 底层 PTY 进程启动、挂起、心跳保活与销毁生命周期 |
| 39 | workspace | \`RuntimePanel.tsx\` | \`src/components/workspace/RuntimePanel.tsx\` | 216 | 8,298 B | 运行时与运维总控面板，集成引擎状态、用量、审批等 |
| 40 | workspace | \`RuntimePanel.module.css\` | \`src/components/workspace/RuntimePanel.module.css\` | 417 | 7,634 B | 运行时各 Section 模块化样式、状态微指示灯与用量条 |
| 41 | workspace | \`RuntimeSection.tsx\` | \`src/components/workspace/RuntimeSection.tsx\` | 63 | 1,827 B | 运行时折叠面板行级外壳原子结构 |
| 42 | workspace | \`runtimePanelLib.ts\` | \`src/components/workspace/runtimePanelLib.ts\` | 135 | 4,534 B | 运行时状态格式化函数库与 ARIA 无障碍文本转换 |
| 43 | workspace | \`useRuntimePanelData.ts\` | \`src/components/workspace/useRuntimePanelData.ts\` | 140 | 4,577 B | 聚合引擎状态、任务数、审批流并派生显示数据的 Hook |
| 44 | workspace | \`SessionCacheStatsPanel.tsx\` | \`src/components/workspace/SessionCacheStatsPanel.tsx\` | 87 | 3,241 B | 会话上下文 Cache 命中率统计与冷启动预警面板 |
| 45 | workspace | \`LiveTasksSection.tsx\` | \`src/components/workspace/LiveTasksSection.tsx\` | 101 | 3,728 B | 实时运行中子 Agent 与任务列表区段 |
| 46 | workspace | \`BgTasksSection.tsx\` | \`src/components/workspace/BgTasksSection.tsx\` | 135 | 5,283 B | 后台常驻异步任务列表与终止控制区段 |
| 47 | workspace | \`TimerCronSection.tsx\` | \`src/components/workspace/TimerCronSection.tsx\` | 134 | 4,813 B | 定时器与 Cron 表达式调度任务监控区段 |
| 48 | workspace | \`TrashSection.tsx\` | \`src/components/workspace/TrashSection.tsx\` | 202 | 6,641 B | 工作区回收站文件管理、清空与恢复区段 |
| 49 | workspace | \`SecurityAuditSection.tsx\` | \`src/components/workspace/SecurityAuditSection.tsx\` | 92 | 3,094 B | 安全审计红线拦截记录与敏感操作审查区段 |
| 50 | workspace | \`PlansSection.tsx\` | \`src/components/workspace/PlansSection.tsx\` | 110 | 4,039 B | 工作流方案与任务计划展示区段 |
| 51 | workspace | \`ApprovalSection.tsx\` | \`src/components/workspace/ApprovalSection.tsx\` | 207 | 7,073 B | 敏感命令/工具调用用户审批悬浮停靠区段 |
| 52 | workspace | \`activePortDetector.ts\` | \`src/components/workspace/activePortDetector.ts\` | 172 | 4,599 B | 本地开发端口（Vite/Next/Webpack等）并发探测算法 |
| 53 | workspace | \`FlowDagView.tsx\` | \`src/components/workspace/FlowDagView.tsx\` | 176 | 6,363 B | 工作流 DAG 编排拓扑图可视化容器 |
| 54 | workspace | \`FlowDagView.module.css\` | \`src/components/workspace/FlowDagView.module.css\` | 134 | 2,577 B | DAG 节点、边连线与高亮流动动效样式 |
| 55 | workspace | \`flowDagLayout.ts\` | \`src/components/workspace/flowDagLayout.ts\` | 219 | 8,067 B | 基于分层的有向无环图节点坐标与布线拓扑算法 |
| 56 | workspace | \`flowDagStore.ts\` | \`src/components/workspace/flowDagStore.ts\` | 45 | 1,991 B | DAG 节点选择与聚焦状态轻量存储 |
| 57 | workspace | \`WorkspaceEmptyState.tsx\` | \`src/components/workspace/WorkspaceEmptyState.tsx\` | 333 | 14,050 B | 工作区空态装配壳，纸面/Strict/镜像挂载中枢 |
| 58 | workspace | \`WorkspaceEmptyState.module.css\`| \`src/components/workspace/WorkspaceEmptyState.module.css\`| 124 | 3,170 B | 空态极简黑白灰样式，无边框与克制焦点动效 |
| 59 | workspace | \`workspaceEmptyStateActions.tsx\` | \`src/components/workspace/workspaceEmptyStateActions.tsx\` | 133 | 4,799 B | 空态 CTA 按钮组与历史工程快捷入口 |
| 60 | workspace | \`workspaceEmptyStatePaperEntry.tsx\`| \`src/components/workspace/workspaceEmptyStatePaperEntry.tsx\`| 155 | 5,255 B | 纸面双轨（Strict/Skeleton）入口装配微内核 |
| 61 | workspace | \`browserSessionLib.ts\` | \`src/components/workspace/browserSessionLib.ts\` | 110 | 3,890 B | 浏览器会话数据过滤与提取轻量工具库 |
| 62 | workspace | \`useBrowserSession.ts\` | \`src/components/workspace/useBrowserSession.ts\` | 220 | 7,737 B | 浏览器会话历史与状态持久化 Hook |
| 63 | workspace | \`browser-panel/BrowserImportSection.tsx\` | \`src/components/workspace/browser-panel/BrowserImportSection.tsx\` | 206 | 7,081 B | 外部浏览器数据导入区段 |
| 64 | workspace | \`browser-panel/BrowserImportSection.module.css\` | \`src/components/workspace/browser-panel/BrowserImportSection.module.css\` | 14 | 331 B | 外部浏览器数据导入样式 |
| 65 | workspace | \`browser-panel/ExportAuthDialogs.tsx\` | \`src/components/workspace/browser-panel/ExportAuthDialogs.tsx\` | 92 | 3,246 B | 浏览器导出授权对话框组件 |
| 66 | workspace | \`browser-panel/import-hooks/browserImportShared.ts\` | \`src/components/workspace/browser-panel/import-hooks/browserImportShared.ts\` | 45 | 1,733 B | 浏览器导入共享常量与类型 |
| 67 | workspace | \`browser-panel/import-hooks/useBookmarksImport.ts\` | \`src/components/workspace/browser-panel/import-hooks/useBookmarksImport.ts\` | 176 | 5,730 B | Chrome/Edge/Firefox 书签导入 Hook |
| 68 | workspace | \`browser-panel/import-hooks/useHistoryImport.ts\` | \`src/components/workspace/browser-panel/import-hooks/useHistoryImport.ts\` | 144 | 4,532 B | 外部浏览器历史记录提取 Hook |
| 69 | workspace | \`browser-panel/import-hooks/useStorageImport.ts\` | \`src/components/workspace/browser-panel/import-hooks/useStorageImport.ts\` | 145 | 4,600 B | 本地存储与 Cookie 镜像 Hook |
| 70 | workspace | \`browser-panel/import-hooks/useExportAuth.ts\` | \`src/components/workspace/browser-panel/import-hooks/useExportAuth.ts\` | 102 | 3,645 B | 导出权限校验与 Token 管理 Hook |
| 71 | workspace | \`PreviewCard.test.tsx\` | \`src/components/workspace/PreviewCard.test.tsx\` | 493 | 17,652 B | 预览卡片集成测试，覆盖导航与 Inspect 状态机 |
| 72 | workspace | \`previewCardLib.test.ts\` | \`src/components/workspace/previewCardLib.test.ts\` | 117 | 3,683 B | 拾取数据清洗与 AI 文本生成单测 |
| 73 | workspace | \`previewClientBridge.test.ts\` | \`src/components/workspace/previewClientBridge.test.ts\` | 277 | 10,027 B | 注入脚本桥接通信单测 |
| 74 | workspace | \`previewDomInspector.test.ts\` | \`src/components/workspace/previewDomInspector.test.ts\` | 331 | 11,567 B | DOM 路径解析与选择器反查单测 |
| 75 | workspace | \`previewHostBridge.test.ts\` | \`src/components/workspace/previewHostBridge.test.ts\` | 274 | 8,614 B | 宿主端 postMessage 消息分发单测 |
| 76 | workspace | \`PreviewToolbar.test.tsx\` | \`src/components/workspace/PreviewToolbar.test.tsx\` | 200 | 6,053 B | 预览工具栏交互与 URL 验证单测 |
| 77 | workspace | \`TerminalCard.test.tsx\` | \`src/components/workspace/TerminalCard.test.tsx\` | 350 | 13,346 B | 终端卡片集成测试，覆盖 PTY 异常降级 |
| 78 | workspace | \`TerminalToolbar.test.tsx\` | \`src/components/workspace/TerminalToolbar.test.tsx\` | 105 | 3,388 B | 终端工具栏动作与分屏切换单测 |
| 79 | workspace | \`runtimePanelLib.test.ts\` | \`src/components/workspace/runtimePanelLib.test.ts\` | 130 | 4,805 B | 运行时状态文本转换与 ARIA 标记单测 |
| 80 | workspace | \`SessionCacheStatsPanel.test.tsx\` | \`src/components/workspace/SessionCacheStatsPanel.test.tsx\` | 64 | 2,538 B | 缓存监控面板渲染单测 |
| 81 | workspace | \`BgTasksSection.test.tsx\` | \`src/components/workspace/BgTasksSection.test.tsx\` | 263 | 10,410 B | 后台任务区段与终止交互单测 |
| 82 | workspace | \`TimerCronSection.test.tsx\` | \`src/components/workspace/TimerCronSection.test.tsx\` | 179 | 6,050 B | 定时器与 Cron 任务列表单测 |
| 83 | workspace | \`TrashSection.test.tsx\` | \`src/components/workspace/TrashSection.test.tsx\` | 201 | 6,133 B | 回收站操作与确认对话框单测 |
| 84 | workspace | \`SecurityAuditSection.test.tsx\` | \`src/components/workspace/SecurityAuditSection.test.tsx\` | 195 | 6,263 B | 安全审计流水拦截单测 |
| 85 | workspace | \`FlowDagView.test.tsx\` | \`src/components/workspace/FlowDagView.test.tsx\` | 111 | 4,500 B | DAG 视图挂载与交互单测 |
| 86 | workspace | \`flowDagLayout.test.ts\` | \`src/components/workspace/flowDagLayout.test.ts\` | 273 | 8,123 B | DAG 拓扑分层布局坐标计算单测 |
| 87 | workspace | \`flowDagStore.test.ts\` | \`src/components/workspace/flowDagStore.test.ts\` | 124 | 4,054 B | DAG 节点选择 Store 单测 |
| 88 | workspace | \`WorkspaceEmptyState.conn-b3.test.tsx\` | \`src/components/workspace/WorkspaceEmptyState.conn-b3.test.tsx\` | 257 | 9,726 B | 空态与 B3 斜杠写通道连接测试 |
| 89 | workspace | \`WorkspaceEmptyState.conn-c2-prod.test.tsx\` | \`src/components/workspace/WorkspaceEmptyState.conn-c2-prod.test.tsx\` | 157 | 5,855 B | 空态 C2 生产策略注入测试 |
| 90 | workspace | \`WorkspaceEmptyState.conn-c2.test.tsx\` | \`src/components/workspace/WorkspaceEmptyState.conn-c2.test.tsx\` | 104 | 4,858 B | 空态 C2 纸面列表状态测试 |
| 91 | workspace | \`WorkspaceEmptyState.conn-d2.test.tsx\` | \`src/components/workspace/WorkspaceEmptyState.conn-d2.test.tsx\` | 170 | 6,403 B | 空态 D2 Markdown 前缀通道测试 |
| 92 | workspace | \`WorkspaceEmptyState.conn-e2.test.tsx\` | \`src/components/workspace/WorkspaceEmptyState.conn-e2.test.tsx\` | 239 | 8,814 B | 空态 E2 镜像条显式装配测试 |
| 93 | workspace | \`WorkspaceEmptyState.conn-e3.test.tsx\` | \`src/components/workspace/WorkspaceEmptyState.conn-e3.test.tsx\` | 169 | 6,859 B | 空态 E3 调度探测测试 |
| 94 | workspace | \`WorkspaceEmptyState.lr-h1.test.tsx\` | \`src/components/workspace/WorkspaceEmptyState.lr-h1.test.tsx\` | 317 | 11,942 B | 空态 H1 已持久化文档绑定测试 |
| 95 | workspace | \`WorkspaceEmptyState.strict.test.tsx\` | \`src/components/workspace/WorkspaceEmptyState.strict.test.tsx\` | 238 | 10,700 B | 空态 Strict 演示轨单测 |
| 96 | workspace | \`workspaceEmptyStateStrictDoc.test.ts\` | \`src/components/workspace/workspaceEmptyStateStrictDoc.test.ts\` | 113 | 4,112 B | 空态文档 ID 归一化解析单测 |
| 97 | workspace | \`workspaceProductMirrorDetect.host-gone.test.ts\` | \`src/components/workspace/workspaceProductMirrorDetect.host-gone.test.ts\` | 53 | 1,846 B | 空态探测宿主卸载断言单测 |
| 98 | workspace | \`BrowserImportSection.test.tsx\` | \`src/components/workspace/browser-panel/BrowserImportSection.test.tsx\` | 344 | 11,764 B | 浏览器导入区段集成单测 |
| 99 | workspace | \`browserSessionLib.test.ts\` | \`src/components/workspace/browserSessionLib.test.ts\` | 133 | 4,921 B | 浏览器会话过滤单测 |
| 100 | workspace | \`useBrowserSession.test.tsx\` | \`src/components/workspace/useBrowserSession.test.tsx\` | 263 | 9,516 B | 浏览器会话 Hook 单测 |
| 101 | workspace | \`useBrowserSessionRace.test.tsx\` | \`src/components/workspace/useBrowserSessionRace.test.tsx\` | 111 | 3,973 B | 浏览器竞态条件容错单测 |
| 102 | workspace | \`Workspace.conn-e2-prime-tauri.test.tsx\` | \`src/components/workspace/Workspace.conn-e2-prime-tauri.test.tsx\` | 347 | 12,250 B | 工作区 Tauri 环境集成端到端测试 |
| 103 | workspace | \`Workspace.conn-e2-prime.test.tsx\` | \`src/components/workspace/Workspace.conn-e2-prime.test.tsx\` | 118 | 4,887 B | 工作区标准环境集成测试 |
| 104 | workspace | \`activePortDetector.test.ts\` | \`src/components/workspace/activePortDetector.test.ts\` | 170 | 5,309 B | 端口并发探测纯算法单测 |
| 105 | workspace | \`runtimeBackgroundAndSwitchFlash.test.ts\` | \`src/components/workspace/__tests__/runtimeBackgroundAndSwitchFlash.test.ts\` | 63 | 3,193 B | 运行时背景跳灰与闪烁防回归测试 |
`;
