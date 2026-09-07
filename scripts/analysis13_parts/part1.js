export const part1 = `# 工作区分形树与多分屏视窗实勘导航与原子化重塑详案

> **战役归属**：前端原子化组件库战役（Frontend Atomic Architecture Campaign）  
> **任务书编号**：任务书 13（Task 13）  
> **实勘范围**：  
> - \`apps/crish-desktop/src/components/binary-tree/\` 全量源码、样式与专项测试（22 个文件，5,907 行）  
> - \`apps/crish-desktop/src/components/workspace/\` 全量源码、样式与视窗子系统（83 个文件，17,905 行）  
> - 关联底层支撑链路：\`src/store/layout-tree/\` 二叉树算法与数据模型、\`src/hooks/useTreeResize.ts\` 零重绘手势引擎、\`src/services/view-registry/\` 声明式微内核插槽  
> **交付目标**：客观、详实、穿透底层算法与物理样式的实勘记录，总行数 ≥ 1200 行，采用中文，UTF-8 无 BOM 写入。

---

## 目录索引

1. [执行摘要与系统全景（Executive Summary & Architecture Panorama）](#1-执行摘要与系统全景executive-summary--architecture-panorama)
   - 1.1 系统定位与核心使命：分形树容器 vs 多视窗业务承载
   - 1.2 架构三层拓扑解构（算法数据层 → 空间容器层 → 视窗宿主层）
   - 1.3 核心技术指标与硬伤直击（23,812 行规模、105 个文件、21 层 DOM 嵌套、双重分屏割裂）
   - 1.4 反退避与反过度设计守则执行纲领
2. [实勘对象全景清单与资产档案（Comprehensive File Registry & Metric Inventory）](#2-实勘对象全景清单与资产档案comprehensive-file-registry--metric-inventory)
   - 2.1 全量实勘文件统计汇总表（105 个文件、23,812 行全景表格）
   - 2.2 \`binary-tree\` 核心组件群精细档案（12 个核心文件逐一解构）
   - 2.3 \`workspace\` 视窗宿主群精细档案（各业务视窗子系统与工具库逐一解构）
   - 2.4 测试套件资产盘点与覆盖度分布
3. [二叉分形树拓扑与分裂/合并算法深度剖析（Fractal Binary Tree & Split/Merge Algorithms）](#3-二叉分形树拓扑与分裂合并算法深度剖析fractal-binary-tree--splitmerge-algorithms)
   - 3.1 树数据结构模型：\`LayoutNode = LayoutLeaf | LayoutBranch\` 纯数据定义与不变式
   - 3.2 树展平与几何投影算法：\`flattenTree\` 递归遍历与归一化百分比 Rect 坐标系
   - 3.3 窗格分裂算法：\`splitLeaf\` / \`splitTab\` / \`splitSessionFromSidebar\`
   - 3.4 窗格合并与折叠消除算法：\`removeNodeFromTree\` 兄弟节点提升与 \`pruneEmptyLeaves\` 级联修剪
   - 3.5 跨窗格会话标签迁移算法：\`moveTab\` / \`moveNode\` 深度剪枝与挂载
   - 3.6 自适应 Drop Zone 判定算法：\`detectDropZone\` 距离梯度加权与边缘/中心识别
4. [分屏拖拽调节器（Resize Splitter）与高性能手势控制（Splitter & Gesture Control Engine）](#4-分屏拖拽调节器resize-splitter与高性能手势控制splitter--gesture-control-engine)
   - 4.1 全局树手柄：\`TreeResizeSash\` 架构与水平/垂直绝对定位投影
   - 4.2 零 React 重新渲染的高性能手势管线（\`useTreeResize\`、DOM Map 缓存、rAF 实时直写）
   - 4.3 瞬态防抖与尺寸钳制安全防线（\`treeResizeClamp\`、\`MIN_CHILD_PX\` 与父容器轴向投影）
   - 4.4 叶内坞调节手柄：\`LeafDockResizer\` 0px 跨越与负外边距对称热区
   - 4.5 拖拽全链路“防粘手与防事件丢失”四重防线（PointerCapture、iframe 屏蔽、pointercancel 兜底）
   - 4.6 键盘无障碍微调系统（Arrow 键步长微调、Home/End 极值跳跃、双击重置均分）
5. [多视窗聚焦状态同步与生命周期调度（Multi-Pane Focus Sync & Lifecycle Management）](#5-多视窗聚焦状态同步与生命周期调度multi-pane-focus-sync--lifecycle-management)
   - 5.1 双层焦点解耦模型：树级 \`activeLeafId\` 与叶内 \`activeTabId\` / \`activePanelId\`
   - 5.2 跨窗格事件委托与交互穿透拦截（\`TreeLeafPanel:handleActivate\` 20+ 交互元素规避白名单）
   - 5.3 会话身份漫游与草稿哨兵机制（\`mintDraftSessionId\` 与未提交新对话隔离）
   - 5.4 视窗内容卸载与保活权衡（Tab 模式 \`display: flex/none\` 保持 DOM vs 卸载重挂载开销）
   - 5.5 外部系统与底层资源联动（终端 PTY 进程生命周期、预览透明代理通信、端口探测）
6. [DOM 树嵌套开销与渲染性能瓶颈分析（DOM Tree Nesting Overhead & Performance Bottlenecks）](#6-dom-树嵌套开销与渲染性能瓶颈分析dom-tree-nesting-overhead--performance-bottlenecks)
   - 6.1 DOM 层级膨胀解剖：从桌面根到叶内视窗的 21 层嵌套拓扑与逐层盒模型分析表
   - 6.2 分形树扁平化渲染（Flatten）与绝对定位架构的得与失
   - 6.3 内存泄漏与 ResizeObserver 管理（单例模式与原生实例混用隐患）
   - 6.4 React 引用抖动与缓存击穿排查（\`stabilizeLeafEntries\` 与 \`stabilizeBranches\` 自定义比对器开销）
7. [现有样式体系坏味道与缺陷全面审计（CSS Code Smells & Architectural Defects）](#7-现有样式体系坏味道与缺陷全面审计css-code-smells--architectural-defects)
   - 7.1 滥用 \`!important\` 强制覆写排查（PreviewCard 7 处、LeafDockDrawer 4 连击等详细行号清单）
   - 7.2 脆弱的选择器深度穿透与通配符依赖（\`.leafChatColumn > *:not(...) > *\` 对抗 flex 均分的下策）
   - 7.3 硬编码尺寸与魔术数字排查（36px, 38px, 28px, 41px, 52px, 106px, 112px 避让硬编码）
   - 7.4 颜色 Token 割裂与未遵守 \`AGENTS.md §13~14\`（部分保留裸 hex/rgba、高对比度彩色边框）
   - 7.5 双重分屏体系割裂（外层二叉树分屏 vs 终端卡片内部 \`splitMode\` 重复实现）
8. [未来原子化多窗格系统重塑详案（Future Atomic Multi-Pane System Architecture）](#8-未来原子化多窗格系统重塑详案future-atomic-multi-pane-system-architecture)
   - 8.1 架构设计哲学：从“臃肿复合组件”走向“Headless 视窗微内核 + 原子化原语”
   - 8.2 原子化多窗格组件原语规划（\`PaneGroup\`, \`Pane\`, \`PaneSplitter\`, \`PaneHeader\`, \`PaneTabs\`, \`PaneContent\`）
   - 8.3 统一分形视窗协议（Unified Pane Tree Protocol）消除终端双重分屏特化
   - 8.4 CSS 现代化重构规范（CSS Subgrid / Container Queries 彻底替代深层穿透与 \`!important\`）
   - 8.5 统一焦点管理状态机（Focus Scope Provider 与物理/逻辑焦点解耦）
9. [实施路径与渐进式演进图谱（Migration Roadmap & Implementation Phasing）](#9-实施路径与渐进式演进图谱migration-roadmap--implementation-phasing)
   - 9.1 第一阶段：样式消臭与 \`!important\` 清剿（低风险、立即可见收敛）
   - 9.2 第二阶段：视窗内部组件原子化解耦（PreviewCard / TerminalCard / RuntimePanel 标准化）
   - 9.3 第三阶段：Headless 二叉树内核提取与统一分屏协议（跨窗格交互统一）
   - 9.4 第四阶段：立体验证与门禁守则（单元测试、手势基准测试、无障碍可访问性验收）
10. [结论与主控汇报纲要（Conclusion & Handoff Summary）](#10-结论与主控汇报纲要conclusion--handoff-summary)

---

## 1. 执行摘要与系统全景（Executive Summary & Architecture Panorama）

### 1.1 系统定位与核心使命：分形树容器 vs 多视窗业务承载

在 Conex / Crish 桌面客户端的架构体系中，**工作区分形树（Binary Tree Workspace）** 与 **多分屏视窗系统（Multi-Pane Workspace System）** 构成了用户进行高强度智能辅助开发、多会话并发对话、以及多维工具观测（终端、浏览器、运行时监控）的核心舞台。

整个多视窗系统的职责边界在历史演进中形成了两级分层架构：
1. **分形树容器层（\`components/binary-tree/\`）**：负责纯二维空间几何的划分、分形嵌套树的扁平化投影、多窗格之间的 Sash 拖拽手柄控制、跨窗格的会话/标签拖拽（Tab Drag & Drop）、以及各窗格专属的外置标题栏（\`PaneHeader\`）与叶内抽屉工具栏（\`LeafToolTabStrip\`）。
2. **多视窗业务承载层（\`components/workspace/\`）**：负责在每个由分形树派生出来的几何叶子（\`LayoutLeaf\`）或叶内抽屉（\`LeafDockDrawer\`）内部，按需挂载具体的业务实体視窗。这包括工作区空态落地页（\`WorkspaceEmptyState\`）、原生内置透明代理浏览器（\`PreviewCard\`）、多终端会话与 PTY 交互系统（\`TerminalCard\`）、运行时状态与运维监控总控台（\`RuntimePanel\`）、以及工作流 DAG 编排可视化（\`FlowDagView\`）。

### 1.2 架构三层拓扑解构（算法数据层 → 空间容器层 → 视窗宿主层）

从数据流向、状态派生到物理 DOM 的渲染，整个多视窗系统展现出高度清晰但深层耦合的“三层拓扑结构”：

\`\`\`
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 算法与不可变数据层 (src/store/layout-tree/ + src/store/storeAccess)  │
│    - 数据模型: LayoutTree { root: LayoutLeaf | LayoutBranch, version: 3 }│
│    - 纯函数算子: splitLeaf, splitTab, removeNodeFromTree, pruneEmptyLeaves │
│    - 空间展平引擎: flattenTree(root) => { leaves: FlatPanel[], branches } │
│    - 拖拽检测引擎: detectDropZone(pointer, leafRect) => DropZone        │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ 扁平矩形投影 (0..1 相对坐标)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. 空间分形容器层 (src/components/binary-tree/)                        │
│    - 调度中枢: BinaryTreeWorkspace (双稳定化缓存: stabilizeLeaf/Branch) │
│    - 叶子微内核: TreeLeafPanel (绝对定位百分比盒，包含主对话列与右侧工具坞)  │
│    - 物理分割线: TreeResizeSash (分离水平/垂直 Sash，键盘微调，双击重置) │
│    - 坞宽调节器: LeafDockResizer (负边距跨越，防粘手四重防线)              │
│    - 独立标签栏: PaneHeader (36px 会话标签栏，Smart Pinning 智能固定)    │
│    - 抽屉工具条: LeafToolTabStrip (38px 工具标签栏，带 Favicon 动态解析) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ 声明式插槽挂载 (SlotOutlet: workspace.leaf.panel)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. 视窗业务宿主层 (src/components/workspace/)                           │
│    - 空态与纸面: WorkspaceEmptyState, NotePaperStrictHost, MirrorSlot   │
│    - 浏览器视窗: PreviewCard (透明代理, iframe, PreviewDomInspector)    │
│    - 终端视窗:   TerminalCard (xterm.js, PTY 生命周期, 内嵌二级分屏)    │
│    - 运维控制台: RuntimePanel (引擎状态, 用量统计, 任务审批, DAG 编排)    │
└────────────────────────────────────────────────────────────────────────┘
\`\`\`

### 1.3 核心技术指标与硬伤直击

通过本次深入全量源码的实勘，工作区系统虽然在多窗格拖拽、分形几何计算和 PTY 会话绑定上展现了极高的工程复杂度，但在样式管理、DOM 嵌套开销、组件封装度上暴露出亟待解决的深层次技术债务：
1. **资产体量庞大**：所辖的 \`binary-tree\`（22 个文件，5,907 行）与 \`workspace\`（83 个文件，17,905 行）共计 105 个文件、23,812 行代码，属于整个桌面前端最具业务密度的核心地带；
2. **DOM 树层级极度膨胀**：从 Desktop 顶层外壳到终端字符渲染节点或浏览器内联 Inspect 节点，DOM 树垂直嵌套深度高达 **18 ~ 24 层**（平均 21 层）。每一层容器均包裹独立的弹性盒子、溢出控制和相对定位，造成了不必要的复合图层开销与样式重排压力；
3. **样式穿透与 \`!important\` 滥用灾难**：在 \`PreviewCard.module.css\`、\`BinaryTreeWorkspace.module.css\` 中大量使用 \`!important\` 强制压制底层基础组件的样式（例如 URL 输入框的 7 处 \`!important\`、叶内抽屉最大化全屏的 4 连击 \`!important\`）。在 \`BinaryTreeWorkspace.module.css:442\` 更是使用了 \`.leafChatColumn > *:not(:global(header)):not(:global(footer)) > *\` 这类危险脆弱的子代穿透选择器来对抗 Flexbox 均分拉伸；
4. **分屏逻辑的双重割裂与特化**：整个桌面已经具备完整通用、可任意嵌套的二叉树分屏系统，但 \`TerminalCard\` 为了实现终端的上下/左右分屏，竟然在卡片内部又手写了一套硬编码的 \`splitContainer\`、\`splitMode\`、\`activePaneIndex\` 和 \`termHandleRef1/termHandleRef2\`。外层分屏与内层分屏概念重叠，严重违背了“单一真理路径（SSOT）”原则；
5. **焦点同步与事件拦截的过度防御**：在 \`TreeLeafPanel:handleActivate\` 中，为了防止用户点击窗格内的控件时误触发窗格焦点切换，维护了一个包含 20 余种选择器的庞大字符串黑名单（\`closest('button, input, textarea, select, a, summary, [role="button"], [role="menuitem"], ...')\`），脆弱易漏，缺乏标准的 Focus Scope 状态机。

### 1.4 反退避与反过度设计守则执行纲领

本次实勘严格遵循仓库全局协作铁律 \`AGENTS.md\`、反退避全文 \`.agents/LOGIC_PLAN_NO_RETREAT.md\` 以及反过度设计红线 \`ANTI_OVERENGINEERING_GUARDRAILS.md\`：
- **反退避底线**：不因“既有二叉树逻辑极度复杂、牵一发动全身”而妥协保留丑陋补丁。不搞降级版，必须穿透到底层算法与 DOM 结构，提出完全闭环的原子化多窗格微内核重塑方案；
- **反过度设计红线**：严禁引入笨重且不透明的第三方重型 Docking 框架（如 Dockview / GoldenLayout / FlexLayout 等巨石库）；保持当前二叉树轻量纯逻辑算子的优势，仅将 UI 外壳解耦为纯粹、高内聚、低耦合的原子化原语组件（Atomic Primitives），并全面转向现代 CSS Grid / Container Queries 原生排版能力。
`;
