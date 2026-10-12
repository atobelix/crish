# 08 — 前端 UI 原子组件、浮层调度与 CSS 渲染合成 + 内存生命周期交叉优化架构方案

> **方案编号**：PLAN-PERF-08-09  
> **所属战役**：全栈性能深度审计战役 — 第二阶段双 Agent 交叉出案波（Agent-08 独立规划）  
> **覆盖范围**：
>
> - **Part 08**：UI 原子组件库、浮层调度栈（`LayerStack`）、几何瞄准引擎（`SafeAim`）与 CSS 渲染合成管线（26 项缺陷：`PERF-UI-01` ~ `PERF-UI-26`）
> - **Part 09**：内存泄漏、长生命周期资源驻留、定时器/IPC 监听闭环与同步存储阻塞（22 项缺陷：`F-09-01` ~ `F-09-22`）
> - **Cross-Cutting**：UI 浮层调度与 Detached DOM 驻留解耦、全局事件监听与应用级生命周期协同
>   **规范遵循**：`AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`三原则.md`、`00-DISCIPLINE.md`  
>   **设计准则**：纯逻辑拓扑推进、48 项缺陷问题同权零退避、单一真理源（SSOT）、拒绝补丁主义与伪优化、真实环境立体验证

---

## 一、方案总纲与架构愿景 (Executive Summary & Architecture Vision)

### 1.1 优化背景与双维度交叉挑战

桌面端 AI 工作台（Conex / Crish）具备**超长单次运行周期（持续数日不关窗）**、**高频多会话流式交互（~31Hz 渲染帧率）**、**多工作区/分屏标签页动态挂载**以及 **WebView2 宿主环境** 四大核心运行特征。

在第一阶段的深度全景审计中，Part 08 与 Part 09 揭示出严重的结构性性能衰竭与内存泄漏断层：

1. **渲染合成侧（Part 08）**：全局 CSS 通配属性与后代选择器打穿 Chromium Blink 样式哈希索引；常驻节点滥用 `will-change` 与 `backdrop-filter: blur()` 引发 GPU 显存膨胀；Tooltip、Safe-Aim、LayerStack 在全局输入事件中高频广播并触发无意义的深树 DOM 遍历与强制同步回流；Select / Combobox 展开阶段引发 $O(N^2)$ 挂载风暴，悬停触发全量级联重渲染。
2. **内存生命周期侧（Part 09）**：`MessageSnapshots` 账本失真漏算全量消息体，导致名义 5MB 预算失效；新旧两套会话逐出状态机分裂；会话硬删除级联断链，12 个模块级 `Map`/`Set` 容器孤儿化；后台 PTY 终端子进程漏杀；定时器触发回调将已终态 ID 错误追加进活跃集合；Tauri 异步监听存在卸载竞态；高频流式帧内同步执行大对象 JSON 序列化与 `localStorage` 阻塞。
3. **二者交叉的核心痛点**：`LayerStackManager` 的 `dismissedByPointer` 与 `anchorPointerDownTarget` 跨帧长期持有已关闭组件的真实 DOM 引用，在虚拟滚动与分屏卸载后使整棵 Detached DOM 子树及其 React Fiber 无法被 GC 回收；同时，多个 UI 模块（TooltipController、SafeAimEngine、LayerStackManager）在 `window` / `document` 上绑定的数十个全局输入监听器，在没有浮层处于激活态时依然持续截获每一次按键与鼠标微动，加剧了事件派发与闭包停留开销。

### 1.2 架构重构核心目标与量化指标 (SLO)

| 核心维度                   | 现有瓶颈指标 (Baseline)                                   | 重构目标指标 (Target SLO)                               | 改善幅度与预期收益                                |
| :------------------------- | :-------------------------------------------------------- | :------------------------------------------------------ | :------------------------------------------------ |
| **全局样式匹配耗时**       | 流式追加单帧 `Recalculate Style` 达 8~25ms                | 单帧 `Recalculate Style` $\le 1.2\text{ms}$             | 样式匹配效率提升 **85%+**，彻底消除样式瓶颈       |
| **GPU 合成层与显存**       | 静态常驻合成层 100+ 个，VRAM 占用 120MB+                  | 静态常驻合成层 $\le 18$ 个，VRAM 占用 $\le 35\text{MB}$ | 显存占用下降 **70%+**，消除滚动层 GPU Readback    |
| **Tooltip 滚动与点击开销** | 每次滚动帧 $3N$ 次 `setState` + 全文档 `querySelectorAll` | 滚动/点击空闲短路判定 $O(1)$，JS 执行耗时 **0ms**       | 彻底消除长列表滚动时的 Tooltip 级联风暴           |
| **Select/Combobox 挂载**   | 80 项展开需 $O(N^2)$ 次对象重构，首帧卡顿 45ms+           | 展开首帧执行时间 $\le 3\text{ms}$，微任务合并单次渲染   | 挂载计算量从 $O(N^2)$ 降为 $O(N)$，彻底消除帧卡顿 |
| **Select 悬停重渲染范围**  | 鼠标划过触发全列表 $N$ 个 Item + Trigger 重渲染           | 仅更新旧/新高亮 2 个 Item，其余 $N-2$ 项 **0 次重渲**   | 悬停重渲染开销从 $O(N)$ 降为严格 **$O(1)$**       |
| **消息快照内存预算**       | 账本漏算 100~1000 倍，名义 5MB 实质占用 50MB+             | 真实全量消息字节核算，5MB 软硬预算刚性拦截              | 内存账本绝对保真，杜绝单会话快照膨胀              |
| **会话软逐出与硬删除闭环** | 软逐出漏清重资产，硬删除 12 处 Map/Set 与 PTY 孤儿化      | `SessionLifecycleBus` 单真理源驱动，100% 级联归零       | 会话切换与删除后内存实现 **零悬垂残留**           |
| **主线程存储 I/O 阻塞**    | 流式帧 ~31Hz 同步 `JSON.stringify` + `localStorage`       | 顶层浅等比较短路 + 250ms 尾随防抖，流式期 **0 次写盘**  | 消除主线程同步 IPC 阻塞，流式输出跟手率 100%      |

### 1.3 48 项全景问题对齐矩阵与拓扑归类

本方案严格落实反退避与问题同权纪律，对 Part 08 的 26 项问题与 Part 09 的 22 项问题逐一建档，形成 7 大治理集群：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      48 项性能与生命周期缺陷全景治理拓扑矩阵                           │
├────────────────────────────────┬───────────────────────────────────────────────────────┤
│ 集群 A：CSS 渲染引擎与排版管线 │ PERF-UI-01, PERF-UI-02, PERF-UI-03, PERF-UI-04        │
│ 集群 B：CSS 布局抖动与合成层   │ PERF-UI-05, PERF-UI-06, PERF-UI-07                    │
│ 集群 C：浮层与几何瞄准调度中枢 │ PERF-UI-08, PERF-UI-09, PERF-UI-10, PERF-UI-11,       │
│                                │ PERF-UI-12, PERF-UI-13, PERF-UI-14, PERF-UI-15        │
│ 集群 D：原子组件与列表交互体系 │ PERF-UI-16, PERF-UI-17, PERF-UI-18, PERF-UI-19,       │
│                                │ PERF-UI-20, PERF-UI-21, PERF-UI-22, PERF-UI-23,       │
│                                │ PERF-UI-24, PERF-UI-25, PERF-UI-26                    │
│ 集群 E：会话逐出与生命周期总线 │ F-09-01, F-09-02, F-09-03, F-09-04, F-09-05, F-09-06  │
│ 集群 F：系统资源、PTY 与异步桥 │ F-09-07, F-09-08, F-09-12, F-09-13, F-09-14,          │
│                                │ F-09-18, F-09-19                                      │
│ 集群 G：缓存有界化与存储防抖   │ F-09-09, F-09-10, F-09-11, F-09-15, F-09-20,          │
│                                │ F-09-21, F-09-22                                      │
│ ★ 核心交叉子域（C & E & F）   │ PERF-UI-14 + F-09-16 (Detached DOM 泄漏与 WeakRef 解耦)│
└────────────────────────────────┴───────────────────────────────────────────────────────┘
```

### 1.4 系统架构全景演进图 (Architecture Evolution)

#### 重构前：多头分裂、无界驻留与全树扫描的混乱架构

```
[ 用户操作 / 流式 Token 到达 ]
       │
       ├──> CSS 解析: [class*='...'] 全树子串搜索 + body * 强制重算 (Recalculate Style 25ms)
       ├──> CSS 动画: transition: width/height/all 每帧触发 Main-Thread Layout Thrashing
       ├──> will-change / blur: 100+ 常驻合成层，滚动层持续 GPU Backdrop Readback 掉帧
       │
       ├──> 输入事件 (Key/Pointer): window + document 双重捕获监听 (无空栈短路)
       │       └──> LayerStackManager 强引用 target / anchorNode ──> [Detached DOM 无法释放]
       │
       ├──> 浮层开关: FocusTrapIsolationManager 对 #root 执行深度 querySelector 全树扫描
       ├──> Tooltip: 每次滚动无视 activeId 浅拷贝全表广播 + 60fps rAF 轮询 getBoundingClientRect
       ├──> Select/Combobox: 展开触发 O(N^2) setItems 更新，悬停使 Context 级联刷新整棵树
       │
       ├──> 会话软逐出: 仅清空 sess.messages=[]，MessageSnapshots (漏算全量) 与 Diff/附件常驻
       ├──> 会话硬删除: 侧栏右键直调 deleteSession 绕过协调器，12 个模块级 Map/Set 永久泄漏
       ├──> 终端关闭: 仅删前端状态，漏杀衍生 PTY 进程与 512KB 缓冲；门闩无限 push
       ├──> 定时器: timer-fired 误用 .add()，activeTimerIds 集合单调递增永远不归零
       └──> 数据持久化: ~31Hz 流式帧同步 JSON.stringify + localStorage.setItem 造成主线程卡顿
```

#### 重构后：单真理源总线、零 DOM 数学引擎与 GPU 合成闭环的高性能架构

```
[ 用户操作 / 流式 Token 到达 ]
       │
       ├──> CSS 规则: 精确 class 哈希桶 + text-rendering: auto + :focus-within (Style Recalc < 1ms)
       ├──> CSS 动画: 100% 卸载至 Compositor (transform: translate3d/scaleX + opacity)
       ├──> 合成与隔离: 按需激活 will-change + 滚动视口/浮层 contain: layout style paint 隔离
       │
       ├──> 输入事件: 仅 window 挂载，0 浮层时 0 监听器；空栈 O(1) 立即短路
       │       └──> LayerStackManager 使用 WeakRef<Node> + 100ms 自动脱钩 ──> [Detached DOM 立即回收]
       │
       ├──> 浮层开关: FocusTrap 直接子节点白名单判定 + checkVisibility() 原生 C++ 快速检测
       ├──> Tooltip: Active/Pending 槽位化，无激活态立即 return；废除 rAF 轮询，纯被动感知
       ├──> Select/Combobox: 可变 Map + 微任务合并挂载；拆分 HighlightStore，悬停 O(1) 局部刷新
       │
       ├──> 会话软逐出: 触发 onSoftEvict ──> 清空快照栈 + 压缩 RuntimeRegistry Diff/附件 + 截断高度表
       ├──> 会话硬删除: SessionLifecycleBus 广播 ──> 12 处 Map/Set 级联自注销 + 前缀匹配杀 Rust PTY
       ├──> 终端生命周期: takeAllForSession 批量 kill + PtyWriteGate 512KB 环形覆盖
       ├──> 定时器安全: onTimerFired 执行 .delete()，activeTimerIds 严格受控
       └──> 数据持久化: withPersist 顶层浅等比较短路 + 250ms 尾随防抖，流式帧 0 次同步 I/O
```

---

## 二、Part 08：UI 原子组件、浮层调度与 CSS 渲染合成重构方案

---

### 2.1 全局 CSS 选择器哈希命中与排版管线重构 (PERF-UI-01 ~ PERF-UI-04)

#### 1. 架构瓶颈定位与 Blink 内部原语分析

- **`[class*='...']` 子串匹配瓶颈（PERF-UI-01）**：Chromium Blink 的 `RuleSet` 将 CSS 规则按右端选择器归入不同哈希桶。类名选择器进入 `class_rules_`（$O(1)$ 哈希命中），而子串选择器 `[class*='...']` 退化落入 `attr_rules_` 的 `"class"` 通用属性桶。由于 React 渲染的绝大多数 DOM 节点均携带 `class` 属性，样式重算时 `ElementRuleCollector` 必须遍历所有 `[class*='...']` 规则并对节点 `className` 执行 `String::Find`，引发 $O(N \times M)$ 复杂度退化。
- **伪元素前置空格陷阱（PERF-UI-02）**：`overlay-scrollbar.css` 中 `[class*='coverContent'] ::-webkit-scrollbar` 前置空格将其转化为**后代通配伪元素**（即 `[class*='coverContent'] *::-webkit-scrollbar`），迫使页面上任意可滚动容器的滚动条在解析时沿 DOM 树逐层向上回溯祖先链。
- **排版管线阻塞（PERF-UI-03）**：在 `html, body` 全局声明 `text-rendering: optimizeLegibility` 与 `font-feature-settings: 'kern' 1, 'liga' 1`，将包含高频流式输出（~31Hz）、终端日志、大 Diff 视图的全应用文本强行推入 HarfBuzz 复杂文本整形慢路径，禁用字形宽度快速缓存。
- **样式失效破坏（PERF-UI-04）**：`body.leaf-dock-resizing *` 在拖拽分栏起止瞬间引发全树 `SubtreeStyleChange`；`Button.module.css` 与 `DiffCard.module.css` 滥用 `:has(...)` 触发向上关系回溯。

#### 2. 精准工程改造规范

1. **彻底消除 `[class*='...']`**：
   - 在 `src/styles/overlay-scrollbar.css` 中废除全部 20+ 个子串选择器，仅保留 `.custom-scrollbar` 精确类名与 `[data-scrollbar='thin']`、`[data-scrollbar='overlay']` 精确数据属性选择器；
   - 在 `src/styles/focus-visible.css`、`shell-reset.css`、`reduced-motion.css` 中，将 `[class*='modalBackdrop']` 等替换为精确的 `[data-slot="backdrop"]`、`[data-resizer="true"]`、`[data-motion="skeleton"]`；
   - 在 `ComposerFusedTrigger.module.css` 中通过组件显式传递类名或样式变量替代 `[class*="badgeContainer"]`。
2. **规范滚动条伪元素后代关系**：
   - 移除 `::-webkit-scrollbar*` 前的一切空格，选择器收敛为 `.custom-scrollbar::-webkit-scrollbar-thumb`。
3. **排版引擎分级优化**：
   - `html` 与 `body` 根节点重置为 `text-rendering: auto`；移除 `body` 上的强制 `font-feature-settings: 'kern' 1, 'liga' 1`，恢复默认 `font-kerning: normal`；
   - 仅对 `h1`~`h3` 标题及特定展示型大字号组件按需启用 `text-rendering: optimizeLegibility`。
4. **局部化样式失效边界与替换 `:has(...)`**：
   - 移除 `body.leaf-dock-resizing *`，改为在 `body.leaf-dock-resizing` 自身声明光标，并通过工作区遮罩层（Overlay Mask）捕获指针，实现 $O(1)$ 样式生效；
   - `Button.tsx` 依据 `loading`、`icon`、`iconPosition` 在 TSX 阶段直接输出 `.buttonWithLeftIcon` / `.buttonWithRightIcon`，删除 `Button.module.css` 中的双重链式 `:has()`；
   - `DiffCard.module.css` 将 `:has(:focus-visible)` 替换为原生 `:focus-within`。

---

### 2.2 CSS 布局抖动清退、合成层收敛与 Containment 隔离边界 (PERF-UI-05 ~ PERF-UI-07)

#### 1. 架构瓶颈定位

- **非合成几何属性过渡（PERF-UI-05）**：`Tabs`、`SegmentedControl`、`Switch`、`Slider`、`BinaryTreeWorkspace` 以及 14 处 `transition: all`，在过渡期间驱动 `width`、`height`、`flex-grow`、`padding`，使浏览器在 250ms 过渡窗口内（连续 30 帧）每帧执行 `Recalculate Style` → `Layout` → `Paint` 主线程完整流水线。
- **合成层爆炸与 GPU Readback 瓶颈（PERF-UI-06）**：常驻静态节点声明 `will-change: transform, width, height` 生成数百个独立 `cc::PictureLayer`；高频滚动视口（`ChatViewport`、`ChatComposer`）上方覆盖 `backdrop-filter: blur(10px)`，每帧滚动强制 GPU 执行 Backdrop Readback 纹理拷贝与双 pass 高斯模糊，造成 GPU 填充率过载。
- **缺失 Containment 边界（PERF-UI-07）**：定高视口与独立浮层未声明 CSS Containment，子项文本变更与布局重算向上击穿至整树根节点。

#### 2. 精准工程改造规范

1. **滑块与进度条 100% 合成器动画化**：
   - **`Slider` 进度条**：将 `style={{ width: `${percentage}%` }}` 改为 `width: 100%; transform-origin: left center; transform: scaleX(${percentage / 100}); transition: transform var(--transition-micro);`；
   - **`Tabs` / `SegmentedControl` 指示器**：指示器滑块宽度通过精确属性赋予，位移过渡严格收敛为 `transform: translate3d(var(--slider-x), 0, 0)` 与 `opacity`，彻底移除 `transition: width, height`；
   - **清退 `transition: all`**：全仓 14 处模块样式表显式枚举过渡属性（`background-color`, `border-color`, `color`, `opacity`, `transform`）。
2. **合成层按需激活与滚动期毛玻璃降级**：
   - 移除静态静止态节点上的所有 `will-change`；仅在交互激活态（如 `.dragging`、`.active`）按需注入；彻底删除所有 `will-change: width / height / background-color` 等非合成属性声明；
   - 对悬浮于滚动视口上方的浮层，在滚动进行时（`[data-scrolling='true']`）或节能模式下关闭 `backdrop-filter`，改用实色/轻微混合透明背景 `color-mix(in srgb, var(--bg-elevated) 96%, transparent)`。
3. **建立多层 CSS Containment 隔离**：
   - 在 `ScrollArea.module.css` 的 `.viewport` 上注入 `contain: layout style paint;`；
   - 在 `Menu.module.css`、`SelectContent.module.css`、`SmartExpandablePanel.module.css` 浮层容器上注入 `contain: layout style paint;`；
   - 在 Markdown `.md-code-block` 与 `.md-table-wrapper` 上注入 `contain: content;`。

---

### 2.3 全局浮层调度中枢 LayerStackManager 深度优化 (PERF-UI-14)

#### 1. 架构瓶颈定位

- **双重捕获监听**：`LayerStackManager` 在构造及注册时对 `window` 与 `document` 分别绑定 `keydown`、`pointerdown`、`pointerup`（共 6 个全局捕获监听器），导致单次按键或点击连续触发两遍处理器。
- **空栈缺乏快速短路**：当图层栈为空（`this.layers.length === 0`）时，`handleGlobalPointerDown` 仍执行 `PROCESSED_EVENTS.add`、`performance.now()`、空数组分配；`handleGlobalPointerUp` 更是无条件执行。
- **退栈重复 Trace 与根属性频繁颠簸**：`dismissLayer` 先调一次 `recordTrace`，随后的 `unregister` 又调一次 `recordTrace`；关闭多层时反复写入 `document.body` 的 `data-floating-active` 属性。

#### 2. 精准工程改造规范

1. **单一宿主绑定与零开销按需挂载**：
   - 移除 `document` 上的重复事件监听，全局仅在 `window` 上以捕获阶段监听；
   - 引入动态生命周期：默认不挂载监听；仅当 `this.layers.length` 从 0 增至 1 时调用 `attachGlobalListeners()`，当图层全部退栈归 0 时调用 `detachGlobalListeners()`，实现**无浮层时全系统 0 全局监听器**。
2. **快速短路守卫**：
   - `handleGlobalPointerDown`、`handleGlobalPointerUp` 与 `handleGlobalKeyDown` 均在第一行硬性断言 `if (this.layers.length === 0) return;`。
3. **退栈逻辑净收敛**：
   - 移除 `dismissLayer` 中的冗余 `this.recordTrace`，统一收口至 `unregister` 记录；
   - 在级联退栈多层时，批量移除完成后仅触发一次 `updateFloatingActiveState()`。

---

### 2.4 弹窗焦点圈定管理器 FocusTrap 架构重构 (PERF-UI-15)

#### 1. 架构瓶颈定位

- **全树深度扫描**：`FocusTrapIsolationManager.isWhitelisted` 对 `document.body.children` 每一个顶级节点（包含 `#root`）执行深度 `node.querySelector('[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-floating-layer]')`。在包含数千节点的复杂应用中，弹窗开关会造成主应用全树深度遍历。
- **隔离失效严重 Bug**：若主界面 `#root` 内部存在任意一个内联 `role="listbox"`，`#root.querySelector(...)` 返回非空，导致 `#root` 被错误放行白名单，背景页面未能正确施加 `inert` 隔离。
- **`getComputedStyle` 循环性能开销**：在弹窗挂载和每一次 `Tab` 键循环时，对容器内所有可聚焦元素逐一调用 `getComputedStyle(el)` 读取 `display` 与 `visibility`。

#### 2. 精准工程改造规范

1. **`#root` 硬阻断与直接子级白名单检测**：
   - 在 `isWhitelisted(node)` 中显式增加顶层根节点守卫：`if (node.id === 'root') return false;`；
   - 对于浮层 Portal 容器，仅检测 `node` 自身属性或其直接子级（`:scope > [data-floating-layer]`），时间复杂度从 $O(\text{全树节点数})$ 降至严格 **$O(1)$**。
2. **Chromium 原生 `checkVisibility()` 快速可见性判定**：
   - 重构 `getFocusableElements`：优先使用原生 C++ 快速方法 `typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) : ...`，避免为每个元素在 JS 堆中构建庞大的 `CSSStyleDeclaration` 对象。

---

### 2.5 Tooltip 全局中枢与实例栈轻量化 (PERF-UI-08 ~ PERF-UI-10)

#### 1. 架构瓶颈定位

- **全表广播与 DOM 清理风暴（PERF-UI-08）**：全应用常驻挂载 80~300 个 `<Tooltip>` 实例。`tooltipController` 在全局 `scroll`、`pointerdown`、`click` 中仅检查 `registry.size > 0`（恒为真），无条件遍历全量实例触发数以百计的 `setState`，并执行 `document.body.querySelectorAll('[data-tooltip-portal="true"]')` 全树扫描。
- **可见期 60~120fps rAF 死循环（PERF-UI-09）**：浮层打开期间启动永不休眠的 rAF 循环，每帧执行 `matches(':hover')` 与 `getBoundingClientRect()` 造成同步回流。
- **实例 Fiber 与 Hook 膨胀（PERF-UI-10）**：单实例包含 5 State + 8 Ref + 6 Effect；JSX `content` 引用抖动频繁触发 Effect；`React.cloneElement` 每次内联创建 4 个闭包。

#### 2. 精准工程改造规范

1. **`tooltipController` 单例活动槽位与 $O(1)$ 快速短路**：
   - 维护 `activeId: string | null` 与 `pendingIds: Set<string>`；
   - 每次全局 `scroll` / `pointerdown` / `click` 触发时，若 `activeId === null && pendingIds.size === 0`，**直接 $O(1)$ 立即返回**；
   - 若存在激活或等待项，仅精确定向关闭 `registry.get(activeId)` 与取消 `pendingIds`，执行复杂度严格控制在 $O(1)$；
   - `Tooltip.tsx` 的 `hideImmediate` 增加 `if (!visibleRef.current) return;` 幂等守卫。
2. **拔除 rAF 轮询，改用被动事件与 ResizeObserver**：
   - 彻底删除 `requestAnimationFrame(checkLiveness)` 轮询机制；
   - 悬停离开判定交由现有的 `onMouseLeave` + 全局被动 `pointermove`；
   - 目标元素尺寸归零或卸载判定交由统一的 `ResizeObserverManager` 异步回调，实现静止态 **0 CPU 唤醒、0 回流**。
3. **Hook 栈与记忆化精简**：
   - 将 `isEmptyContent = content === null || content === undefined || content === ''` 抽取为布尔依赖，消除 JSX 元素引用抖动；
   - 闭合态实例无需挂载全局监听，仅在悬停展示时注册；
   - 使用稳定回调包裹注入子组件的事件处理函数。

---

### 2.6 安全瞄准引擎（Safe-Aim）三合一收敛与零 DOM 纯数学化 (PERF-UI-11 ~ PERF-UI-13)

#### 1. 架构瓶颈定位

- **闭合期泄漏与非 Debug 态 DOM 污染（PERF-UI-11）**：`SmartExpandablePanel` 挂载（即使 `isOpen=false`）及 `SafeTriangle.reset()` 时调用 `SafeAimEngine.getInstance()`，构造函数向 `document.body` 插入 `100vw × 100vh` 的全屏 `<svg>` 并永久绑定 `window` `mousemove`；每次移动频繁执行数组移位与 `removeAttribute('points')`；子菜单激活时重复两次 `getBoundingClientRect()`。
- **三套实现并存与 Hook 泄漏（PERF-UI-12）**：`internal/SafeAimEngine.ts`、`internal/SafeTriangle.ts` 与 `SmartPanel/hooks/useSafeAim.ts` 冗余共存；`useSafeAim` 无视 `open` 为每个实例挂载独立全屏 `<svg>` 与 `mousemove` 监听，且 `setSubmenu` 未接线导致死算。
- **`PreviewCard` 挂载期强制回流（PERF-UI-13）**：闭合挂载时在 `useLayoutEffect` 中调用 `getBoundingClientRect()` 触发二次 Commit，Context 未用 `useMemo` 缓存。

#### 2. 精准工程改造规范

1. **三套算法合并为单一无 DOM 纯数学引擎（Single Source of Truth）**：
   - 物理废除 `SmartPanel/hooks/useSafeAim.ts`；
   - 重构 `SafeAimEngine`：在非调试模式（`debug: false`）下**绝对不向 DOM 注入任何 `<svg>` 或 `<polygon>` 节点**；
   - 所有的亚马逊安全三角判定均在纯内存向量空间中以 $O(1)$ 几何射线法/面积法完成。
2. **事件监听全生命周期按需绑定**：
   - `SafeAimEngine` 构造函数不绑定任何全局事件；
   - 仅当真正存在激活子菜单且 `setSubmenu(submenuEl)` 被调用时才临时绑定 `window` `mousemove`；子菜单关闭（`clearSubmenu()`）时**立即彻底解绑**，鼠标历史数组立即置空。
3. **`PreviewCard` 挂载测量消除**：
   - 删除 `PreviewCardTrigger` 挂载期的 `useLayoutEffect` 同步测量；仅在真正触发悬停打开时按需读取几何尺寸；
   - 对 `<PreviewCard>` 的 `contextValue` 实施 `useMemo` 包裹。

---

### 2.7 复合选择器 Select / Combobox 架构级重构 (PERF-UI-20 ~ PERF-UI-21)

#### 1. 架构瓶颈定位

- **$O(N^2)$ 挂载注册风暴**：`SelectContent` 展开时，$N$ 个 `<SelectItem>`（或 `<ComboboxItem>`）挂载，各自通过 `useEffect` 调用 `registerItem`。每一个注册都执行 `setItems((prev) => [...prev.filter(...), next].map(...))`，形成 $\sum_{k=1}^N 3k = O(N^2)$ 的数组分配与状态更新风暴；关闭时又发生 $O(N^2)$ 卸载过滤。
- **渲染期 $O(N^2)$ 查找**：渲染时每个 Item 均执行 `ctx.items.findIndex((i) => i.id === itemId)`。
- **单 Context 导致全量重渲染**：高频瞬态 `highlightedIndex` 与稳定配置打包在同一个 Context 中。鼠标划过单个选项触发 `setHighlightedIndex`，导致整棵下拉树（含 Trigger、Content 与全部 Item）全量重渲染。
- **高亮正则重复编译（PERF-UI-21）**：`ComboboxItem` 未用 `useMemo` 缓存高亮内容，每次悬停重渲染为每项新建 2 个 `RegExp` 实例；`useFloatingPosition` 存在打开双阶段 Commit 且 `--anchor-width` 存在「先读后写」测量失准。

#### 2. 精准工程改造规范

1. **可变索引引用 + Microtask 批量合并消除挂载风暴**：
   - 废除子项挂载时高频触发的 `items` React State；
   - 选项数据由 `itemsRef = useRef<RegisteredItemData[]>([])` 与快速索引表 `idToIndexMapRef = useRef<Map<string, number>>(new Map())` 承载；
   - 子项通过 `ctx.getItemIndex(itemId)` 以 **$O(1)$** 复杂度直接读取下标，彻底根除 $O(N^2)$ 的 `findIndex`；
   - 若子项数量发生动态增减，通过微任务（`queueMicrotask`）进行批量防抖合并，单次展开仅触发最多 1 次结构更新。
2. **拆分轻量级高亮状态订阅（HighlightStore）**：
   - 采用外部轻量订阅模型：将 `highlightedIndex` 移出主 Context，建立独立的轻量 Store（或使用 `useSyncExternalStore`）；
   - 每个 `<SelectItem>` 仅订阅自身的聚焦状态：`useSyncExternalStore(store.subscribe, () => store.getHighlightedIndex() === myIndex)`；
   - 鼠标滑过选项时，**仅有旧高亮项与新高亮项共 2 个组件重新渲染（严格 $O(1)$）**，其余全部 $N-2$ 个选项与 Trigger 完全零渲染！
3. **正则优化与浮层定位顺序纠正**：
   - `ComboboxItem` 的 `content` 使用 `useMemo` 包裹；
   - `comboboxHighlight.tsx` 移除冗余的 `testRegex`，利用 `split(RegExp)` 的奇数下标特性 $O(1)$ 判定命中分段；
   - `useFloatingPosition.ts` 调整执行顺序：先读取 Trigger 宽度并立即设置 `--anchor-width`，随后再测量 Content 宽度，消除双 Commit 与布局失准。

---

### 2.8 菜单键盘导航、面板定位与原子控件精细化重构 (PERF-UI-16 ~ PERF-UI-19, PERF-UI-22 ~ PERF-UI-26)

#### 1. 架构瓶颈定位与工程改造规范

| 编号           | 核心瓶颈定位                                                                                               | 精准改造规范与算法演进                                                                                                        |
| :------------- | :--------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| **PERF-UI-16** | `Menu` 鼠标划过触发 `setFocusedIndex` 全表重渲 + `querySelectorAll` + `.focus()` + 强制 `scrollIntoView()` | 引入 `focusSourceRef: 'keyboard' \| 'pointer'`：鼠标划过时不执行 `scrollIntoView`；使用 `itemRefs.current[idx]` 替代 DOM 查询 |
| **PERF-UI-17** | `menuKeyNavigation.ts` 在校验按键前无条件遍历子项读取 `offsetParent` 与 `getComputedStyle`                 | 按键白名单（`ArrowDown/Up/Enter/Escape` 等）前置首行守卫，非导航按键 $O(1)$ 立即短路                                          |
| **PERF-UI-18** | `PositionEngine.measureNaturalHeight` 采用「写样式 → 读几何 → 写样式 → 读几何」触发双重同步回流            | 移除向 `listEl.style` 写入 `maxHeight/overflow` 的逻辑，直接连续读取 `scrollHeight` 与 `offsetHeight`（纯连续读，0 回流）     |
| **PERF-UI-19** | `MenuAdapter` / `SelectAdapter` 执行死代码 `_smartItems` 分配，内联 `options.map` 击穿 `React.memo`        | 物理删除未使用的 `_smartItems` 死代码；移除 `SelectAdapter` 传给 `MenuAdapter` 的冗余 `options` 属性                          |
| **PERF-UI-22** | `ScrollArea` 在非对应 `type` 下触发 `isScrolling`/`isHovered` 重渲；`metrics.scrollTop` 状态失步           | 严格依据 `type === 'scroll'` 或 `type === 'hover'` 分流状态派发；使用 `metricsRef` 保证 `getMetrics()` 始终返回最新同步值     |
| **PERF-UI-23** | `CopyIcon` 挂载完整 Framer Motion 运行时与 4 个 `VisualElement`；`AppIcon` 双层内联对象分配                | `CopyIcon` 静态变量模块级提升，去除无动画的包装层；`AppIcon` 静态样式使用冻结常量复用引用                                     |
| **PERF-UI-24** | `SegmentedControl` 在 `useEffect` 测量 DOM 造成首帧闪烁与二次 Commit；`Tabs` 查询 DOM 忽略 Map             | `SegmentedControl` 改用 `useLayoutEffect` 实现绘制前同步测量；`Tabs` 优先读取 `triggerMapRef.current.get(value)`              |
| **PERF-UI-25** | `Slider` 拖拽期（120~1000Hz）每帧调用 `getBoundingClientRect()` 且与 CSS `transition: width` 冲突          | `PointerDown` 时单次缓存 `dragRectRef`，拖拽期 0 次测量；拖拽时禁用过渡，进度条改为 GPU `scaleX` 变换                         |
| **PERF-UI-26** | `SmartModelBadge` 在 `inline-flex` 启用 `container-type: inline-size` 导致尺寸折叠与 3 倍文本 DOM          | 容器查询宿主移至外层确定宽度槽位；固定槽位传入 `forceTier`，避免生成 3 份冗余 `<span>` 节点                                   |

---

## 三、Part 09：前端内存泄漏、资源驻留与生命周期重构方案

---

### 3.1 会话软逐出（Soft Eviction）与消息撤销快照真实账本 (F-09-01, F-09-03)

#### 1. 架构瓶颈定位与泄漏推导

- **账本失真与软逐出失效（F-09-01）**：`MessageSnapshots.ts` 中，`estimateBytes` 仅统计了增量 `delta.inserted` 的消息文本长度（约 1KB），而 `SnapshotEntry` 结构体却强行存入了 `messages: messages.slice()`（变更前的全量消息列表，400 条消息可达 2MB）。当单栈深度达到 10 层时，实际物理驻留达 **20MB+**，而 `this.totalBytes` 账本记录却仅有 **10KB**，使 `MAX_MEMORY_BYTES = 5MB` 的全局 LRU 预算彻底沦为摆设。更严重的是，当会话被软逐出（`sess.messages = []`）时，`MessageSnapshots` 未被清理，强引用着这批全量消息，使 GC 无法回收。
- **软逐出重资产遗留（F-09-03）**：`evictSessionMessagesInState` 仅清空了 `sess.messages = []`，但会话附属的 `SessionRuntimeRegistry` 中的 `diffFiles`（数千行代码 Diff）、base64 `attachments` 以及 `chatScrollRegistry` 中庞大的 `heightSnapshot` 完全未清理。

#### 2. 精准工程改造规范

1. **快照存储纯 Delta 架构演进与真实字节核算**：
   - 彻底废除 `SnapshotEntry` 中持有的全量 `messages: SessionMessage[]` 副本；
   - 恢复操作改为**纯逆向补丁应用机制（Reverse Delta Application）**：仅存储被删除/替换的切片（`deleted` 列表）以及覆盖的区间元数据；
   - 在过度阶段（若保留快照数组），`estimateBytes` 必须如实累加全量 `messages` 的深层对象大小，确保 5MB 预算刚性执行。
2. **软逐出联动清理钩子（`onSoftEvict`）**：
   - 会话软逐出执行时，自动触发：
     1. 调用 `messageSnapshots.clear(sessionId)` 释放撤销快照栈；
     2. 调用 `sessionRuntimeRegistry.shrinkOnEvict(sessionId)`：清空 `diffFiles = []`，释放已发送附件的 base64 `dataUrl`；
     3. 调用 `chatScrollRegistry.trimHeightsOnEvict(sessionId)`：仅保留 `scrollTop` 与 `wasAtBottom` 锚点，清理全量 `messageId -> height` 映射。

---

### 3.2 会话逐出状态机单轨收敛与访问序维护 (F-09-02)

#### 1. 架构瓶颈定位

- 仓内并存两套互相冲突的会话逐出逻辑：
  - `sessionEviction.ts`：现代三态 LRU 状态机（区分 `PinnedActive` / `OpenRetained` / `EvictableCandidate`，感知分屏与流式状态）；
  - `sessionMessageEviction.ts` / `sessionMessageEvict.ts`：旧版朴素数组切片实现，完全忽略分屏右侧打开的会话（造成分屏会话正文被误清空为 `[]`），且无视 LRU 访问时序。
- `sessionEvictionProbes.ts:85` 的 `sessionAccessTimestamps` 模块级 Map 永久累积所有访问过的会话 ID，全仓无生产删除入口。

#### 2. 精准工程改造规范

1. **全系统单一真理源（SSOT）收敛**：
   - 物理废除 `sessionMessageEviction.ts`；
   - 将 `api/session-persistence/sessionMessageEvict.ts` 重构为直接调用 `sessionEviction.ts` 的 `evaluateSessionEviction` 状态机；
   - 所有软逐出决策严格遵循三态优先级：正在推流/活跃选中（`PinnedActive`，绝对保活） > 分屏展示/标签打开（`OpenRetained`，高优保活） > 后台历史（`EvictableCandidate`，按 LRU 时间戳逐出）。
2. **访问时间戳生命周期闭环**：
   - 在 `sessionEvictionProbes.ts` 中导出 `deleteSessionAccessTimestamp(sessionId: string): void`，接入会话删除总线。

---

### 3.3 统一会话生命周期清理总线（SessionLifecycleBus）与 12 处容器收口 (F-09-04, F-09-05)

#### 1. 架构瓶颈定位

- **调用入口分裂与级联旁路**：`useSidebarContextMenu.ts:205` 与 `workspaceShellStore.ts:357` 直接调用 `deleteSession(id)`，绕过了 `SessionCoordinator.deleteSessionCascade`，导致 Tab 关闭、运行时状态清理与工作流签名清理被跳过。
- **12 个模块级容器孤儿化**：即使经过 `SessionCoordinator`，全仓仍有 12 个分散的模块级 `Map`/`Set` 容器（含草稿管理器、水合令牌、指纹缓存、流式渲染缓冲等）未被清理。
- **草稿管理器 Bug（F-09-05）**：`SessionDraftManager` 无删除会话方法；切后台触发 `flushAll()` 时，遍历全量 `this.drafts` 将已被删除会话的草稿重新写回 Store 与 `localStorage`，造成「幽灵会话草稿复活」；全局单槽 `pendingSave` 在分屏多会话并发输入时互相覆盖防抖。

#### 2. 精准工程改造规范

1. **建立中心化会话生命周期总线（`SessionLifecycleBus`）**：
   - 底层由 `sessionCrudActions.ts` 的 `deleteSession` 原子触发广播，确保无论从 UI 任何入口触发删除，级联清理 **100% 触发**。
2. **12 处模块级驻留点注销全景**：
   - `sessionAccessTimestamps.delete(sid)`；
   - `sessionHydrateTokens.delete(sid)` 与 `inFlightHydrations.delete(sid)`；
   - `lastSavedBodyFingerprint.delete(sid)`；
   - `lastRecordedSignaturesBySession.delete(sid)` 连同 `localStorage.removeItem(`crish_pending_context_state_v1:${sid}`)`；
   - `attemptedSessionIds.delete(sid)`；
   - `slashSendDraftManager.clear(sid)`；
   - `sessionDraftManager.deleteSession(sid)`；
   - `sessionStreamManager.clearSession(sid)`（取消未结流式定时器）；
   - `sharedSessionStreamManager.clearSession(sid)`；
   - `chatScrollRegistry.clear(sid)` 与 `clearSessionLive(sid)`；
   - `messageSnapshotsBridge.unregisterActiveVsm(sid)`；
   - `sessionRuntimeStatusStore.clearRuntimeStatus(sid)` 与 `clearWorkflowConfirmSignaturesForSession(sid)`。
3. **`SessionDraftManager` 修复**：
   - 增加 `deleteSession(sessionId)` 方法；
   - 将 `pendingSave` 重构为 `pendingSaves = new Map<string, string>()`，分会话独立维护防抖定时器，消除并发覆盖；
   - `flushAll()` 仅刷新脏数据 Map 中的条目。

---

### 3.4 运行时会话注册表（SessionRuntimeRegistry）GC 激活与容量保护 (F-09-06)

#### 1. 架构瓶颈定位

- 生产环境全仓从未调用 `startGC()`，垃圾回收定时器从未运转；
- 满容量（50 会话）时，`get()` 盲目弹出 `this.accessOrder.pop()` 并删除，不检查目标是否正在推流（`refCount > 0`）或是否为当前活跃会话；
- 定时回收方法 `_collectGarbage` 仅扫描超时未释放的 `retainTimestamps`，从不清理 `refCount === 0` 的非活跃会话。

#### 2. 精准工程改造规范

1. **在 `bootstrapServices` 中启动 GC 定时器**：注册 60s 周期性 GC 任务。
2. **重构容量淘汰与垃圾回收算法**：
   - `get()` 满额淘汰守卫：从 `accessOrder` 尾部逆序寻找第一个 `refCount === 0 && id !== activeId && !openSessionIds.has(id)` 的条目进行淘汰，严禁误杀活跃/推流会话；
   - 统一 GC 逻辑：首先回收超时（>30 分钟）僵尸锁，随后安全回收 `refCount === 0` 且未在分屏展示的闲置会话。

---

### 3.5 终端子进程（PTY）生命周期闭环与隐藏门闩有界化 (F-09-07, F-09-08, F-09-18)

#### 1. 架构瓶颈定位

- **衍生终端与分屏终端漏杀（F-09-07）**：多终端生成键为 `${sid}:terminal:N`，分屏终端生成键为 `${sessionKey}:split-2`。`killPtyForSession` 仅按精确 `sid` 查找，所有带前缀的衍生终端完全被遗漏；且从侧栏删除会话时调用的 `dropTerminalForSession` 根本不杀 PTY，导致底层 Rust PowerShell/bash 进程与 512KB/终端缓冲永久泄漏。
- **隐藏终端门闩无界膨胀（F-09-08）**：`createPtyWriteGate` 的 `pending: string[]` 在终端非激活期间无上限 `push`，持续输出 20MB 后，切回瞬间 `pending.join('')` 卡死主线程数秒。
- **WebGL 定时器泄漏（F-09-18）**：`useXtermTerminal.ts` 中 WebGL 上下文恢复定时器未记录句柄，卸载未清理。

#### 2. 精准工程改造规范

1. **`PtyRegistry` 前缀通配与批量杀死**：
   - 新增 `takeAllForSession(sessionId: string): string[]`，使用前缀匹配 `key === sid || key.startsWith(`${sid}:`)` 提取全部关联 `ptyId`；
   - `killPtyForSession` 遍历所有匹配的 `ptyId`，逐一调用 `clearPtyHistory(pid)` 并发送 IPC `workbench_pty_kill`；
   - 在 `dropTerminalForSession` 与生命周期总线中显式接入 `void killPtyForSession(sessionId)`。
2. **`PtyWriteGate` 512KB 环形缓冲容量截断**：
   - 引入字符总数上限 `MAX_PENDING_CHARS = 512 * 1024`（与 PTY 历史缓冲对齐）；超限时从 `pending` 头部弹出老 chunk，确保切回激活态时 `term.write(merged)` 耗时恒 $\le 8\text{ms}$。
3. **WebGL 恢复定时器句柄保存**：
   - 保存 `webglRestoreTimer` 并在 `useEffect` cleanup 中调用 `clearTimeout`。

---

### 3.6 模块级无界集合治理与定时器 Bug 修复 (F-09-09, F-09-11)

#### 1. 架构瓶颈定位与工程改造规范

| 编号        | 核心瓶颈定位                                                                                                         | 精准改造规范与算法演进                                                                                           |
| :---------- | :------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| **F-09-09** | `taskEventHandlers.ts` `onTimerFired` 误将 `e.timerId` 执行 `activeTimerIds.add()`，终态定时器永久残留，计数单调递增 | 修复为 `activeTimerIds.delete(e.timerId)`；与 `onTimerCancelled` 语义对称对齐                                    |
| **F-09-10** | `coldWarnedRunIds`、`FAVICON_MAP`、`warnedMessageIds`、`fileViewerModeOverrides` 无上限                              | 替换为容量 256/128 的 `LruCache` 或带上限淘汰的 Set；热激活 Tab 同步调用 `consumeFileViewerModeOverride`         |
| **F-09-11** | `timelineCache` (4096) 与 `markdownRenderLite` (64) 整表 `.clear()` 断崖式清空，造成视口内高频命中瞬间丢失与重算尖峰 | 改造为平滑 LRU 逐项淘汰（复用 `@crish/shared-utils` 的 `LruCache` 或 Map 头部淘汰），将重算尖峰平摊至严格 $O(1)$ |

---

### 3.7 Tauri IPC / 原生窗口异步监听卸载竞态守卫 (F-09-12 ~ F-09-14, F-09-19)

#### 1. 架构瓶颈定位

- `WindowResizeBridge.ts`（F-09-12）、`AppBootstrap.ts`（F-09-13）与 `ptySessionApi.ts`（F-09-14）在异步调用 `await import(...)`、`await win.onResized(...)` 或 `await listen(...)` 期间，若组件/服务触发卸载或 `disconnect()`，由于未记录代际或未检查 `disposed` 标志，当 Promise 解析后，返回的 `unlisten` 函数未被调用或赋值给已断开的实体，造成原生 IPC 监听器永久悬空。
- `WorkerPool`（F-09-19）崩溃恢复时未清理崩溃任务的 `pending.timeout`，且使用了硬编码的错误 URL。

#### 2. 精准工程改造规范

1. **`WindowResizeBridge` 引入代际令牌（Connect Epoch Guard）**：
   - 维护 `private connectEpoch = 0`；在异步 `await` 解析后严格核对 `if (!this.connected || myEpoch !== this.connectEpoch) { unlisten(); return; }`。
2. **通用的安全异步监听原语（`useSafeAsyncListen`）**：
   - 提供标准封装，在 Promise resolve 瞬间校验 `if (disposed) { off(); return; }`。
3. **`ptySessionApi.ts` 赋值后状态复查**：
   - 在 `entry.unlisten = unlisten;` 之后立即调用 `checkCleanupUnlisten(entry)`，若无活跃 PTY 则立即注销。
4. **`WorkerPool` 崩溃定时器清理**：
   - 补齐 `if (pending.timeout) clearTimeout(pending.timeout)` 与 `entry.worker.terminate()`，统一使用 `this.urlFor(type)`。

---

### 3.8 Store 订阅治理与主线程同步 LocalStorage I/O 降噪 (F-09-15, F-09-20 ~ F-09-22)

#### 1. 架构瓶颈定位

- **不可逆猴子补丁（F-09-15）**：`bootstrapStores.ts` 覆写 `store.subscribe` 且生产环境无条件挂载计数订阅。
- **流式帧同步写盘（F-09-20）**：`withPersist` 在 ~31Hz 流式输出期间，每次 `messages` 变更都会无条件调用 `JSON.stringify` + `localStorage.setItem('crish_session_store', ...)`，尽管 `partialize` 关注的 `activeSessionId` / `folderOrder` / `composerDrafts` 完全未改变。
- **同步大对象解析与热路径读盘（F-09-21, F-09-22）**：`TelemetryService` 每条日志同步写 200 条 JSON；会话索引每 350ms 重新 `getItem + JSON.parse`；`getActiveModelId()` 在渲染期直读 `localStorage`。

#### 2. 精准工程改造规范

1. **`withPersist` 顶层浅等比较短路与尾随防抖**：
   - 在持久化适配器中对 `partialize(state)` 产出的对象各顶层字段做 `Object.is` 浅比对；若与上次持久化快照完全一致，**直接 $O(1)$ 退出，0 次序列化、0 次写盘**；
   - 即使字段变化，施加 250ms 尾随防抖（Trailing Debounce）。
2. **遥测与会话索引内存镜像**：
   - `TelemetryService.persist()` 改为 1000ms 批量防抖；
   - `sessionLocalStorage.ts` 维护内存级 `cachedSessionIndex` 与上次写入指纹；
   - `getActiveModelId()` 与 `getActiveProfileId()` 维护内存镜像变量，首次读取后常驻内存，仅在变更事件中更新。

---

## 四、Part 08 与 Part 09 交叉协同设计 (Cross-Cutting Synergy Architecture)

---

### 4.1 浮层栈与 Detached DOM 内存解耦：WeakRef + Cooldown 自动回收 (PERF-UI-14 + F-09-16)

#### 1. 交叉痛点深度剖析

这是全仓最典型的跨维度性能与内存死锁点：

- **触发场景**：用户右键点击某条聊天消息或工具卡片弹出菜单（`LayerStackManager` 入栈），随后用户点击页面其他空白区域使菜单关闭；
- **泄漏机制**：`LayerStackManager.handleGlobalPointerDown` 捕捉到外部点击，将顶层层的 `anchorRef` DOM 节点与点击目标 `target` 记录在 `this.dismissedByPointer` 快照中，同时将 `target` 保存在 `this.anchorPointerDownTarget` 中，设计初衷是用于 100ms 冷却时间内的防穿透判定；
- **致命后果**：如果此后用户不再点击鼠标（仅使用键盘浏览或打字），而用户滚动了聊天列表或切换了分屏会话，刚才那条消息行已被虚拟滚动卸载出 DOM 树。然而，由于全局单例 `LayerStackManager` 的 `dismissedByPointer.anchor` 与 `target` 依然持有强引用，V8 GC 引擎判定该 DOM 节点不可回收，导致**该节点所关联的整棵 Detached DOM 子树、包含全部 React Fiber 节点、Hook 闭包以及内嵌状态全部滞留内存**，直到下一次任意全局鼠标点击发生！

```
[ 虚拟列表滚动 / 会话切换 ] ───> 消息卡片从 DOM 树卸载 (Detached)
                                         ▲
                                         │ 强引用阻止 GC 回收！
                                         │
[ 全局单例 LayerStackManager ] ──> dismissedByPointer.anchor / target (强引用 HTMLElement)
```

#### 2. 彻底解耦方案：WeakRef + 自动时效脱钩

- **引入 `WeakRef`**：将 `DismissedByPointerSnapshot` 中的 `anchor` 与 `target` 声明为 `WeakRef<HTMLElement>` 与 `WeakRef<Node>`，切断对真实 DOM 对象的强引用；
- **定时器主动归零**：利用已有的 100ms 冷却时效，在触发退栈时启动单次轻量定时器（或与 `silenceTimer` 合并），150ms 后主动执行 `this.dismissedByPointer = null; this.anchorPointerDownTarget = null;`，实现双保险自动脱钩。

```ts
export interface DismissedByPointerSnapshot {
  readonly pointerId: number;
  readonly layerId: string;
  readonly anchorRef: WeakRef<HTMLElement> | null;
  readonly targetRef: WeakRef<Node> | null;
  readonly timestamp: number;
}
```

---

### 4.2 全局监听器生命周期与应用级资源清理协同

#### 1. 全局监听器动静拓扑设计

全应用存在四组重量级全局输入监听：

1. `LayerStackManager`（`window` 的 `keydown`, `pointerdown`, `pointerup`）；
2. `tooltipController`（`window` 的 `scroll`, `keydown`, `pointerdown`, `click`）；
3. `SafeAimEngine`（`window` 的 `mousemove`）；
4. `WindowResizeBridge`（`window` 的 `resize` / Tauri `onResized`）。

#### 2. 统一协同原则

1. **0 激活态即 0 监听器**：
   - 浮层栈为空时，`LayerStackManager` 彻底解绑 `window` 捕获监听器；
   - 无激活/挂起 Tooltip 时，`tooltipController` 在事件触发瞬间 $O(1)$ 快速短路；
   - 无二级子菜单展开时，`SafeAimEngine` 绝对不挂载 `window` `mousemove`。
2. **应用切后台休眠总线（Visibility Sleep Bus）**：
   - 当 `document.visibilityState === 'hidden'` 时，触发休眠广播：
     - 强制清空 `tooltipController` 活动项；
     - 强制清空 `SafeAimEngine` 追踪；
     - 强制刷新 `SessionDraftManager.flushAll()`；
     - 暂停非必要的后台 Observer 评估。

---

### 4.3 会话软逐出/硬删除与 UI 浮层/虚拟滚动的跨层协同

1. **会话切换/删除时的主动浮层关闭**：
   - 当会话发生硬删除或软逐出时，若当前打开的右键菜单、下拉框、Popover 的 `anchor` 属于该会话，通过 `LayerStackManager.dismissByFilter((layer) => layer.sessionId === deletedSessionId)` 立即主动退栈，防止浮层悬空或指向失效的 DOM 节点。
2. **虚拟滚动管理器与高度表的原子释放**：
   - 会话卸载时，原子化注销 `_activeVsmBySession`，同时对 `chatScrollRegistry` 执行高度截断，确保滚动状态机与快照栈同步完成内存释放。

---

## 五、精准文件级改造规范与核心接口/类签名

---

### 5.1 修改与新增文件全景表

| 序号 | 文件相对路径                                                                             | 操作类型 | 涉及缺陷编号             | 核心职责与改造点                                                        |
| :--: | :--------------------------------------------------------------------------------------- | :------: | :----------------------- | :---------------------------------------------------------------------- |
|  1   | `apps/crish-desktop/src/styles/overlay-scrollbar.css`                                    |   修改   | PERF-UI-01, UI-02        | 彻底移除 `[class*='...']` 与空格，收敛为 `.custom-scrollbar`            |
|  2   | `apps/crish-desktop/src/styles/shell/shell-reset.css`                                    |   修改   | PERF-UI-01, UI-03, UI-04 | 移除 `body *` 通配；恢复 `text-rendering: auto`；去除强制连字           |
|  3   | `apps/crish-desktop/src/components/ui/Button/Button.tsx` & `.module.css`                 |   修改   | PERF-UI-04               | TSX 输出精确图标类名，删除 `.button:has(...)` 规则                      |
|  4   | `apps/crish-desktop/src/components/ui/Slider/Slider.tsx` & `.module.css`                 |   修改   | PERF-UI-05, UI-25        | 拖拽零测量；进度条改为 GPU `transform: scaleX` 合成动画                 |
|  5   | `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.tsx` & `.module.css`         |   修改   | PERF-UI-06, UI-07, UI-22 | 按需 will-change；视口 `contain` 隔离；分流重渲染；metricsRef 同步      |
|  6   | `apps/crish-desktop/src/components/ui/Tooltip/tooltipController.ts`                      |   修改   | PERF-UI-08               | 增加 Active/Pending 槽位，空闲 $O(1)$ 立即短路，消除全树 DOM 扫描       |
|  7   | `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx`                               |   修改   | PERF-UI-09, UI-10        | 废除 rAF 轮询；提取布尔依赖消除 JSX 抖动；稳定事件闭包                  |
|  8   | `apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts`                         |   修改   | PERF-UI-11               | 消除非 Debug 全屏 SVG；无子菜单彻底解绑 `mousemove`，纯内存数学化       |
|  9   | `apps/crish-desktop/src/components/ui/SmartPanel/hooks/useSafeAim.ts`                    | **删除** | PERF-UI-12               | 物理删除冗余 Hook，全仓收口至统一的纯数学 `SafeAimEngine`               |
|  10  | `apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx`                       |   修改   | PERF-UI-13               | 移除挂载期 `getBoundingClientRect()` 同步回流；记忆化 Context           |
|  11  | `apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts`         |   修改   | PERF-UI-14, F-09-16      | 仅 window 单捕获；0 浮层 0 监听；空栈短路；WeakRef 解耦 Detached DOM    |
|  12  | `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx`                              |   修改   | PERF-UI-15               | 守卫 `#root` 深度扫描；原生 `checkVisibility()` 替代 `getComputedStyle` |
|  13  | `apps/crish-desktop/src/components/ui/Menu/Menu.tsx` & `menuKeyNavigation.ts`            |   修改   | PERF-UI-16, UI-17        | 区分键盘/鼠标源，消除悬停滚动；按键白名单前置短路                       |
|  14  | `apps/crish-desktop/src/components/ui/SmartExpandablePanel/PositionEngine.ts`            |   修改   | PERF-UI-18               | 消除写读写读布局抖动，改为纯连续读                                      |
|  15  | `apps/crish-desktop/src/components/ui/Select/SelectRoot.tsx` & `SelectItem.tsx`          |   修改   | PERF-UI-20               | 可变 Map + 微任务合并消除挂载风暴；拆分 Highlight 订阅消除全表重渲      |
|  16  | `apps/crish-desktop/src/components/ui/Select/ComboboxItem.tsx` & `comboboxHighlight.tsx` |   修改   | PERF-UI-21               | 缓存 highlight 内容；奇数下标 $O(1)$ 判定分段；修正浮层定位顺序         |
|  17  | `apps/crish-desktop/src/api/MessageSnapshots.ts`                                         |   修改   | F-09-01                  | 真实全量消息字节统计；纯增量存储演进；提供清除特定会话方法              |
|  18  | `apps/crish-desktop/src/store/sessionMessageEviction.ts`                                 | **删除** | F-09-02                  | 物理删除朴素切片实现，统一收口至 `sessionEviction.ts` 三态 LRU          |
|  19  | `apps/crish-desktop/src/store/sessionEvictionProbes.ts`                                  |   修改   | F-09-02, F-09-04         | 导出 `deleteSessionAccessTimestamp(sessionId)` 方法                     |
|  20  | `apps/crish-desktop/src/store/sessionLifecycleBus.ts`                                    | **新增** | F-09-04                  | 建立全系统唯一的会话软逐出与硬删除级联清理总线                          |
|  21  | `apps/crish-desktop/src/store/sessionCrudActions.ts`                                     |   修改   | F-09-04                  | `deleteSession` 底层广播生命周期总线，杜绝外层漏调                      |
|  22  | `apps/crish-desktop/src/api/draft/sessionDraftManager.ts`                                |   修改   | F-09-05                  | 增设 `deleteSession`；分会话独立防抖 Map，修复草稿复活 Bug              |
|  23  | `apps/crish-desktop/src/api/SessionRuntimeRegistry.ts`                                   |   修改   | F-09-03, F-09-06         | 启动 GC；软逐出释放 Diff/附件；满额淘汰严格保护推流与活跃会话           |
|  24  | `apps/crish-desktop/src/api/ptyRegistry.ts`                                              |   修改   | F-09-07                  | 增加 `takeAllForSession` 前缀通配提取，彻底杀绝衍生与分屏 PTY           |
|  25  | `apps/crish-desktop/src/components/workspace/ptyWriteGate.ts`                            |   修改   | F-09-08                  | 增加 512KB 环形缓冲容量截断，消除隐藏终端无界膨胀                       |
|  26  | `apps/crish-desktop/src/api/chat-bridge/handlers/taskEventHandlers.ts`                   |   修改   | F-09-09                  | 修复 `onTimerFired` 误用 `.add()` 为 `.delete()`                        |
|  27  | `apps/crish-desktop/src/api/tool-presentation/timelineCache.ts`                          |   修改   | F-09-11                  | 整表 `.clear()` 改为平滑 LRU 逐项淘汰                                   |
|  28  | `apps/crish-desktop/src/services/WindowResizeBridge.ts`                                  |   修改   | F-09-12                  | 引入代际令牌（`connectEpoch`），根除异步卸载监听泄漏                    |
|  29  | `apps/crish-desktop/src/app/AppBootstrap.ts`                                             |   修改   | F-09-13                  | 异步 `listen` 增加 `if (disposed)` 守卫                                 |
|  30  | `apps/crish-desktop/src/api/ptySessionApi.ts`                                            |   修改   | F-09-14                  | `ensureTauriListen` 完成后状态复查，消除悬空监听                        |
|  31  | `apps/crish-desktop/src/store/bootstrapStores.ts`                                        |   修改   | F-09-15                  | 移除非法猴子补丁，仅在开发环境按需包装                                  |
|  32  | `apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx`                   |   修改   | F-09-17                  | 滚动热路径改用二分区间；移除全树 MutationObserver 与 DOM 测量           |
|  33  | `apps/crish-desktop/src/components/workspace/useXtermTerminal.ts`                        |   修改   | F-09-18                  | 保存 WebGL 恢复定时器句柄，并在 cleanup 中清理                          |
|  34  | `apps/crish-desktop/src/workers/worker-pool.ts`                                          |   修改   | F-09-19                  | 崩溃恢复清理 `pending.timeout`；统一使用 `this.urlFor(type)`            |
|  35  | `apps/crish-desktop/src/store/middleware/withPersist.ts`                                 |   修改   | F-09-20                  | 增加顶层浅比较短路 + 250ms 尾随防抖持久化适配器                         |
|  36  | `apps/crish-desktop/src/services/TelemetryService.ts`                                    |   修改   | F-09-21                  | 增加 1000ms 批量写入节流，消除单条日志同步重写                          |
|  37  | `apps/crish-desktop/src/api/provider-profiles/profileActiveSelection.ts`                 |   修改   | F-09-22                  | 建立内存态镜像，消除渲染期与发送预检对 LocalStorage 的直读              |

---

### 5.2 核心类/函数/接口详细代码定义

#### 1. `LayerStackManager.ts` 优化后核心实现骨架（WeakRef 解耦 + 动静按需监听）

```ts
// apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts

export interface DismissedByPointerSnapshot {
  readonly pointerId: number;
  readonly layerId: string;
  readonly anchorRef: WeakRef<HTMLElement> | null;
  readonly targetRef: WeakRef<Node> | null;
  readonly timestamp: number;
}

export class LayerStackManager {
  private static instance: LayerStackManager | null = null;
  private static readonly COOLDOWN_WINDOW_MS = 100;

  private layers: LayerRegistration[] = [];
  private traceHistory: LayerTraceRecord[] = [];
  private isListening = false;
  private sequence = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  // 彻底使用 WeakRef 解耦真实 DOM，杜绝 Detached DOM 驻留
  private anchorPointerDownTarget: WeakRef<Node> | null = null;
  private dismissedByPointer: DismissedByPointerSnapshot | null = null;

  private constructor() {
    // 默认不挂载监听器，实现 0 浮层时 0 全局监听
  }

  public static getInstance(): LayerStackManager {
    if (!LayerStackManager.instance) {
      LayerStackManager.instance = new LayerStackManager();
    }
    return LayerStackManager.instance;
  }

  public register(layer: Omit<LayerRegistration, 'mountedAt'>): () => void {
    const fullLayer: LayerRegistration = {
      ...layer,
      mountedAt: ++this.sequence,
    };

    this.layers = this.layers.filter((l) => l.id !== fullLayer.id);
    this.evictExclusivePeers(fullLayer);
    this.layers.push(fullLayer);

    this.layers.sort((a, b) => {
      const pA = LAYER_TYPE_PRIORITY[a.type] ?? 0;
      const pB = LAYER_TYPE_PRIORITY[b.type] ?? 0;
      if (pA !== pB) return pA - pB;
      return a.mountedAt - b.mountedAt;
    });

    // 仅当首个浮层挂载时才挂载全局监听器
    if (this.layers.length === 1) {
      this.attachGlobalListeners();
    }

    this.updateFloatingActiveState();
    return () => {
      this.unregister(fullLayer.id, 'programmatic');
    };
  }

  public unregister(
    layerId: string,
    reason: LayerDismissReason = 'programmatic'
  ): void {
    const idx = this.layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return;
    const [removed] = this.layers.splice(idx, 1);
    if (removed) {
      this.recordTrace(removed.id, removed.type, reason);
    }

    // 栈归零时立即彻底解绑全局监听器
    if (this.layers.length === 0) {
      this.detachGlobalListeners();
    }

    this.updateFloatingActiveState();
  }

  private attachGlobalListeners(): void {
    if (this.isListening || typeof window === 'undefined') return;
    // 仅在 window 捕获阶段绑定单一监听器，消除 document 上的双重绑定
    window.addEventListener('keydown', this.handleGlobalKeyDown, true);
    window.addEventListener('pointerdown', this.handleGlobalPointerDown, true);
    window.addEventListener('pointerup', this.handleGlobalPointerUp, true);
    this.isListening = true;
  }

  private detachGlobalListeners(): void {
    if (!this.isListening || typeof window === 'undefined') return;
    window.removeEventListener('keydown', this.handleGlobalKeyDown, true);
    window.removeEventListener(
      'pointerdown',
      this.handleGlobalPointerDown,
      true
    );
    window.removeEventListener('pointerup', this.handleGlobalPointerUp, true);
    this.isListening = false;
  }

  private handleGlobalPointerDown = (event: PointerEvent): void => {
    // 空栈 O(1) 立即短路
    if (this.layers.length === 0) return;

    this.dismissedByPointer = null;
    const target = event.target as Node | null;
    if (!target) return;

    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const layersToDismiss: LayerRegistration[] = [];
    let hitAnchorTarget: Node | null = null;

    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (!layer || !layer.dismissible) continue;

      const topEl = resolveElement(layer.elementRef);
      if (topEl && topEl.contains(target)) continue;

      const anchorEl = resolveElement(layer.anchorRef);
      if (anchorEl && anchorEl.contains(target)) {
        hitAnchorTarget = target;
        continue;
      }

      const descendants = this.getDescendants(layer.id);
      const isInsideDescendants = descendants.some((child) => {
        const childEl = resolveElement(child.elementRef);
        return childEl && childEl.contains(target);
      });
      if (isInsideDescendants) continue;

      layersToDismiss.push(layer);
    }

    this.anchorPointerDownTarget = hitAnchorTarget
      ? new WeakRef(hitAnchorTarget)
      : null;

    if (layersToDismiss.length > 0 && layersToDismiss[0]) {
      const topLayer = layersToDismiss[0];
      const anchorEl = resolveElement(topLayer.anchorRef);
      this.dismissedByPointer = {
        pointerId: event.pointerId,
        layerId: topLayer.id,
        anchorRef: anchorEl ? new WeakRef(anchorEl) : null,
        targetRef: new WeakRef(target),
        timestamp: now,
      };

      // 启动 150ms 冷却自动清理定时器，双重保障自动脱钩
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        this.dismissedByPointer = null;
        this.anchorPointerDownTarget = null;
        this.silenceTimer = null;
      }, 150);

      for (const l of layersToDismiss) {
        if (l) this.dismissLayer(l.id, 'outside-pointer');
      }
    }
  };

  private dismissLayer(layerId: string, reason: LayerDismissReason): void {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer) return;
    // 移除本处的重复 recordTrace，统一由 unregister 记录
    if (typeof layer.onDismiss === 'function') {
      try {
        layer.onDismiss(reason);
      } catch (err) {
        console.error('[LayerStackManager] Error in onDismiss callback:', err);
      }
    }
    this.unregister(layer.id, reason);
  }
}
```

#### 2. `FocusTrapIsolationManager` 优化后关键代码（#root 守卫与原生 checkVisibility）

```ts
// apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((el) => {
    // 优先采用 Chromium 原生 C++ 快速可见性检测，避免昂贵的 getComputedStyle 构造
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({
        checkOpacity: false,
        checkVisibilityCSS: true,
      });
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

class FocusTrapIsolationManager {
  private isWhitelisted(node: Element): boolean {
    // 刚性拦截 #root，绝不允许对主界面数千个节点执行 querySelector 全树扫描！
    if (node.id === 'root') return false;

    if (
      node.hasAttribute('data-radix-popper-content-wrapper') ||
      node.getAttribute('data-tooltip-portal') === 'true' ||
      node.getAttribute('data-toast-container') === 'true' ||
      node.id === 'toast-root' ||
      node.id === 'tooltip-portal' ||
      node.getAttribute('data-slot') === 'select-content' ||
      node.getAttribute('data-slot') === 'combobox-content' ||
      node.getAttribute('role') === 'listbox' ||
      node.hasAttribute('data-floating-layer')
    ) {
      return true;
    }

    // 仅检测直接子级，禁止无界深层递归
    return (
      node.querySelector?.(
        ':scope > [data-floating-layer], :scope > [data-slot="select-content"]'
      ) != null
    );
  }
}
```

#### 3. `Select` / `Combobox` 虚拟化与单项状态解耦架构（HighlightStore）

```tsx
// apps/crish-desktop/src/components/ui/Select/HighlightStore.ts

export type HighlightListener = (highlightedIndex: number) => void;

export class HighlightStore {
  private currentIndex = -1;
  private listeners = new Set<HighlightListener>();

  getHighlightedIndex = (): number => this.currentIndex;

  setHighlightedIndex = (next: number): void => {
    if (this.currentIndex === next) return;
    this.currentIndex = next;
    this.notify();
  };

  subscribe = (listener: HighlightListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.currentIndex);
    }
  }
}
```

```tsx
// apps/crish-desktop/src/components/ui/Select/SelectItem.tsx

export const SelectItem = React.memo(function SelectItem({
  itemId,
  value,
  children,
  disabled = false,
}: SelectItemProps) {
  const ctx = useSelectContext();
  const highlightStore = useSelectHighlightStore();

  // 选项下标 O(1) 瞬时获取
  const itemIndex = ctx.getItemIndex(itemId);

  // 细粒度状态切片订阅：仅当自身高亮状态改变时才重渲，时间复杂度 O(1)！
  const isHighlighted = useSyncExternalStore(
    highlightStore.subscribe,
    () => highlightStore.getHighlightedIndex() === itemIndex
  );

  const isSelected = ctx.value === value;

  const handleMouseEnter = useCallback(() => {
    if (!disabled && itemIndex >= 0) {
      highlightStore.setHighlightedIndex(itemIndex);
    }
  }, [disabled, itemIndex, highlightStore]);

  return (
    <div
      role="option"
      aria-selected={isSelected}
      data-highlighted={isHighlighted}
      onMouseEnter={handleMouseEnter}
      onClick={() => !disabled && ctx.onSelect(value)}
    >
      {children}
    </div>
  );
});
```

#### 4. 全系统会话生命周期级联清理总线 (`SessionLifecycleBus.ts`)

```ts
// apps/crish-desktop/src/store/sessionLifecycleBus.ts

export type SessionLifecycleCleanupFn = (sessionId: string) => void;

interface SessionLifecycleHandlers {
  onSoftEvict: Set<SessionLifecycleCleanupFn>;
  onHardDelete: Set<SessionLifecycleCleanupFn>;
}

const handlers: SessionLifecycleHandlers = {
  onSoftEvict: new Set(),
  onHardDelete: new Set(),
};

/**
 * 注册会话软逐出回调（释放内存重资产，保留基础会话壳）
 */
export function registerSessionSoftEvictHandler(
  fn: SessionLifecycleCleanupFn
): () => void {
  handlers.onSoftEvict.add(fn);
  return () => handlers.onSoftEvict.delete(fn);
}

/**
 * 注册会话硬删除回调（全系统级联清理，100% 销毁一切关联资源）
 */
export function registerSessionHardDeleteHandler(
  fn: SessionLifecycleCleanupFn
): () => void {
  handlers.onHardDelete.add(fn);
  return () => handlers.onHardDelete.delete(fn);
}

/**
 * 广播会话软逐出事件（由 sessionStateActions.ts 底层触发）
 */
export function emitSessionSoftEvicted(sessionId: string): void {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  for (const handler of handlers.onSoftEvict) {
    try {
      handler(sid);
    } catch (err) {
      console.error(
        `[SessionLifecycleBus] Error in onSoftEvict for ${sid}:`,
        err
      );
    }
  }
}

/**
 * 广播会话硬删除事件（由 sessionCrudActions.deleteSession 底层触发）
 */
export function emitSessionHardDeleted(sessionId: string): void {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  for (const handler of handlers.onHardDelete) {
    try {
      handler(sid);
    } catch (err) {
      console.error(
        `[SessionLifecycleBus] Error in onHardDelete for ${sid}:`,
        err
      );
    }
  }
}
```

#### 5. `withPersist.ts` 浅等比较与防抖持久化适配器

```ts
// apps/crish-desktop/src/store/middleware/withPersist.ts

import {
  persist,
  type PersistOptions,
  type StateStorage,
} from 'zustand/middleware';
import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla';

function shallowEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  )
    return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is(a[key], b[key])
    ) {
      return false;
    }
  }
  return true;
}

export function createDebouncedShallowStorage(
  rawStorage: StateStorage = localStorage,
  debounceMs = 250
): StateStorage {
  const lastStateMap = new Map<string, unknown>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    getItem: (name: string) => rawStorage.getItem(name),
    setItem: (name: string, value: string) => {
      let parsedValue: any;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        rawStorage.setItem(name, value);
        return;
      }

      const currentState = parsedValue?.state;
      const lastState = lastStateMap.get(name);

      // 顶层浅等比较短路：流式输出仅改动 messages 时，直接 0 次写盘 O(1) 退出！
      if (lastState && shallowEqual(currentState, lastState)) {
        return;
      }

      lastStateMap.set(name, currentState);

      const existingTimer = timers.get(name);
      if (existingTimer) clearTimeout(existingTimer);

      timers.set(
        name,
        setTimeout(() => {
          try {
            rawStorage.setItem(name, value);
          } finally {
            timers.delete(name);
          }
        }, debounceMs)
      );
    },
    removeItem: (name: string) => {
      const existingTimer = timers.get(name);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timers.delete(name);
      }
      lastStateMap.delete(name);
      rawStorage.removeItem(name);
    },
  };
}
```

---

## 六、立体验证断言、测试矩阵与性能门禁 (Verification, Testing & Performance Gates)

依据 `AGENTS.md` §7 与 §7.1，严禁单一脱水检查冒充验收，必须履行立体化验证守卫：

### 6.1 静态与 AST 门禁（CI Fast Layer 阻断）

在 `scripts/check-perf-guardrails.mjs` 中新增静态代码分析检查，阻断任何回潮：

1. **禁止全局 `[class*=...]` 子串选择器**：
   - 规则：扫描 `apps/crish-desktop/src/styles/**/*.css`，断言 `[class*=` 与 `[class^=` 匹配计数恒为 `0`。
2. **禁止 `transition: all` 与非合成几何属性 `will-change`**：
   - 规则：扫描全仓 `.css` 与 `.module.css`，断言 `transition:\s*all` 匹配数为 `0`；断言 `will-change:\s*.*(width|height|max-height|top|left|margin|padding|background)` 匹配数为 `0`。
3. **禁止 `body *` 通配符重排规则**：
   - 规则：断言 `shell-reset.css` 中不包含 `body.leaf-dock-resizing *`。
4. **禁止 `timer-fired` 误调 `.add()`**：
   - 规则：扫描 `taskEventHandlers.ts`，断言 `onTimerFired` 函数体中仅调用 `activeTimerIds.delete`，严禁出现 `activeTimerIds.add`。

### 6.2 单元与集成测试契约（Vitest 确定性断言）

1. **`LayerStackManager` 单监听器与 WeakRef 断言**：
   - 测试场景：注册浮层并模拟外部点击关闭；
   - 断言：`document.addEventListener` 捕获调用为 0；关闭后 `this.dismissedByPointer.targetRef.deref()` 随垃圾回收可正常释放；栈为空时派发点击，内部循环计数为 0。
2. **`Select` / `Combobox` 局部重渲染与 $O(1)$ 查找契约**：
   - 测试场景：挂载包含 100 个选项的下拉菜单并展开，模拟鼠标从项 0 移入项 1；
   - 断言：使用 React Profiler 监听，`<SelectTrigger>` 重渲染为 0 次，子项重渲染精确为 2 次（旧/新项），其余 98 项重渲染计数为 0。
3. **会话级联删除 12 处容器清空契约**：
   - 测试场景：创建一个会话，写入草稿、注册快照、绑定 PTY、触发定时器，随后调用 `deleteSession(sid)`；
   - 断言：12 个模块级容器及 `localStorage` 对应键全部清空；`ptyKill` IPC 被调用且通配匹配 `${sid}:terminal:2`。
4. **`withPersist` 浅等防抖短路契约**：
   - 测试场景：连续 50 次仅更新 `sessionStore.sessions[0].messages`（模拟 31Hz 流式推送）；
   - 断言：底层 `localStorage.setItem('crish_session_store', ...)` 调用次数严格为 **0 次**。

### 6.3 内存泄漏专项断言（Headless Chrome / Heap Profiler）

1. **Detached DOM 泄漏测试**：
   - 连续创建 10 个会话并分别挂载带有 Tooltip、Menu、Select 的消息卡片，随后依次关闭浮层并逐出/删除会话；
   - 触发无头浏览器 `HeapProfiler.takeHeapSnapshot`；
   - 断言：`Detached HTMLElement` 数量与 `Detached FiberNode` 数量增长绝对值为 `0`。
2. **Rust PTY 孤儿进程测试**：
   - 启动 5 个带有分屏与多终端的会话并执行 `dir`；
   - 侧栏右键删除全部会话；
   - 断言：宿主后台无残留的 `conhost.exe` / `powershell.exe` / `bash` 进程。

### 6.4 真实桌面宿主现场验收（Tauri MCP 4000 通道）

在 `127.0.0.1:4000` 桌面宿主上执行现场抽样压测：

- **流式输出帧率稳定性**：在 4K 分辨率屏幕下并发启动 3 个子代理流式输出，主线程掉帧率（Drop Frames）$< 1\%$，单帧样式重算耗时 $\le 1.2\text{ms}$。
- **长时间运行内存平稳性**：连续切换 30 次大型历史会话并操作各类浮层，V8 Heap 内存增量在垃圾回收后回落至基线 $\pm 5\text{MB}$ 以内，无不可回收驻留。

---

## 七、实施分波规划与风险回滚预案 (Rollout Waves & Safety Precautions)

本方案共涵盖 48 项优化任务，实施过程按逻辑依赖划分为 4 个推进波次：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        实施分波与落地推进流水线                        │
├───────────────┬────────────────────────────────────────────────────────┤
│ Wave 1 (底座) │ CSS 样式规则重构、排版管线恢复、非合成属性过渡清零     │
│               │ (PERF-UI-01 ~ UI-07)                                   │
├───────────────┼────────────────────────────────────────────────────────┤
│ Wave 2 (生命) │ SessionLifecycleBus 建立、会话逐出单轨收敛、           │
│               │ 12 处容器自注销、PTY 批量杀死与定时器 Bug 根除         │
│               │ (F-09-01 ~ F-09-11, F-09-16 ~ F-09-19)                 │
├───────────────┼────────────────────────────────────────────────────────┤
│ Wave 3 (浮层) │ LayerStackManager (WeakRef/短路)、FocusTrap (#root守卫)│
│               │ Tooltip/SafeAim 零 DOM 化、Select/Combobox 状态解耦    │
│               │ (PERF-UI-08 ~ UI-26)                                   │
├───────────────┼────────────────────────────────────────────────────────┤
│ Wave 4 (存储) │ withPersist 浅等防抖、遥测写盘节流、异步监听守卫       │
│               │ (F-09-12 ~ F-09-15, F-09-20 ~ F-09-22)                 │
└───────────────┴────────────────────────────────────────────────────────┘
```

### 风险控制与保底预案

1. **样式迁移兼容风险**：在移除 `[class*='...']` 时，若某些动态主题或外部注入样式依赖该类名，保留 `[data-scrollbar]` 兼容属性平滑过渡。
2. **逐出状态机保底**：三态逐出状态机中，若分屏查询出现异常，默认回退为保护当前 `activeSessionId`，绝不因计算异常误删正在输入的会话。
3. **PTY 杀进程安全防护**：前缀通配提取仅严格匹配 `${sessionId}:` 格式，防止因 `sessionId` 为空字符串导致误杀全局其他终端。
4. **Git 纪律遵循**：方案制定阶段 100% 遵守只读勘察边界，无任何业务代码修改与 git 提交，方案文档经综合审查裁决通过后按波次有序实施。
