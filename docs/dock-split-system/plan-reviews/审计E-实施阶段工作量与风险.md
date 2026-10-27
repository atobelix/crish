# 架构与工程审计报告 E：实施阶段工作量与工程落地风险深度审查

> **审计标的**：
> - `docs/dock-split-system/00-总方案.md` §四（Phase 1~4 单向 DAG 实施规划）与 §五（立体化真值验收断言与测试矩阵）
> - `docs/dock-split-system/analysis/02-右坞容器与分屏渲染架构.md`
> - `docs/dock-split-system/analysis/06-分屏交互体验与自适应布局.md`
> 
> **实地白盒核查源码**：
> - `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css`
> - `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx` 及 `LeafToolTabStrip.module.css`
> - `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx` 及 `treeLeafPanelModel.ts`
> - `apps/crish-desktop/src/store/layout-tree/operations.ts`、`layoutTreeInsert.ts`、`layoutTreeTransform.ts`
> - 现有关键测试套件：`LeafToolTabStrip.scoped.test.tsx`、`NewTabLauncherPopover.test.tsx`、`sessionTabMigration.test.ts`
> 
> **审计角色**：资深工程落地与工作量风险审计师  
> **遵循铁律**：仓库通用协作纪律 `AGENTS.md`（§1 反退避、§7 严禁补丁作弊、§7.1 立体验证纪律、§9 测试资产保护铁律、§12-§14 UI 规范）、反过度设计红线 `ANTI_OVERENGINEERING_GUARDRAILS.md`。

---

## 审计结论总览

| 审计维度 | 评估要点 | 结论标签 | 核心风险摘要 |
| :--- | :--- | :--- | :--- |
| **维度 1** | Phase 1（数据模型）的交付边界模糊 | **【冲突：必须解决】** | Phase 1 右坞视觉零改动，但顶栏加号浮层却被提前剥离局部工具入口，造成跨阶段“功能真空”；且升水测试未设为阶段阻断门禁。 |
| **维度 2** | Phase 2（渲染容器）是迄今最大的破坏性改动 | **【冲突：必须解决】** | 用绝对 Canvas 替换 Flex 抽屉，面临直接丢失或严重破坏 `LeafToolTabStrip` 454 行成熟交互与 575 行极限压测资产的巨大风险；缺乏平滑抽象复用路径。 |
| **维度 3** | Phase 3（拖拽）依赖 Phase 2 完成但完成标准缺失 | **【警告：可接受但需澄清】** | Phase 2 缺失 DOM 冻结与静态分屏验证门禁；拖拽落点探测对底层 DOM 极度敏感，两阶段重叠开发必将导致测距漂移与指针捕获冲突。 |
| **维度 4** | `@container` 容器查询的浏览器/WebView 兼容性 | **【冲突：必须解决】** | 方案 06 出现严重 W3C CSS 规范自相矛盾（`inline-size` 容器查询 `max-height` 恒为 false）；且未考虑 jsdom 单元测试环境对 `@container` 的零支持断层。 |
| **维度 5** | 测试矩阵完整性与实施阶段门禁对应 | **【警告：可接受但需澄清】** | 遗漏 `flattenDockTree` 几何极限测试与 React 组件调和隔离断言；测试矩阵未映射至 Phase 1~4 阶段阶梯门禁，存在推迟债务漏洞。 |

---

## 维度 1：Phase 1（数据模型）的交付边界模糊

### 审计结论：【冲突：必须解决】

### 1.1 事实核查与技术背景

根据 `docs/dock-split-system/00-总方案.md` §四（第 228-239 行）：
```markdown
* **Phase 1（核心契约与顶栏净化）**：
  - 新建 dockLayoutModel.ts 纯函数二叉树模型与单测；
  - 改造 layoutTreeTerminalOps.ts 与 ptyCreateArgs.ts，落地纯净家目录 Standalone Terminal；
  - 重构 NewTabLauncherPopover.tsx，顶栏加号收敛。
```

方案将“数据模型纯逻辑构建”与“顶栏大窗口加号浮层重构”打包在 Phase 1，但对右坞在 Phase 1 结束时的状态与表现定义模糊。

### 1.2 发现的三大工程落地断层与风险

#### 1. 交付边界断层：右坞视觉零改动 vs 顶栏加号产生“功能真空”
- **右坞现状**：在 Phase 1 期间，`TreeLeafPanel.tsx:433-486` 依然挂载原有的 `LeafToolTabStrip`，状态依然消费扁平的 `dock.openPanelIds` 与 `dock.activePanelId`。右坞在 Phase 1 结束后是**纯后台数据契约准备，视觉与交互 100% 零变化，用户完全无感知**。
- **顶栏现状**：在 Phase 1 期间，方案要求重构 `NewTabLauncherPopover.tsx`。依据方案 §3.3（第 152-154 行）：“顶栏加号仅保留两大核心操作：【新建对话】与【新建独立终端】；原有的局部工作区终端、局部浏览器等选项全部移出顶栏，归拢至右坞内部微型 TabStrip 的加号菜单。”
- **致命的早产剥离与功能真空**：
  核查代码 `apps/crish-desktop/src/components/binary-tree/NewTabLauncherPopover.tsx:125-149`，当前顶栏加号承载着打开局部终端（`addTerminalTab`）与局部浏览器（`addBrowserTab`）的核心入口；同时其测试 `NewTabLauncherPopover.test.tsx` 严格断言了这三项基础操作的键盘漫游与点击派发。
  在 Phase 1 中，右坞内部的微型 TabStrip（`MicroPaneTabStrip`）根本尚未开始开发（Phase 2 才做渲染容器，Phase 3 才做拖拽）。如果在 Phase 1 就把工作区终端和浏览器从顶栏直接剥离，那么在 Phase 1 交付至 Phase 2 完成期间，用户在整个应用中将**彻底失去打开工作区终端和局部浏览器的操作入口**！

#### 2. 升水测试（Hydration）未设为 Phase 1 强阻断门禁，存量数据迁移风险敞口巨大
- 方案在 §3.1 声称增设 `layout?: DockLayoutTree` 并提供 `ensureDockLayoutTree(dock)` 升水管道，且在 §五测试矩阵列出 `dockLayoutHydration.test.ts`。
- 但是在 §四 Phase 1 任务清单中，仅轻描淡写地写了“新建 `dockLayoutModel.ts` 纯函数二叉树模型与单测”，压根没有把 `dockLayoutHydration.test.ts` 标定为 Phase 1 阶段交付物。
- 核查现存代码 `apps/crish-desktop/src/store/layout-tree/sessionTabMigration.ts:1-80` 及配套单测 `sessionTabMigration.test.ts`（550 行，13.6KB）。所有持久化会话从 IndexedDB/LocalStorage 恢复均经过迁移管线。若 Phase 1 开发者仅在孤立的 `dockLayoutModel.ts` 中跑通自娱自乐的纯函数单测，而未在 Phase 1 将存量布局升水和反序列化测试跑通，将把潜在的脏数据与不可恢复树结构隐患遗留到 Phase 2 实装时爆发。

### 1.3 刚性整改要求

1. **入口迁移时序重排（禁止早产破坏）**：
   Phase 1 的 `NewTabLauncherPopover.tsx` 改动仅允许**追加**【新建独立终端】（`isStandalone: true`），**严禁在 Phase 1 提前删除现有局部终端/浏览器入口**。顶栏局部入口的下线必须推迟到 Phase 2（当右坞具备可用窗格加号菜单后）才能原子切换。
2. **Phase 1 验收门禁锁定**：
   必须在 Phase 1 显式将 `dockLayoutModel.test.ts`、`dockLayoutHydration.test.ts` 以及现有的 `sessionTabMigration.test.ts`、`sessionTabModel.test.ts` 设定为 100% 绿通的退出门禁。

---

## 维度 2：Phase 2（渲染容器）是迄今最大的破坏性改动

### 审计结论：【冲突：必须解决】

### 2.1 事实核查与现有 CSS/组件拓扑证据

核查 `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css`：
1. **右坞抽屉布局定义**（第 415-425 行）：
   ```css
   .leafDockDrawer {
     flex: 0 0 var(--leaf-dock-width, 50%);
     width: var(--leaf-dock-width, 50%);
     min-width: 200px;
     max-width: 70%;
     min-height: 0;
     display: flex;
     flex-direction: column;
     overflow: hidden;
     border-left: 1px solid var(--border-subtle);
   }
   ```
2. **面板宿主布局定义**（第 444-454 行）：
   ```css
   .dockPanelPane {
     width: 100%;
     height: 100%;
     min-width: 0;
     min-height: 0;
     flex: 1 1 auto;
     display: flex;
     flex-direction: column;
     overflow: hidden;
     position: relative;
   }
   ```
3. **`TreeLeafPanel.tsx:433-486` 现有渲染树**：
   `.leafDockDrawer` 是标准 flex-column 容器。其第一子元素为 `LeafToolTabStrip`（固高 `var(--header-height)` = 36px），第二子元素为包裹在 `AppErrorBoundary > Suspense` 内的 `.dockPanelPane` 集合，当前通过 `display: isPanelActive ? 'flex' : 'none'` 实现单视口切换。

### 2.2 发现的重大工程风险与资产保护危机

#### 1. 454 行成熟交互组件 `LeafToolTabStrip` 面临被粗暴废弃或割裂的危险
白盒核查 `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx`（454 行）及其专项极限压测套件 `LeafToolTabStrip.scoped.test.tsx`（575 行），该组件内部沉淀了极高价值的人机交互资产：
- **三重安全关闭保险丝机制**（L139-160, 212-277）：针对 Tab 关闭时的 CSS `@starting-style` 与离场过渡，通过 `closingIdsRef` 记录、`readTransitionMs` 动态测算时长、并挂载 `window.setTimeout(ms * 3)` 兜底超时保险丝（`fuseTimersRef`），彻底根治由于浏览器 `transitionend` 丢失引发的“幽灵 Tab 内存泄漏”；
- **动态溢出感知与双态加号**（L163-179, 408-422）：`ResizeObserverManager` 测算容器横向溢出，在未溢出时在 Tab 序列后流式展示加号，溢出时自动下沉收敛至右侧固定操作区（pinned）；
- **非被动滚轮横向滑动**（L182-191）：`useNonPassiveWheel` 拦截鼠标纵向滚轮并将其转化为原生平滑横向滚动，彻底解除 Chromium 控制台 passive 监听告警；
- **WAI-ARIA 标准键盘导航**（L206-210）：集成 `useTablistKeyboard`，支持 `ArrowLeft/Right/Home/End` 导航与即时激活；
- **空态 LauncherHub**（L447-449）：零标签时的居中快捷工具唤起。

#### 2. 方案在 Phase 2 中的实施断层
- 方案 §3.6 提出“单工具时退化为现有 LeafToolTabStrip 经典样式；多分屏时右坞顶层收敛为 28px 全局控制条，每个分屏窗格拥有独立 28px MicroPaneTabStrip”。
- **但在 Phase 2 实施清单中，对这 454 行成熟交互资产的迁移与集成方案只字未提**！
- **两种错误路径的灾难性后果**：
  - *路径一（粗暴重写）*：如果在 Phase 2 为了赶进度，直接在 `DockPaneHost` 里草率写一个仅有静态 mapping 的简单 Header，上述经过 575 行单测保护的关闭动效保险丝、横向滚轮、A11y 键盘漫游、双态加号将**全部丢失**，发生严重体验倒退（Regression）；
  - *路径二（分裂双维护）*：单窗格用 `LeafToolTabStrip`，多窗格用独立的 `MicroPaneTabStrip`。两套标签栏代码各自为战，未来在 Phase 3 接入拖拽与复合生命周期时，必须重复编写两次并维护两份 Bug，直接违反 `AGENTS.md` §7 架构净收敛与单一真理源原则。

### 2.3 刚性整改要求

1. **提取公共核心 Hook（禁止另起炉灶）**：
   在 Phase 2 开工前，必须先从 `LeafToolTabStrip.tsx` 中将关闭保险丝状态机、键盘导航、滚动溢出监测抽离为可复用的轻量 Hook：
   - `useToolTabLifecycle.ts`（接管 `closingTabIds`、`fuseTimers`、`triggerCloseTab`、`finalizeClose`）；
   - `useTabTrackScroll.ts`（接管横向滚轮与溢出检测）；
2. **两级 TabStrip 结构同构**：
   `LeafToolTabStrip` 与新规划的 `MicroPaneTabStrip` 必须共同复用上述底层 Hook。确保分屏微型条天然具备完整的动画退场保险丝与键盘漫游能力，且原有的 575 行 `LeafToolTabStrip.scoped.test.tsx` 必须持续保持 100% 绿通。

---

## 维度 3：Phase 3（拖拽）依赖 Phase 2 完成，但 Phase 2 完成标准不清晰

### 审计结论：【警告：可接受但需澄清】

### 3.1 事实核查与技术背景

根据方案 §四：
- Phase 2：落地 `flattenDockTree`、`DockSplitWorkspace.tsx`、`DockResizeSash.tsx`、接入 `TreeLeafPanel.tsx`；
- Phase 3：落地 `DockToolDragContext.tsx`、`PaneHeader.tsx` 绝对门锁、22% 边缘分屏与中心合并。

方案未对 Phase 2 设置清晰的准出门槛（Done Criteria），仅罗列了待建模块。

### 3.2 发现的工程协同风险

#### 1. 落点检测算法与不稳定 DOM 的破坏性耦合
- Phase 3 核心是 `detectDockDropZone`（边缘 22% 判定与中心 Merge 判定）。落点检测算法深度依赖目标窗格的实际物理几何：通过 `paneEl.getBoundingClientRect()` 与 `canvasEl.getBoundingClientRect()` 进行坐标换算。
- 若 Phase 2 的 DOM 拓扑树（从 `.leafDockDrawer` 到 `.dockSplitWorkspace` 到 `.dockCanvas` 到 `.dockPaneHost`）尚未冻结，容器内边距、发丝边框计算或 Sash 占位方式随时变动，Phase 3 的落点检测将陷入“计算偏差 -> 修补魔术数字 -> DOM 再次微调 -> 落点再次失效”的反复返工中。

#### 2. 指针事件捕获（Pointer Capture）并发争抢与“粘手”隐患
- Phase 2 的 `DockResizeSash` 使用了原生 `setPointerCapture` 与全局 iframe 遮蔽（`disableIframePointerEvents`）；
- Phase 3 的工具 Tab 拖拽同样必须在宿主或根节点上监听 `pointermove` 与 `pointerup`；
- 若 Phase 2 的 Sash 状态机未经过异常打断（如 `WindowBlurWatchdog`、`pointercancel`）的完全收敛测试，一旦用户在分屏线边缘拖拽工具 Tab，Sash 与 Tab 拖拽上下文将同时争抢指针捕获，导致致命的指针事件吞噬、光标锁死或界面粘手。

### 3.3 刚性整改要求

1. **确立 Phase 2 静态完备性验收门禁（Gate 2）**：
   严禁将“拖拽交互”作为检验 Phase 2 渲染容器的手段。Phase 2 必须在**完全不依赖拖拽**的前提下实现闭环验收：
   - 通过窗格右上角“向右分屏 / 向下分屏”按钮与快捷键（`Ctrl+Shift+\` / `Ctrl+Shift+-`），能够稳定进行 1~4 窗格的任意静态拓扑切分；
   - `DockResizeSash` 能够双向平滑调整比例，DOM 直写帧率稳定，松手正确持久化，单测 `dockResizeSash.test.tsx` 绿通；
   - DOM 树结构、类名及 `data-dock-pane-id` 契约彻底冻结；
2. 只有在 Gate 2 完全通过且签署验收断言后，才允许开启 Phase 3 拖拽上下文的编码。

---

## 维度 4：`@container` 容器查询的浏览器/WebView 兼容性

### 审计结论：【冲突：必须解决】

### 4.1 发现的致命技术硬伤：W3C CSS 规范逻辑自相矛盾

审查 `docs/dock-split-system/analysis/06-分屏交互体验与自适应布局.md` 与 `02-右坞容器与分屏渲染架构.md`，发现了一处**必定失效的规范硬伤**：

1. **容器类型声明**（方案 06 第 248 行）：
   ```css
   .dockPaneBody {
     container-type: inline-size; /* ⚠️ 声明为内联轴（仅宽度）容器 */
     container-name: dock-pane;
   }
   ```
2. **容器查询规则书写**（方案 06 第 262-264 行 与 第 301-306 行）：
   ```css
   /* 窗格纵向紧凑断点：高度 < 240px (用于上下分屏场景) */
   @container dock-pane (max-height: 240px) { ... }

   @container dock-pane (max-height: 200px) {
     .terminalHeaderSummary {
       display: none !important;
     }
   }
   ```
3. **规范硬性阻断证据**：
   依据 W3C CSS Containment Level 3 规范（CSS Container Queries Specification §3.1）：
   > `container-type: inline-size` establishes a query container for dimensional queries on the container's inline axis only. Evaluating a container query that queries block dimensions (such as `height` or `max-height`) against an `inline-size` container **must evaluate to unknown (treated as false)**.

   这意味着：**在 Chromium、WebKit 以及任何现代浏览器中，方案中书写的 `@container dock-pane (max-height: ...)` 将 100% 恒定求值为 false，永远不可能生效！**

4. **如果盲目改为 `container-type: size` 的次生灾难**：
   若将 `.dockPaneBody` 改为 `size`（全尺寸容器），CSS 规范将强制应用 2D 尺寸包含（size containment）。容器高度**绝对不可由子元素内容撑开**。若父容器高度未严格由绝对坐标或 flex 显式定死，容器高度将瞬间塌陷为 0px，在 Safari/WebKit 中曾多次出现由于 flex 尺寸未就绪导致的渲染为 0px 白屏事故。

### 4.2 跨平台 WebView 环境与自动化测试盲区

1. **测试断层（jsdom 致命盲区）**：
   前端 Vitest 单元测试运行在 `jsdom` 环境（如 `LeafToolTabStrip.scoped.test.tsx:1` 声明 `// @vitest-environment jsdom`）。
   **jsdom 至今完全不支持 CSS Container Queries**！任何依赖 `@container` 的响应式样式在 jsdom 中不仅无法生效，而且测试完全无法断言样式是否触发。若不提供数据属性（data attribute）桥梁，自适应功能在 CI 中将处于 100% 测试盲区。
2. **缺乏防御性回退（Fallback）**：
   方案 06 未提供 `@supports not (container-type: inline-size)` 或低版本 WebKit 运行时的任何 CSS 回退机制。

### 4.3 刚性整改要求

1. **废弃 `@container (max-height: ...)` 语法**：
   高度相关的紧凑适配严禁使用容器查询。由 `DockPaneHost` 在渲染或尺寸计算时，根据窗格像素高度判定高度层级，向 DOM 节点挂载 `data-height-tier="compact" | "normal"`，通过标准 CSS 属性选择器 `[data-height-tier="compact"]` 控制终端状态栏的隐藏；
2. **纯宽度自适应保持 `container-type: inline-size`**：
   宽度断点（`< 380px`、`< 260px`）保留 `@container (max-width: ...)`，同时由组件层配合挂载 `data-width-tier="compact" | "normal"`，既能通过属性选择器在 jsdom 自动化单测中编写断言，又能在低版本 WebView 中作为 100% 可靠的保底回退。

---

## 维度 5：测试矩阵完整性评估

### 审计结论：【警告：可接受但需澄清】

### 5.1 事实核查与现有测试目录对比

方案 §五（第 258-267 行）列出了 8 项测试：
1. `dockLayoutModel.test.ts`
2. `dockLayoutHydration.test.ts`
3. `standaloneTerminal.test.ts`
4. `dockDragDomainIsolation.test.ts`
5. `multiTerminalLifecycle.test.ts`
6. `sessionSwitchSuspend.test.ts`
7. `dockResizeSash.test.tsx`
8. `FULL_CHECK_COMMANDS`

核查现有测试仓库：
- `apps/crish-desktop/src/store/layout-tree/` 下现有测试：`sessionTabModel.test.ts`、`sessionTabMigration.test.ts`、`operations.test.ts`、`layoutTreeTerminalBrowser.test.ts` 等；
- `apps/crish-desktop/src/components/binary-tree/` 下现有测试：`LeafToolTabStrip.scoped.test.tsx`、`NewTabLauncherPopover.test.tsx`、`TreeLeafPanel.*.test.tsx` 等。
方案提出的 8 个测试全部为新拟文件。

### 5.2 发现的关键路径测试遗漏与纪律缺陷

#### 1. 核心几何算法 `flattenDockTree` 极限单测缺失
方案渲染容器的全部稳定性维系于 `flattenDockTree` 纯函数。但在测试矩阵中仅在模型测试中顺带提及“面积守恒”。
严重遗漏了对以下极限拓扑几何投影的穷举断言：
- 单叶退化（0 分支，1 窗格，rect 必须恒为 `[0,0,1,1]`，0 个 Sash）；
- 4 窗格交错切分（左右内嵌上下，上下内嵌左右）；
- `splitRatio` 极端贴近 `0.1` 与 `0.9` 时的最小像素保护（MIN_CHILD_PX）；
- 单窗格最大化（soloPane 激活时，目标窗格全屏覆盖，其余窗格几何不漂移）。

#### 2. React Reconciliation 调和碰撞与组件实例隔离测试缺失
方案反复指出现状缺陷：“SlotOutlet 静态 Key 碰撞导致多终端状态串味”。
但在测试矩阵中，第 5 项 `multiTerminalLifecycle.test.ts` 仅关注 Rust 进程层 ConPTY PID 的隔离与清理，**完全遗漏了 React 组件层的调和与上下文隔离测试**！
必须有专门的前端组件级单测断言：在同一个右坞中分屏挂载两个同类型视图（如两个终端或两个 Diff），断言其各自拥有独立的 `DockLeafScopeContext` 与 `CompositeKey`，重渲染或聚焦窗格 A 绝不触发窗格 B 的状态覆盖或重新挂载。

#### 3. 阶段测试门禁（Phase Gates）严重缺失
方案 §五仅有一句“交付前必须全量跑通以下测试集”，未将测试矩阵与 Phase 1~4 实施阶段绑定。
这违背了 `AGENTS.md` §7.1 的立体验证纪律与反退避原则：实施者可以在 Phase 1~3 不跑任何新增测试，将所有测试推迟到 Phase 4 最终收口，造成技术债务与风险黑盒。

### 5.3 刚性整改要求：建立实施阶段阶梯验收门禁矩阵（Phase Gate Matrix）

必须将测试矩阵严格分配至各 Phase，作为硬性代码提交与合并门禁：

| 实施阶段 | 阶段准入条件 | 阶段必须 100% 绿通的测试门禁 (Phase Gate) | 违规阻断判定 |
| :--- | :--- | :--- | :--- |
| **Phase 1**<br/>数据模型与顶栏收敛 | 方案评审通过 | 1. `dockLayoutModel.test.ts`（纯函数二叉树分割/合并/修剪）<br/>2. `dockLayoutHydration.test.ts`（旧数据 100% 升水且字段不丢）<br/>3. 存量 `sessionTabMigration.test.ts` 与 `sessionTabModel.test.ts` 零破坏<br/>4. `standaloneTerminal.test.ts`（独立终端目录与全屏独占断言） | 任何旧数据升水失败或存量单测红灯，绝对禁止进入 Phase 2。 |
| **Phase 2**<br/>右坞分屏渲染与 Sash | Phase 1 Gate 绿通 | 1. `flattenDockTree.test.ts`（极限几何与面积守恒穷举）<br/>2. `dockResizeSash.test.tsx`（双向拖拽 DOM 直写与指针捕获）<br/>3. 存量 `LeafToolTabStrip.scoped.test.tsx` 提取 Hook 后全量保持绿通<br/>4. 存量 `TreeLeafPanel.*.test.tsx` 全绿，完成无拖拽静态分屏现场验收 | 若静态切分未达标或存量 TabStrip 倒退，绝对禁止进入 Phase 3。 |
| **Phase 3**<br/>拖拽系统与四重隔离 | Phase 2 Gate 绿通 | 1. `dockDragDomainIsolation.test.ts`（顶栏绝对拒收与原路回弹断言）<br/>2. `dockDropDetection.test.ts`（22% 边缘 Split 与中心 Merge 几何判定）<br/>3. 跨会话/跨域拖拽事务拒绝断言 | 顶栏若存在任何视觉位移或误吸入，绝对禁止进入 Phase 4。 |
| **Phase 4**<br/>生命周期自愈与自适应 | Phase 3 Gate 绿通 | 1. `multiTerminalLifecycle.test.ts`（多 PTY 进程隔离与孤儿清理）<br/>2. `dockReactReconciliation.test.tsx`（CompositeKey 调和与组件状态隔离）<br/>3. `sessionSwitchSuspend.test.ts`（会话切换脱水与缓冲区自愈）<br/>4. `FULL_CHECK_COMMANDS`（快层 Vitest 全绿 + `cargo check` + `npm run typecheck`） | 全量流水线有任何报错或告警，严禁宣称战役完工。 |

---

## 总结与工程落地裁决

本审计师经深入代码核查与工程推演，裁定：
1. **方案的 4 个 Phase 划分大体符合依赖演进逻辑，但在交付边界、存量资产保护及规范严密性上存在硬伤**；
2. **【维度 1】、【维度 2】与【维度 4】所揭示的 3 处冲突必须在正式编码前修订入《00-总方案.md》**，特别是：
   - 修正顶栏加号过早剥离局部工具的真空期 Bug；
   - 明确 `LeafToolTabStrip` 核心逻辑下沉为 Hook 的复用路径，严禁丢弃现有 575 行极限测试资产；
   - 消除 `container-type: inline-size` 与 `max-height` 的 W3C 规范矛盾，改用数据属性驱动高度紧凑态；
3. **严格执行本报告 §5.3 设立的阶梯验收门禁矩阵（Phase Gate Matrix）**，杜绝未测代码跨阶段污染，确保右坞分屏系统高质量稳健落地。
