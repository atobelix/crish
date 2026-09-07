export const part2_details = `
### 2.2 \`binary-tree\` 核心组件群精细档案

#### 2.2.1 \`BinaryTreeWorkspace.tsx\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx\`
- **真实代码行数**：234 行
- **组件职责**：二叉树分屏工作区的总装调度器，负责订阅树形状态、展平为二维绝对定位矩形、稳定化缓存以保护 React.memo、并渲染所有的叶子面板与分屏手柄。
- **Props 契约与核心状态**：
  \`\`\`typescript
  export interface BinaryTreeWorkspaceProps {
    className?: string;
  }
  // 内部维护两个稳定化缓存 Ref：
  const leafEntryCacheRef = useRef<Map<string, StableLeafEntry>>(new Map());
  const branchCacheRef = useRef<Map<string, FlatBranch>>(new Map());
  \`\`\`
- **关键机制解构**：
  1. \`flattenTree\` 算子在每次 store 更新时都会返回全新的对象字面量（包含新的 \`rect\` 与 \`tabs\` 引用）。为防止下层子组件全部重绘，实现了 \`stabilizeLeafEntries\` 与 \`stabilizeBranches\`；
  2. 比对逻辑包含：\`tabsIdentityEqual\`（深比对每个 SessionTab 的 tabId 与 dock 配置）、\`dockIdentityEqual\`（比对 openPanelIds、activePanelId、widthRatio 等）、以及 \`rectEqual\`；
  3. 挂载了两个全局性副作用 Hook：\`useTreePanelEvents()\`（监听快捷键分屏/聚焦事件）与 \`useChatPanelSync()\`（同步主对话列的会话状态）。

#### 2.2.2 \`BinaryTreeWorkspace.module.css\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css\`
- **真实代码行数**：519 行
- **样式职责**：画板布局、叶子绝对定位、Sash 分屏手柄视觉、拖拽吸附高亮（Drop Overlay）与叶内抽屉（LeafDockDrawer）排版。
- **核心选择器解构**：
  - \`.section\`：工作区总外壳，\`background: var(--bg-workspace, var(--bg-primary)); padding: 0 var(--shell-gutter, 8px) var(--shell-gutter, 8px) 0;\`；
  - \`.canvas\`：容器查询宿主，\`container-type: size; container-name: tree-canvas;\`；
  - \`.leaf\`：绝对定位百分比盒，\`isolation: isolate; transition: top, left, width, height;\`；
  - \`.sash\`：6px 热区，1px 居中发丝线；Hover 与拖拽时亮出品牌绿（\`var(--accent-green, #10b981)\`）；
  - \`.leafDockDrawer\`：右侧工具坞抽屉，宽度由 CSS 变量 \`--leaf-dock-width\` 驱动，最小 200px，最大 70%；
  - \`.leafDockDrawer.maximized\`：全屏覆盖态，使用了 4 连击 \`!important\`。

#### 2.2.3 \`TreeLeafPanel.tsx\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx\`
- **真实代码行数**：565 行
- **组件职责**：分形树几何叶子的微内核宿主，承载独立的会话标题栏（\`PaneHeader\`）、主对话列（\`leafChatColumn\`）、右侧工具抽屉（\`leafDockDrawer\`）、以及叶内坞宽度调节器（\`LeafDockResizer\`）。
- **Props 契约**：
  \`\`\`typescript
  interface TreeLeafPanelProps {
    leaf: LayoutLeaf;
    rect: { x: number; y: number; width: number; height: number };
    isActive: boolean;
    isDragSource?: boolean;
    isMultiChat?: boolean;
  }
  \`\`\`
- **关键机制解构**：
  1. **布局直写与手势防冲刷**：在 \`useLayoutEffect\` 中直接写 \`el.style.top/left/width/height\`。当 \`document.body.classList.contains('tree-resizing')\` 为真时直接跳过，防止 React 渲染冲刷拖拽过程中的即时坐标；
  2. **声明式微内核插槽**：彻底剥离了 \`switch(panelId)\` 硬编码，统一调用 \`viewRegistry.resolveView(panelId)\` 并通过 \`<SlotOutlet slotKey="workspace.leaf.panel" />\` 动态装配视窗；
  3. **交互拦截白名单**：在 \`handleActivate\` 中维护了包括 20+ 种表单与可交互选择器的拦截白名单，避免用户在点击窗格内部元素时抢夺焦点。

#### 2.2.4 \`TreeResizeSash.tsx\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeResizeSash.tsx\`
- **真实代码行数**：218 行
- **组件职责**：二叉树分支节点的物理分割条，连接两个子空间，响应鼠标/触控拖拽并支持完整的键盘无障碍微调。
- **Props 契约**：
  \`\`\`typescript
  export interface TreeResizeSashProps {
    branch: FlatBranch;
    startResize: (branchId: string, branchRect: BranchRect, e: React.PointerEvent) => void;
    isResizing: boolean;
  }
  \`\`\`
- **关键机制解构**：
  1. 采用 \`flatBranchEqual\` 浅比较函数进行严格的 \`React.memo\` 保护，仅在 Branch 坐标、方向或比例改变时重绘；
  2. \`useLayoutEffect\` 将 \`branch.rect\` 与 \`splitRatio\` 投影为 \`el.style.left\` 或 \`el.style.top\`；
  3. 键盘事件监听：\`ArrowLeft/Up\` 步长 -2%，\`ArrowRight/Down\` 步长 +2%，\`Home\` 跃迁至最小极值，\`End\` 跃迁至最大极值；
  4. 双击快捷手势：\`onDoubleClick\` 重置为 0.5 均分。

#### 2.2.5 \`LeafDockResizer.tsx\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafDockResizer.tsx\`
- **真实代码行数**：140 行
- **组件职责**：叶子内部主对话区与右侧工具坞之间的零尺寸跨越手柄。
- **防粘手四重防线**：
  1. \`handleEl.setPointerCapture(e.pointerId)\`：锁定后续所有指针事件；
  2. \`disableIframePointerEvents()\`：屏蔽页面所有 iframe 的交互穿透；
  3. \`document.body.classList.add('is-resizing', 'leaf-dock-resizing')\`：全局状态标记；
  4. 监听 \`pointercancel\` 兜底，系统手势被打断时安全释放状态机。

#### 2.2.6 \`PaneHeader.tsx\` & \`PaneHeader.module.css\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx\`
- **真实代码行数**：347 行（TSX）+ 304 行（CSS）
- **组件职责**：窗格专属独立会话标签栏，高度严格锁定为 36px，与下方内容卡片 1:1 同宽左对齐。
- **核心特性**：
  1. **滚轮重定向**：将垂直滚轮偏移量（\`deltaY\`）自动转换为标签容器的水平滚动（\`scrollLeft\`）；
  2. **智能固定加号（Smart Pinning）**：借助 \`ResizeObserver\` 监听容器宽度，标签未溢出时加号在尾部随行流动（\`inFlow\`），溢出后自动平滑淡入右侧固定群组（\`pinned\`）；
  3. **桌面避让规则**：CSS 中通过属性选择器避让系统红绿灯与窗控按钮：
     - \`[data-sidebar-collapsed="true"][data-top-row="true"][data-left-edge="true"]\`：Windows 让出 52px，macOS 让出 106px；
     - \`[data-top-row="true"][data-right-edge="true"]\`：Windows 让出 112px，macOS 让出 38px。

#### 2.2.7 \`LeafToolTabStrip.tsx\` & \`LeafToolTabStrip.module.css\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx\`
- **真实代码行数**：604 行（TSX）+ 579 行（CSS）
- **组件职责**：右侧工具坞抽屉顶栏，高度锁定为 38px，承载各类工具面板标签并提供增删、全屏最大化与导航。
- **核心特性**：
  1. 动态 Favicon 嗅探：针对浏览器类标签（\`preview\`、\`browser:*\`），自动监听系统事件并渲染网站真实图标；
  2. 弹出式面板添加菜单：集成 \`SmartExpandablePanel\`，从 \`viewRegistry.getToolViews()\` 中动态过滤未打开的工具；
  3. 标签入场（\`tabSlideIn\`）与离场（\`isLeaving\`）的 220ms 弹性平滑缓动动画。

#### 2.2.8 \`SidePanelLauncherHub.tsx\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx\`
- **真实代码行数**：177 行
- **组件职责**：当工具坞标签页全部关闭时的空态启动中枢。
- **核心特性**：
  - 自动运行 \`detectActiveServicePort\`，并发探测本地常见开发端口（\`5173, 3000, 4000, 8080, 8000, 3001, 5000\`）；
  - 探测成功后以呼吸圆点提示“运行中的服务: http://localhost:PORT”，用户一键点击即可在右侧快速打开预览。

#### 2.2.9 \`SidePanelNavToolbar.tsx\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelNavToolbar.tsx\`
- **真实代码行数**：69 行
- **组件职责**：工具坞二级导航栏，提供前进、后退、刷新及系统外部浏览器打开能力。

#### 2.2.10 \`paneEdgeGeometry.ts\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/binary-tree/paneEdgeGeometry.ts\`
- **真实代码行数**：59 行
- **职责**：纯数学几何模块。引入 \`EPSILON = 0.001\` 与 \`RIGHT_BOTTOM_THRESHOLD = 0.99\`，消除 Sash 拖拽过程中的浮点累积误差，精确计算窗格是否触达视口的 Top、Left、Right、Bottom 物理边界。

---

### 2.3 \`workspace\` 视窗宿主群精细档案

#### 2.3.1 \`PreviewCard.tsx\` & \`PreviewCard.module.css\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.tsx\`
- **真实代码行数**：579 行（TSX）+ 743 行（CSS）
- **核心职责**：内置原生透明代理浏览器视窗。
- **关键架构子系统**：
  1. **代理与注入系统**：通过本地透明代理剥离外部网站的 XFO（X-Frame-Options）与 CSP 限制，动态向 iframe 注入桥接脚本；
  2. **DOM 拾取（Inspector）链路**：
     - 用户开启 Inspect 按钮，宿主调用 \`enableInspector(iframe, true)\`；
     - 注入脚本 \`previewClientBridge.ts\` 在 iframe 内捕获用户鼠标悬停与点击，上报元素的 tagName、选择器、计算样式及尺寸；
     - 宿主渲染悬停外框（\`.inspectorHover\`）与底部详情卡（\`.inspectorBadge\`），支持“复制选择器”、“复制 HTML 片段”、以及“发送到 AI 输入框”。
  3. **AI 正在协同指示器**：当检测到会话正在生成或 Agent 正在执行时，顶部浮现 \`.aiRunningBadge\`，并附带一键停止按钮。

#### 2.3.2 \`TerminalCard.tsx\` & \`TerminalCard.module.css\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/workspace/TerminalCard.tsx\`
- **真实代码行数**：229 行（TSX）+ 629 行（CSS）
- **核心职责**：交互式终端视窗宿主，深度集成 xterm.js 与操作系统底层 PTY 进程。
- **关键架构子系统**：
  1. 会话身份绑定：依据 \`sessionId\` 与 \`panelId\` 组合成唯一 \`sessionKey\`，实现多会话、多标签终端的进程完全隔离；
  2. **内嵌二级分屏实现**：维护 \`splitMode: 'none' | 'horizontal' | 'vertical'\` 与 \`activePaneIndex: 0 | 1\`；
  3. 分屏激活时自动派生 \`\${sessionKey}:split-2\` 子 PTY 进程；
  4. 尺寸自适应收敛：通过两次 \`requestAnimationFrame\` 调用 \`termHandleRef.current.fit()\`，确保分屏变换时字符网格尺寸精准收敛。

#### 2.3.3 \`RuntimePanel.tsx\` & \`RuntimePanel.module.css\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.tsx\`
- **真实代码行数**：216 行（TSX）+ 417 行（CSS）
- **核心职责**：系统运行时状态总控台，聚合展示引擎健康度、Token 用量、上下文 Cache 监控、后台任务、定时任务、审批流与安全审计。
- **各 Section 子模块一览**：
  - \`RuntimeSection\` (63 行)：引擎连接状态与崩溃自动重连；
  - \`SessionCacheStatsPanel\` (87 行)：Prompt 缓存命中率与冷缓存提醒；
  - \`LiveTasksSection\` (101 行) & \`BgTasksSection\` (135 行)：实时与常驻任务；
  - \`TimerCronSection\` (134 行)：定时器与 Cron 任务监视；
  - \`ApprovalSection\` (207 行)：危险操作人机交互审批；
  - \`TrashSection\` (202 行)：工作区安全回收站；
  - \`SecurityAuditSection\` (92 行)：安全策略拦截日志；
  - \`FlowDagView\` (176 行)：工作流 DAG 编排图展示。

#### 2.3.4 \`WorkspaceEmptyState.tsx\` & \`WorkspaceEmptyState.module.css\`
- **绝对路径**：\`c:/Software/conex/apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.tsx\`
- **真实代码行数**：333 行（TSX）+ 124 行（CSS）
- **核心职责**：当工作区未激活任何会话时的空态装配壳。
- **设计特色**：
  - 零广告、零视觉杂质，采用黑白灰极简微反差设计；
  - 焦点边框混入度严格控制在 4%~5%（\`--empty-hover-border: color-mix(in srgb, var(--border-color) 96%, var(--text-primary) 4%)\`），绝无厚重外阴影；
  - 挂载笔记纸面入口（\`WorkspaceEmptyStateStrictHost\`）与镜像状态条（\`MirrorSlot\`）。

---

### 2.4 测试套件资产盘点与覆盖度分布

在实勘范围内，共有 **34 个测试文件**，累计 **7,567 行测试代码**。涵盖了单元测试、组件集成测试、手势基准测试与端到端模拟：

1. **二叉树手势与样式绝缘测试群**（10 个文件，2,092 行）：
   - \`TreeLeafPanel.gesture-fix.test.tsx\` (770 行)：验证叶内 20+ 种表单原语在鼠标点击时不会误触发叶子焦点切换；
   - \`LeafToolTabStrip.scoped.test.tsx\` (572 行)：验证工具标签的新增、关闭动画、Favicon 刷新与边界溢出；
   - \`TreeLeafPanel.routing.test.tsx\` (483 行)：断言草稿态（\`draft-* \`）向正式会话（\`session-*\`）跃迁时的路由闭环；
   - \`BinaryTreeWorkspace.leaf-insulate.test.ts\` (189 行)：样式绝缘防线，拦截任何残留的全局选择器；
   - \`TreeResizeSash.memo.test.tsx\` (175 行)：锁定 \`flatBranchEqual\` 在对象字面量重新创建时 100% 命中 memo 缓存。
2. **工作区视窗功能与协议测试群**（24 个文件，5,475 行）：
   - \`PreviewCard.test.tsx\` (493 行) & 桥接测试群 (999 行)：锁定 Inspect 拾取协议、跨域 postMessage 消息路由；
   - \`TerminalCard.test.tsx\` (350 行)：验证 PTY 异常时的降级横幅渲染与重连行为；
   - \`flowDagLayout.test.ts\` (273 行)：检验 DAG 有向无环图分层拓扑算法的无交叠排版；
   - \`WorkspaceEmptyState.*.test.tsx\` (10 个文件，约 2,000 行)：详尽覆盖 Strict 演示轨、B3 写通道、C2 纸面列表、E2 镜像探测等各类组合状态。
`;
