# A5 主工作区原型评审：conex-workbench-prototype 与现有实现对?

> 生成日期：2026-08-02
> 评审对象：`reference/conex-workbench-prototype/`（独立 HTML/CSS/JS 原型，非 React，约 90KB）
> 对比基准：`apps/crish-desktop/src/`（store/workspace-shell、store/layout-tree、components/workspace、components/binary-tree、hooks/usePointerDragBase 等）
> 性质：只读评审，未改动任何代码

**结论速览**：原型是「二叉树式工作区 + Chrome 风格标签页 + 零位移折叠」的**设计意图快照**，其价值集中在**视觉层**（Chrome 风格激活标签外凹角融合、标签增删/拖拽位移动画、折叠零位移细节、位置感知 pane 角处理），这三块显著领先现有实现且可低成本移植；而**状态层（tree-store）、拖拽引擎（drag-controller）、折叠本体**现有实现（layoutTreeStore + usePointerDragBase + adapterShape）已全面超越原型——原型无 session 概念、无 undo/redo、无可变不可变纪律、无持久化、无键盘可达性与测试。`modals.css`/Obsidian 预览/背景艺术 showcase 与工作区主诉求无关，属残留物，不建议整合。

---

## 1. 评审范围与方法

| 对象 | 内容 |
|------|------|
| 原型 | index.html（9 KB）、css/ 5 文件（tokens 4.3K / layout 6.9K / chrome-tabs 5.3K / binary-tree 4.9K / modals 6.1K）、js/ 4 模块（app 2.4K / tree-store 5.4K / drag-controller 11.6K / workspace-component 15.6K）、background-art-showcase.html（17.7K） |
| 现有 | store/workspace-shell（workspaceShellStore / adapterShape / treeDockProjection / types）、store/layout-tree（layoutTreeStore / operations / dropDetection / flattenTree 折叠域）、components/workspace（Workspace / WorkspaceChromeBars / WorkspaceStrip / SessionStrip）、components/binary-tree（BinaryTreeWorkspace / GlobalSessionTabBar / UnitSessionTabStrip / useTopBarDrag / useTreeDrag / useTreeResize）、hooks/usePointerDragBase、styles/tokens.css |
| 方法 | 全文精读原型 5 个 CSS + 4 个 JS 模块；精读现有 store 4 个核心模块、拖拽 2 个控制器、标签 3 个组件；按 布局/标签/折叠/拖拽/令牌 5 个维度逐项对比 |

---

## 2. 原型分析

### 2.1 页面布局与 DOM 结构

```
.app-shell                                    # flex 行，100vw × 100vh
├── .app-sidebar (260px, 100vh)               # 左栏
│   ├── .sidebar-header (38px)                #   toggle 按钮（28px），无底边框
│   ├── .sidebar-top-nav                      #   新对话 / 定时任务 / 搜索框
│   ├── .sidebar-scroll-list                  #   会话列表（"近期"分组）
│   └── .sidebar-footer                       #   模式 chip + 设置
└── .app-workspace-container                  # 右工作区，flex:1，position:relative
    ├── .workspace-top-bar (38px)             # **浮动 overlay**（absolute，pointer-events:none）
    │   ├── .workspace-top-bar__rail          #   折叠时出现的展开按钮（display 切换）
    │   └── .workspace-top-bar__trail         #   最小化/最大化/关闭 3 按钮（固定最右）
    └── .workspace-content-body               # 全高（不减 38px），挂二叉树
        └── #binaryTreeWorkspaceContainer
```

关键设计：**顶栏是绝对定位浮动层**，不占文档流 → 工作区内容全高；窗控按钮浮在 pane 之上，由 pane 头部预留空间避开（见 2.5-4）。页尾还有 `revert-popover`（撤回对话框）与 `obsidian-popover`（只读预览卡）两组弹层，与主诉求无关，属历史残留。

### 2.2 CSS 模块职责

| 文件 | 职责 | 要点 |
|------|------|------|
| tokens.css | 设计令牌 | 文件头注释自称「1-to-1 Exact Replica of tokens.css」，实为**现有令牌的子集快照且已漂移**（详见 §3.3） |
| layout.css | app-shell / 侧栏 / 浮动顶栏 | 侧栏 `width` 过渡 `--transition-normal`（220ms）；collapsed → width:0；顶栏 rail/trail 为圆角胶囊底色 |
| chrome-tabs.css | Chrome 标签条（v7） | 激活 tab 左右**外凹角**（8px radial-gradient 伪元素）、悬停上浮变圆角、非激活 tab 1px 分隔线、compact/icon-only 两档响应式收缩、拖拽态 |
| binary-tree.css | 二叉树布局 + 拖拽反馈 | flex 分支/叶子、5px resizer（hover 变蓝）、fixed 定位 drop-indicator（120ms 平滑过渡）、拖拽 pill |
| modals.css | 撤回对话框 + Obsidian 预览卡 | 与工作区布局无关；含 WebKit 滚动条伪影 workaround（`!important` 覆盖） |

### 2.3 JS 模块职责

| 模块 | 规模 | 职责 | 成熟度评价 |
|------|------|------|-----------|
| app.js | 2.4 KB | 仅侧栏折叠（`CustomEvent('sidebar-toggle')`）+ 两组弹层的开/关 | demo 级；无业务逻辑 |
| tree-store.js | 5.4 KB | 二叉树状态 + 事件订阅（activate/addTab/removeTab/reorder/rebuild）；`executeSplit` 统一拆/并；`_prune` 清理空 leaf | 可运行但**可变就地更新**（`_prune` 用 `delete`+`Object.assign`，`_split` 就地改节点）；tab 仅是 `{id,title}`，无会话/域概念；无 undo、无持久化 |
| drag-controller.js | 11.6 KB | 统一拖拽引擎：pill + drop-indicator 双 DOM；strip 插入（1/3 阈值 `_computeInsertIndex` + 插入后精确宽度 `_computeDropWidth` + transform 位移动画）；pane 象限 split（25%/75% 硬阈值）；`lostpointercapture` 自动清理；`_enterStrip` 缓存未位移 tab rect（`WebKitCSSMatrix` 反算 transform，防反馈环） | 语义完整、注释规范，单文件实现；跨浏览器 API（WebKitCSSMatrix）与硬编码阈值是弱点 |
| workspace-component.js | 15.6 KB | 双轨渲染：增量（激活/增/删/重排直接 DOM patch，带 max-width 展开 / freeze-width 收缩动画）+ 全量 rebuild（结构变更）；resizer pointer-capture 拖拽（最小 140px / ratio 钳制）；**位置感知**（top-row 去上圆角、right-edge 预留 104px 窗控、left-edge 折叠时 padding-left 38px）；tab 响应式 auto-size（w<80 compact、w<48 icon-only）；ResizeObserver | 原型中质量最高的模块；渲染架构清晰可读 |

### 2.4 background-art-showcase.html

独立的 Three.js WebGL 拟真云层/全天时大气 demo（GLSL shader、4 时段调色板、鼠标视差、air.inc 风格控制轨道）。与工作区布局/交互**零关联**，仅同目录附带，评审结论：忽略。

### 2.5 机制提炼

1. **布局模型——flex 递归二叉树**：`branch`（flex-direction: row/column）+ 两个 child + 5px resizer（负 margin 叠于缝隙，hover 高亮）。叶子 `flex:1`。与现有 flatten→百分比 rect 绝对定位完全不同，更贴近 DOM 原生，无几何投影层。
2. **标签页行为**：每个 pane 自带独立 Chrome 风格标签条（38px 头 + 34px tab）。激活 tab 与内容**同色融合**（bg-primary），左右外凹角制造「标签是从画布上切出来的」观感；左键激活/右键关闭（× 悬停显示）、中键关闭、+ 新建、拖拽排序/跨 pane 合并。紧凑模式下自动降档（compact 隐藏关闭钮 → icon-only 只留图标）。
3. **折叠「Zero Shift Collapsible Toggle Alignment」**：折叠后侧栏 width→0；顶栏浮动 overlay 本身不参与位移；**展开按钮出现在顶栏左 rail**，其 padding（10px）与侧栏 header 内 toggle 按钮位置严格对齐——鼠标无需移动即可再次点击；同时**最左 pane 头部自动加 padding-left 38px** 为 rail 让位（`sidebar-toggle` CustomEvent 驱动）。「零位移」= 内容/按钮不跳动、位置连续。
4. **拖拽语义（单一引擎双路径）**：拖到任意 pane 的**标签条** → 插入模式（1/3 阈值决定插入点，其他 tab transform 平移让位，indicator 显示「放置后 tab 精确宽度」）；拖到 pane **内容区** → 象限 split（left/right/top/bottom 各占半区，center=merge）。即「拖回标签栏=排序，拖出=分屏」。
5. **位置感知细节**：top-row pane 无上圆角（与窗口顶平齐）；right-edge pane 头部预留 104px 给 3 个窗控按钮并强制 min-width 140px 防重叠；left-edge pane 头部为折叠 rail 让位。

### 2.6 原型痕迹（未完成/待定）

- index.html 内置 revert-popover / obsidian 弹层（撤回流程残留），app.js 中 `openPopoverDialog` 无任何调用方
- `_createTab` 用 `innerHTML` 拼接（XSS 风险，原型无用户输入故可行）；动画清理依赖 `setTimeout(260ms/210ms)` 时序
- resizer 最小宽度水平 140px / 垂直 0.1 硬编码；窗控预留 104px、头高 38px 等大量 magic number 未入 token
- 无键盘可达性、无 focus trap、无测试文件
- drag-controller 注释自称「v7」，chrome-tabs「v7」，binary-tree「v7」——版本号自述迭代历史，说明原型是多轮手工打磨产物

---

## 3. 与现有实现对比

### 3.1 现有实现现状（基线）

- **状态层**：layoutTreeStore（zustand + persist，window-scoped）不可变纯函数 operations（split/merge/move/applyDrop），undo/redo 50 步，`normalizeTree`/`migrateFromColumns`；workspaceShellStore 持有 TabSurface（**sessionId 绑定**）+ per-tab rightDock，经 adapterShape 把 dock 投影为 per-session Conversation Unit（H(chat|tool)），treeDockProjection 抑制双向回环；**域隔离**（chat/tool）与 **unit scoped drop** 在 types/dropDetection 双重防护。
- **渲染层**：BinaryTreeWorkspace 用 `flattenTree` 输出百分比 rect → 绝对定位 + TreeResizeSash；`collapsedDomain` 折叠域（整棵子树压缩为 0 面积）。React.memo 稳定引用（stabilizeLeafEntries）避免重绘。
- **拖拽层**：T06.8 已收敛为 `usePointerDragBase`（阈值 5px、phase 状态机、pointerId 多指隔离、ghost ref 直写 DOM、Escape/pointercancel/lostpointercapture 兜底、drop 检测 16ms 节流、拖拽期 resize 重收集 rect），四套消费方：useTreeDrag（leaf/tab）、useTopBarDrag（会话标签条内重排 + 会话分屏 + 功能标签）、useToolDockTabDrag、useTabDragEvents。落点算法 `detectDropZone` 是**距离梯度加权 + 窄面板自适应**，优于原型 25%/75% 硬阈值。
- **标签层**：GlobalSessionTabBar（顶栏第 1 行）+ UnitSessionTabStrip（多 unit 分屏时 per-leaf 会话条，AA-04 指出二者构成重复对）；tab 为 folder 风格圆角块，roving tabindex + 键盘可达（S4.5）。

### 3.2 对比表

| 维度 | 原型 | 现有 | 差距 | 建议 |
|------|------|------|------|------|
| **布局模型** | flex 递归二叉树，DOM 原生递归，无几何层 | flatten → 百分比 rect 绝对定位 + sash；支持折叠域（collapsedDomain 压缩 0 面积） | 现有领先（折叠域、sash 键盘、不可变）；原型无折叠域概念 | 不迁移布局内核；可借鉴原型的「位置感知」细节（见整合 P2） |
| **标签页视觉** | Chrome 风格：激活 tab 外凹角 + 与内容同色融合、悬停上浮、1px 分隔线 | folder 圆角块；顶栏双行（工作区行 + 会话行） | **原型视觉显著领先**；现有双行是产品决定，不必照搬 | 将「外凹角融合」样式移植为 GlobalSessionTabBar 可选视觉（P0） |
| **标签响应式** | 2 档自动降档（compact 藏关闭钮 / icon-only 只留图标） | titlebar overflow 处理 + roving tabindex | 原型思路直观可借鉴 | 以 token 化的档位阈值落进现有 titlebar 体系（P1） |
| **标签动画** | 增 tab max-width 展开、删 tab freeze-width 收缩、拖拽位移 transform 180ms | 基本无动画（reduced-motion/perf-tier 有门控基础设施） | **原型领先** | 移植动画，接 perf-tier/reduced-motion 门控（P1） |
| **折叠/切换** | 「零位移」：浮动顶栏 + rail 按钮与侧栏 toggle 严格对齐 + 最左 pane 让位 38px | sidebar width→0 + 8px hover-trigger 悬停临时展开（hoverExpanded）；toggle 在顶栏固定行 | 原型对齐细节更精致；现有 hover 临时展开是差异化能力 | 借鉴「按钮位置连续」与「pane 让位」，保留 hover 展开（P1） |
| **拖拽引擎** | 单引擎双路径（strip 插入 / pane 象限）；1/3 阈值 + 插入后精确宽度预览；WebKitCSSMatrix 反算 | usePointerDragBase 收敛四套；距离梯度自适应落点；多指隔离/Escape/cancel 完备；drop 检测 16ms 节流 | **现有大幅领先**（状态机、鲁棒性、语义分层）；原型唯一亮点是插入预览与位移动画 | 引擎不移植；把「精确插入宽度 + 位移动画」回填到 tab-drag（P2） |
| **状态管理** | 可变就地更新，无 undo/持久化/session/域隔离 | 不可变纯函数 + undo 50 步 + persist + sessionId 绑定 + 域隔离 + adapterShape/dock 投影 | **现有全面碾压** | 不整合 |
| **设计令牌** | 自称 1-to-1 复刻，实为子集且已漂移（见 3.3） | tokens.css 为唯一真源（含 ui-size gear、perf-tier、语义色、titlebar 体系） | 现有为真源 | 原型令牌仅作历史快照参考，勿回迁 |
| **可达性/测试** | 无 | roving tabindex、focus trap、大量单测（layout-tree/dropDetection/拖拽/tab） | 现有领先 | — |

### 3.3 设计令牌关系

原型 tokens.css 与 `apps/crish-desktop/src/styles/tokens.css` **同源但不全等**：

- **相同**：基础色板（light 暖灰 hsl(35,…) 全部一致）、spacing 阶梯、radius、transition、shadow 结构、dark 调色——这些值精确复刻。
- **漂移**：`--header-height: 44px`（现有 36px，且现有另有 28px titlebar 体系）；`--sidebar-width: 240px` 而 layout.css 实际回退 260px（现有 260px 且注释「runtime overridden」）；字体族原型用 Inter/JetBrains Mono（Google Fonts），现有是微软雅黑/Cascadia 体系；原型缺现有大量扩展（ui-size 档、perf-tier、语义色 role、titlebar token、面板/terminal/xterm）。
- **结论**：原型令牌是**设计时点快照**，仅能证明「原型视觉 = 当时 tokens 的投影」，不能反向把原型 CSS 当作令牌演进依据；任何整合都必须消费现有 tokens.css 变量。

---

## 4. 评估

### 4.1 值得整合（原型领先）

1. **Chrome 风格激活标签外凹角融合**——视觉差异化最强，纯 CSS（radial-gradient 伪元素），移植成本最低。
2. **标签增删/拖拽位移动画**——原型将「增删不跳动」做到了 DOM 层细节（freeze-width 收缩、max-width 展开、transform 让位），现有缺失。
3. **零位移折叠细节**——rail 按钮与侧栏 toggle 位置连续 + 最左 pane 让位，是成熟的交互打磨。
4. **标签 2 档响应式降档**——compact/icon-only 思路可直接 token 化。
5. **位置感知 pane 角处理**——top-row 去上圆角、right-edge 窗控预留、left-edge 折叠让位，可作为 BinaryTreeWorkspace 的 polish 清单。

### 4.2 现有已领先（无需回迁）

- 二叉树状态与操作（不可变、undo、persist、sessionId 绑定、域隔离、adapterShape dock 投影、折叠域）
- 拖拽基座（usePointerDragBase 的 phase 状态机、多指隔离、Escape/cancel/lostpointercapture、resize 重收集）
- 落点检测（距离梯度自适应 vs 原型硬阈值）
- 可达性、测试、令牌体系

### 4.3 原型不完整处

- tree-store 可变更新 + `_prune` 深拷贝链（性能与正确性均弱）；`executeSplit` 的「目标被 prune 后回退 firstLeaf」是脆弱的兜底
- drag-controller 用 `WebKitCSSMatrix`（跨浏览器风险，Tauri WebView 可用但不可作为通用方案）
- 动画 setTimeout 时序耦合；magic number（38/104/140/25%/75%）未 token 化
- revert/obsidian 弹层与背景艺术 showcase 为无关残留

---

## 5. 整合建议（按优先级）

| 优先级 | 建议 | 落地方式 |
|--------|------|----------|
| **P0** | Chrome 风格激活 tab 外凹角融合样式 | 在 GlobalSessionTabBar/UnitSessionTabStrip 做可选样式档（CSS-only，消费现有 token）；先做单 tab 试点，验证深色/折叠/窄栏无伪影 |
| **P0** | 标签 2 档响应式降档 | 在 titlebar token 体系下定义档位阈值（如 tab 宽 <80 compact、<48 icon-only），接入现有溢出处理 |
| **P1** | tab 增删动画 + 拖拽插入位移动画 | 移植 freeze-width 收缩 / max-width 展开 / transform 让位；必须接 `reduced-motion` 与 perf-tier 门控；动画结束清理用 transitionend 而非 setTimeout |
| **P1** | 零位移折叠细节 | 保留 hover 临时展开；将「展开按钮与折叠前 toggle 位置对齐 + 最左 pane 让位」落到 AppTopBar/侧栏交互（注意现有顶栏非浮动，需评估布局差异） |
| **P2** | 拖拽插入「精确宽度 + 空位预览」 | 把 `_computeDropWidth`/`_computeInsertIndex` 思路回填到 tab-drag 重排路径（现有重排无空位指示） |
| **P2** | 位置感知 pane 角处理清单 | 以原型为 spec，对照 BinaryTreeWorkspace 现有样式逐一核对（top-row 圆角、窗控预留等） |
| **不整合** | tree-store / drag-controller / modals / obsidian / 背景艺术 | 现有对应能力已全面超越；残留物与主诉求无关 |

---

## 6. 风险提示

1. **令牌漂移陷阱**：原型 tokens.css 自称 1-to-1 但 header/sidebar/字体已漂移；若以其为「同源证据」回迁样式，会把 44px/240px/Inter 等旧值带回生产。整合必须只消费现有 tokens.css 变量。
2. **外凹角伪影**：原型激活 tab 用 8px radial-gradient 与 `--bg-primary` 同色假曲线，在深色主题、perf-tier=eco、多 pane 贴缝（1px gap）场景易出现灰边/断线；需逐主题验收。
3. **浮动顶栏方案不适用于现有**：原型的「窗控浮在 pane 上 + right-edge 预留 104px + min-width 140px」是 hack 链；现有 AppTopBar 独立固定行更稳，整合时只取「对齐/让位」理念，勿搬浮动层。
4. **动画与性能**：原型动画无 perf-tier 概念；生产迁移必须接 reduced-motion 与 eco 档零过渡，否则在低配机上违背现有性能契约。
5. **不可移植实现**：drag-controller 的 WebKitCSSMatrix、workspace-component 的 innerHTML 拼接、setTimeout 清理序列，均不能直接进入 React/TS 代码库；只迁移设计模式。
6. **现有能力勿回退**：整合「视觉层」时不得触碰 session 绑定、域隔离、dock 投影、undo 等现有正确性边界（拖拽预览若与 unit-scoped drop 冲突，以现有守卫为准）。

---

## 7. 结论

原型在**视觉打磨与交互细节**（Chrome 标签融合、增删/拖拽动画、零位移折叠、位置感知角处理）上是一次高质量的设计冲刺，`workspace-component.js` 的渲染架构尤其值得学习；但在**工程成熟度**上它是原型态——状态层、拖拽引擎、可达性与测试全部落后于现有实现。建议按 P0→P2 做「样式/动画/细节」三批吸收，以现有 tokens、usePointerDragBase、layout-tree 为骨架，原型只提供视觉 spec 与交互意图，不引入任何源码级移植。
