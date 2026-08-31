# SmartExpandablePanel 交互状态机、Safe-Aim 算法与无障碍防退避魔鬼审查报告

> **文档标识**：`docs/smart-panel-migration/plan-reviews/02-interaction-state-critique.md`  
> **所属战役**：`docs/smart-panel-migration/`  
> **审查专家**：极度严苛的交互状态机、Safe-Aim 算法与无障碍防退避审查专家（Interaction & Algorithm Devil Reviewer）  
> **审查对象**：
> - `docs/smart-panel-migration/00-total-migration-plan.md`
> - `docs/smart-panel-migration/independent-plans/01-foundation-adapters-plan.md`
> - `docs/smart-panel-migration/independent-plans/02-composer-chat-plan.md`
> - `docs/smart-panel-migration/independent-plans/03-headers-workspace-plan.md`
> - `docs/smart-panel-migration/independent-plans/04-settings-forms-plan.md`
> - `docs/smart-panel-migration/independent-plans/05-sidebar-files-diff-plan.md`  
> **最高铁律执行**：本报告通篇 100% 直击问题、算法缺陷、数学边界漏洞、交互死锁与退避降级倾向，零赞美、零褒奖、零肯定性废话。

---

## 目录索引

1. [一、SVG Safe-Aim 虚拟碰撞多边形算法致命缺陷与边界崩溃](#一svg-safe-aim-虚拟碰撞多边形算法致命缺陷与边界崩溃)
2. [二、PositionEngine 几何解算、视口翻转抖动与假 120Hz 漏洞](#二positionengine-几何解算视口翻转抖动与假-120hz-漏洞)
3. [三、全键盘 WAI-ARIA 漫游闭环断裂与焦点黑洞](#三全键盘-wai-aria-漫游闭环断裂与焦点黑洞)
4. [四、滚轮穿透隔离（Wheel Isolation）伪实现与分屏手势冲突](#四滚轮穿透隔离wheel-isolation伪实现与分屏手势冲突)
5. [五、退避简化倾向审查与跨文档口径严重自相矛盾](#五退避简化倾向审查与跨文档口径严重自相矛盾)
6. [六、魔鬼审查修复整改指令清单](#六魔鬼审查修复整改指令清单)

---

## 一、SVG Safe-Aim 虚拟碰撞多边形算法致命缺陷与边界崩溃

### 1.1 单实例覆盖与三级以上多层级联栈归零崩溃
- **缺陷定位**：`01-foundation-adapters-plan.md:658-750`、`SafeAimEngine.ts`。
- **根因分析**：
  `SafeAimEngine` 在内部仅声明了单个 `activeSubmenu: HTMLElement | null` 与 `activeTriggerItem: HTMLElement | null`。当业务场景出现多层级联（例如：主菜单 → 一级服务商 → 二级模型类别 → 三级特定模型参数，或目录树多级下钻）时，子级菜单的激活会直接**暴力覆写**父级的 `activeSubmenu` 引用。
- **破坏性后果**：
  一旦用户从 Level 2 向 Level 3 移动，Level 1 到 Level 2 的保护多边形立刻失效；若用户的光标在多层之间略微回退或斜切，Level 1 将立即判定光标“离开有效区”，引发整条级联链路的**瞬时雪崩式闪退（Cascade Collapse）**。与 `keyboardNav.ts` 中维护的 `submenuStack` 形成了严重的架构断层。

```
[ 多层级联 Safe-Aim 崩溃链路 ]
Level 1 Item ────> Level 2 Submenu (activeSubmenu = L2)
                         │
                         ▼
                   Level 2 Item ────> Level 3 Submenu (activeSubmenu 暴力覆写为 L3！)
                                            │
   [用户光标斜切回划] ───────────────────────┴──> L1 保护区被冲掉 -> L2/L3 瞬间全部闪退！
```

### 1.2 鼠标反向掠过（Backward Motion）与无向三角形死锁
- **缺陷定位**：`01-foundation-adapters-plan.md:773-815`（`isPointerInSafeZone` 与 `pointInTriangle`）。
- **根因分析**：
  算法仅依赖重心坐标法（Barycentric Coordinates）判定坐标点是否落在 `(mouse, pTop, pBottom)` 围成的三角形几何体内，**完全缺失运动速度矢量与方向导数判定（$\vec{v} \cdot \vec{d} > 0$）**。
- **破坏性后果**：
  当二级子菜单位于右侧时，如果用户把鼠标**向左快速回划**（明确意图是回到主菜单选择其他同级项），只要当前光标位置仍处于旧的历史三角区几何包络内，`isPointerInSafeZone` 就会持续返回 `true`。这导致相邻主菜单项的 `mouseenter` 事件被强制拦截忽略，造成极为严重的**“悬停阻尼卡滞/主菜单项无法切换”**体验。

### 1.3 悬停死锁与缺少 Safety Timeout 熔断计时器
- **缺陷定位**：`01-foundation-adapters-plan.md:1698-1700`、`SmartExpandablePanel.tsx`。
- **根因分析**：
  ```typescript
  onHoverSubmenu={(node, el) => {
    if (safeAimEngine.isPointerInSafeZone(safeAimEngine.getRecentMousePos())) {
      return; // 致命：没有任何超时自愈机制！
    }
    ...
  }}
  ```
  代码在命中安全区时直接 `return` 丢弃事件。如果用户将光标移动到三角区内的某一个兄弟项上方并**停止移动（停顿思考）**，由于没有设置任何宽限期定时器（Safety Timeout，如 300ms 熔断），该兄弟项将**永久处于失活状态**，用户必须晃动鼠标移出三角区才能重新激活，构成经典的状态机死锁。

### 1.4 全局 DOM 单例与多浮层/并发卸载下的 Overlay 误杀
- **缺陷定位**：`01-foundation-adapters-plan.md:687-701`、`817-824`。
- **根因分析**：
  `initSvgOverlay` 写死了硬编码 ID `document.getElementById('sepSafeAimOverlay')`，并直接挂载在 `document.body`。而在 `SmartExpandablePanel.tsx:1498` 中，每个面板组件实例在挂载时都会 `new SafeAimEngine()`。
- **破坏性后果**：
  1. 在分屏工作区（左右两栏各自打开菜单）或浮层内嵌套浮层时，多个引擎实例争抢同一个全局 SVG 节点，坐标属性高频互相覆盖；
  2. 当其中一个组件销毁触发 `useEffect cleanup -> safeAimEngine.destroy()` 时，它会直接从 `document.body` 中移除 `#sepSafeAimOverlay`，并注销 `window.mousemove` 监听，导致**正在运行的其他所有菜单的 Safe-Aim 保护瞬间暴毙**。

---

## 二、PositionEngine 几何解算、视口翻转抖动与假 120Hz 漏洞

### 2.1 32px 滞后阈值在小屏/临界空间的算术死循环与强行覆盖触发器
- **缺陷定位**：`00-total-migration-plan.md:384-410`、`01-foundation-adapters-plan.md:508-533`。
- **数学漏洞剖析**：
  当面板在小屏幕（如 768px 高度）或分屏底部触发时，假设 `spaceBelow = 150px`，`spaceAbove = 170px`，面板自然高度 `cappedHeight = 300px`。
  1. `idealDirY` 计算为 `'up'`（因为 170 > 150）；
  2. 若初始/先前状态为 `'down'`，滞后区间判定：`idealSpace - currentSpace = 170 - 150 = 20px`；
  3. 由于 `20px < 32px`（`hysteresisY`），`preferredDirY` 被死锁在 `'down'`；
  4. 选定 `'down'` 后，可用空间仅剩 `availableVerticalSpace = 150px`；
  5. 计算列表最大高度：`allowedListHeight = Math.max(120, 150 - 38 - 16) = 120px`；
  6. 加上头部 38px、内衬 12px、边框 2px，面板实际物理高度至少为 `172px`；
  7. 面板真实高度（172px）超过下方空间（150px），触发硬性视口边界钳位：`targetY = Math.max(bounds.top, Math.min(bounds.bottom - 100, targetY))`。
- **破坏性后果**：
  向下展开的面板被视口底部向上推挤，**直接糊在触发器按钮正上方，将触发器完全遮挡！** 用户点击原本想关闭面板，结果直接误触面板内的第一项菜单，产生极其危险的误操作。

```
┌─────────────────────────────────────────────────────────┐
│ Viewport Boundary (Bottom: 768px)                       │
│                                                         │
│  [ Trigger Button ] (Top: 610px, Bottom: 638px)         │
│  ┌───────────────────────────────┐                      │
│  │ Overlapped SmartPanel (172px) │ <── 滞后锁死向下，但下方空间不足│
│  │ 强行向上钳位，遮挡触发器！   │     导致面板反向吞没触发按钮！ │
│  └───────────────────────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

### 2.2 虚假 120Hz RAF 宣传与动态窗口 Resize/Scroll 监听完全缺失
- **缺陷定位**：方案通篇宣称“120Hz 实时窗口跟随 / 120Hz RAF 视口解算”，但审查 `01-foundation-adapters-plan.md:1570-1585` 的代码实现：
  ```typescript
  useEffect(() => {
    if (open) {
      ...
      updatePosition(); // 仅在 open 变化时单次执行！
      ...
    }
  }, [open, ...]);
  ```
- **破坏性后果**：
  代码中**根本没有接入任何 `requestAnimationFrame` 调度循环**，也没有为 `window` 或滚动父容器注册 `scroll`、`resize` 事件监听，更没有对 `panelRef` 挂载 `ResizeObserver`。
  当用户拖拽调整窗口大小、在分屏侧边栏滚动底页、或者由于异步数据（如模型列表、服务商加载）导致面板高度动态变化时，**面板物理坐标完全冻结在初始位置，悬空漂移在屏幕中央**！这是极度严重的文档夸大与实现退避。

### 2.3 `measureNaturalHeight` 引起的同步重排（Layout Thrashing）性能雪崩
- **缺陷定位**：`00-total-migration-plan.md:511-536`、`01-foundation-adapters-plan.md:453-477`。
- **性能漏洞剖析**：
  ```typescript
  listEl.style.maxHeight = 'none';
  listEl.style.overflow = 'visible';
  const listScrollHeight = listEl.scrollHeight; // 触发强制重排 (Reflow 1)
  const panelStyle = window.getComputedStyle(panelEl); // 触发强制重排 (Reflow 2)
  ...
  listEl.style.maxHeight = prevMaxHeight;
  listEl.style.overflow = prevOverflow; // 触发样式脏标记 (Style Invalidation)
  ```
- **破坏性后果**：
  如果后续补齐了滚动/跟随更新机制，每秒 60/120 次执行 `measureNaturalHeight` 将在单帧内连续触发 DOM 读写交替，引发浏览器的 **Forced Synchronous Layout（强制同步重排）**，直接导致主线程掉帧、输入卡顿与风扇狂转。

### 2.4 二级子菜单水平翻转（isFlipLeft）缺少双向溢出保护导致的父子重叠
- **缺陷定位**：`01-foundation-adapters-plan.md:609-638`（`calculateSubmenuPosition`）。
- **根因分析**：
  ```typescript
  if (targetX + subWidth > bounds.right) {
    targetX = itemRect.left - subWidth - 4;
    isFlipLeft = true;
  }
  return { x: Math.max(bounds.left, targetX), ... };
  ```
  在窄屏幕、小窗口或右侧分屏（宽度只有 300px~360px）环境下：
  1. 向右展开超出 `bounds.right`；
  2. 触发向左翻转，但左侧空间同样不足（`itemRect.left - subWidth - 4 < bounds.left`）；
  3. 代码通过 `Math.max(bounds.left, targetX)` 硬性截断。
- **破坏性后果**：
  二级子菜单直接被生硬拍在 `bounds.left` 上，**100% 垂直重叠覆盖在父级主菜单正上方**。父级菜单项被完全遮死，用户既看不到自己刚才选了什么，也无法移回父菜单，交互路径彻底瘫痪。

---

## 三、全键盘 WAI-ARIA 漫游闭环断裂与焦点黑洞

### 3.1 搜索输入框焦点单向被夺与 `ArrowUp` 无法回弹的死循环
- **缺陷定位**：`01-foundation-adapters-plan.md:943-955`、`1578-1580`。
- **交互逻辑死锁还原**：
  1. 打开带搜索的面板（如 `ProjectPickerMenu`、`FontSelectField`），`enableSearch: true`，光标聚焦在 `<input className="sep-search-input" />` 内；
  2. 用户按下 `ArrowDown` 准备选择第一项，`keyboardNav.onKeyDown` 捕获事件，执行 `e.preventDefault()` 并调用 `focusItem(0)`；
  3. 第一项获得焦点，DOM focus 离开 `<input>`；
  4. **死循环 1**：用户发现需要重新修改搜索词，在第 0 项按下 `ArrowUp`。代码计算 `prevIdx = 0 - 1 = -1`，执行 `if (index < 0) index = items.length - 1;`，**焦点直接瞬移跳到了列表最后一项**！没有任何逻辑能把焦点送回顶部搜索框；
  5. **死锁 2**：焦点留在菜单项上时，用户直接敲击字母键试图继续输入，由于键盘漫游引擎没有实现字符前缀直达（Type-ahead Buffer），且焦点不在输入框内，所有按键全部被丢弃或触发未知行为。

### 3.2 `Tab` / `Shift+Tab` 键完全放行导致的 Portal 焦点无序漂移与浮层孤立
- **缺陷定位**：`01-foundation-adapters-plan.md:942-1008`（`keyboardNav.ts`）。
- **无障碍硬伤**：
  全篇 `keyboardNav.ts` **对 `Tab` 键零拦截、零处理**。
  因为面板通过 `createPortal` 挂载在 `document.body` 末尾，当视障用户或全键盘用户在面板内按下 `Tab` 键时，浏览器的原生焦点会立即跳出浮层，落入页面底部的不可见元素或外部工具栏上。
  而此时浮层依然处于 `open={true}` 状态，造成**“焦点已逃逸、面板未关闭、屏幕阅读器读错上下文”**的严重无障碍失控（Focus Trap Missing）。

### 3.3 折叠手风琴（Collapsible）隐藏子节点被错误索引与展开语义缺失
- **缺陷定位**：`01-foundation-adapters-plan.md:889-896`、`1430-1445`。
- **算法缺陷剖析**：
  `getNavigableItems` 依靠 `container.querySelectorAll(...)` 获取可导航节点。
  手风琴折叠区（`.collapsibleContent`）采用 CSS Grid `grid-template-rows: 0fr` 进行隐藏。在 DOM 树中，折叠项内部的子节点依然存在，且其 `display` 并非 `none`（而是高度为 0、`overflow: hidden`）。
  `el.offsetParent` 依然不为 `null`！
- **破坏性后果**：
  当手风琴处于**收起/关闭状态**时，用户按 `ArrowDown` 遍历列表，焦点会**盲目穿透落入这些高度为 0 的不可见子项中**！屏幕上看不到任何光标高亮，界面出现假死假盲区。
  同时，在手风琴标题项上按 `Enter`/`Space` 仅触发点击，缺失符合 WAI-ARIA Disclosure 规范的 `aria-expanded="true/false"` 状态双向绑定与 `ArrowRight`/`ArrowLeft` 展开/收起快捷手势。

### 3.4 尾部操作按钮（Trailing Actions）与 Footer 按钮在键盘流中被彻底遗弃
- **缺陷定位**：`03-headers-workspace-plan.md:318-333`（项目删除 Trash 图标）、`731-745`（终止子代理按钮）、`01-foundation-adapters-plan.md:1758`（`footer`）。
- **无障碍盲区**：
  方案在许多业务菜单中设计了悬停操作按钮（如 `trailingAction`、`footer` 插槽），但 `KeyboardNavEngine` 仅仅将条目本身（`.sep-item`）加入漫游数组。
  对于纯键盘用户（无法使用鼠标悬停的用户），**这些放置在右侧的删除、终止、重命名等次级动作按钮是绝对不可达的（Keyboard Unreachable）**，直接剥夺了全键盘用户的关键业务操作权。

### 3.5 Select/Combobox 场景硬编码 `role="menu"` 造成的严重 ARIA 规范违规
- **缺陷定位**：`01-foundation-adapters-plan.md:1683`、`2043-2047`（`SelectAdapter.tsx`）。
- **ARIA 契约撕裂**：
  在 `SelectAdapter.tsx` 中，触发按钮声明了：
  ```html
  <button role="combobox" aria-haspopup="listbox" aria-controls="ui-select-listbox-xxx">
  ```
  然而在 `SmartExpandablePanel.tsx:1683` 中，浮层容器被**写死硬编码**为：
  ```html
  <div ref={listRef} className={styles.listContainer} role="menu">
  ```
  `role="combobox"` 关联了一个 `role="menu"` 容器！这在 WAI-ARIA 规范中属于**非法语义拓扑（Illegal Semantic Hierarchy）**。屏幕阅读器（NVDA / VoiceOver）会发出混乱的播报，无法正确识别为选项列表（`listbox`）与条目（`option`），单元测试与无障碍合规审计将直接亮红灯。

---

## 四、滚轮穿透隔离（Wheel Isolation）伪实现与分屏手势冲突

### 4.1 React 合成事件 `stopPropagation` 无法阻断原生滚动的伪隔离
- **缺陷定位**：`01-foundation-adapters-plan.md:1588-1599`。
- **代码审查**：
  ```typescript
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    ...
    if (isAtTop || isAtBottom) {
      e.stopPropagation(); // 致命错误：合成事件拦截不了原生视口滚动！
    }
  };
  ```
- **底层机制真相**：
  在现代浏览器及 WebView2 中，滚轮滚动（Chained Scrolling）是在**原生 DOM 默认行为层面**触发的。
  React 的 `onWheel` 是在 `document` 根节点捕获的合成事件。调用 `e.stopPropagation()` 仅仅阻止了 React 事件树的冒泡，**根本无法阻止浏览器的默认滚动链（Default Scroll Action）**！
  要真正阻断滚轮穿透，必须在原生 DOM 元素上挂载 `{ passive: false }` 的原生事件监听器，并在边界条件下显式调用原生 **`e.preventDefault()`**。方案给出的代码完全是无效的假隔离。

### 4.2 短列表（`scrollHeight <= clientHeight`）全方向滚轮误杀与高分屏浮点精度失效
- **缺陷定位**：`00-total-migration-plan.md:561-563`、`01-foundation-adapters-plan.md:1593-1595`。
- **逻辑与数学缺陷**：
  1. **短列表误杀**：当菜单只有 2~3 项（如 `ChatHeaderMore` 或小权限菜单），内容没有溢出，此时 `scrollTop === 0` 恒成立，且 `scrollTop + clientHeight >= scrollHeight - 1` 也恒成立。如果按照方案逻辑阻止滚动，用户光标只要悬停在菜单上方，**向上或向下的一切滚轮操作将被全部死锁**；
  2. **高分屏浮点精度失效**：在 Windows 125%/150% DPI 缩放或 Mac Retina 屏下，`scrollTop` 是非整数（例如 `0.4000000059604645px`）。代码使用 `scrollTop === 0` 进行硬等值比对，导致在 High-DPI 环境下向上滚动到顶时，`isAtTop` 判定**永远为 `false`**，滚轮穿透隔离在高清屏幕上直接失效。

### 4.3 分屏拖拽（Sash Dragging）与跨窗格 PointerDown 捕获的事件踩踏
- **缺陷定位**：`05-sidebar-files-diff-plan.md:209-221`、`03-headers-workspace-plan.md:61-70`。
- **手势冲突场景**：
  在 Crish 桌面端分屏工作区中，当左侧面板处于展开状态时，若用户直接在右侧分屏的编辑器内点击，或者按住两屏中间的分割线（Splitter Sash）开始快速拖拽调整分屏宽度：
  1. `SmartExpandablePanel` 内部的 Outside Click 监听若使用捕获阶段（Capture Phase）拦截 `pointerdown`，会强行吃掉拖拽起始事件，导致分屏拖拽**首击失效（First-click Drop）**；
  2. 若未拦截，分屏宽度瞬间缩窄，而浮层由于没有 120Hz 跟随机制，会悬挂在错误的分屏边界之外，遮挡右侧正在编辑的代码。

---

## 五、退避简化倾向审查与跨文档口径严重自相矛盾

### 5.1 核心算法简写退避：用单层玩具 Demo 替代工业级状态机
- **退避表现**：
  方案在文档愿景中使用了大量“工业级”、“零 Canvas”、“120Hz 物理引擎”等高大上词汇，但落到核心 TypeScript 代码时：
  1. `SafeAimEngine` 砍掉了多级嵌套栈支持（降级为单级）；
  2. `SafeAimEngine` 砍掉了速度矢量方向判定（降级为纯静态三角）；
  3. `PositionEngine` 砍掉了 RAF 循环与 Observer 监听（降级为一次性计算）；
  4. `keyboardNav` 砍掉了 Tab 键拦截与 Focus Trap（降级为简单的 keydown 遍历）。
  这是非常典型的**“规划写满分、实现砍一半”的退避式设计**，严重违背 `.agents/LOGIC_PLAN_NO_RETREAT.md` 的纯逻辑反退避铁律。

### 5.2 异步文件目录加载引发的浮层高度剧烈抖动与搜索闪烁（FileBreadcrumb）
- **缺陷定位**：`05-sidebar-files-diff-plan.md:714-746`。
- **状态流转漏洞**：
  ```typescript
  const loadDir = useCallback(async (dirPath: string, label: string) => {
    setActiveFlyoutDir({ path: dirPath, label, entries: [], loading: true }); // entries 瞬间清空！
    try {
      const list = await listDirectory(...);
      setActiveFlyoutDir({ ..., entries: list, loading: false });
    } ...
  });
  ```
  当用户在文件面包屑中点击下级目录时，代码立即将 `entries` 设为空数组。
  此时 `panelItems` 瞬间变为空，面板立刻渲染 `未找到匹配结果 🔍`，面板物理高度由 300px 瞬间塌缩至 40px；等 `listDirectory` 异步返回后，高度又猛烈弹开至 300px。
  这种**“高度塌缩 -> 暴弹”的剧烈视觉闪烁（Layout Jitter）**不仅极其破坏质感，而且会导致处于底部的鼠标位置瞬间脱离面板，触发外层关闭。

### 5.3 跨文档 Token 消费口径自相矛盾（禁消费 `--sidebar-hover` 与代码内反向引入）
- **严重口径冲突证据**：
  1. **总方案铁律（`00-total-migration-plan.md:281`）**：
     > “【强制红线铁律】：严禁在白底浮层中直接消费 `--sidebar-hover` / `--sidebar-active`！”
  2. **总方案反向违规（`00-total-migration-plan.md:803`）**：
     > “条目锁定为 6px，悬停淡入 `var(--sidebar-hover)`，选中态为 `var(--sidebar-active)`”
  3. **分方案 02 违规（`02-composer-chat-plan.md:296-302`）**：
     > `.plusBtn:hover { background: var(--sidebar-hover); }`  
     > `.plusBtn.isOpen { background: var(--sidebar-active); }`
  4. **分方案 02 违规（`02-composer-chat-plan.md:346-352`）**：
     > `.permPill.iconOnly:hover { background: var(--sidebar-hover); }`
- **审查裁决**：
  文档作者在前面大篇幅论证了彩色皮肤下 `--sidebar-hover` 会在白底浮层产生 20%~30% 泥灰脏色块，并在第 4 节设立红线，却在第 6 节及后续各分方案的 CSS 规范中随手复制粘贴 `var(--sidebar-hover)`！必须全面纠正，统一收敛为 `--sep-bg-item-hover`。

### 5.4 IME 输入法组合态（Composition Session）拦截缺失
- **缺陷定位**：`02-composer-chat-plan.md:783-800`（`TiptapSlashMenu`）、`01-foundation-adapters-plan.md:981-995`。
- **交互漏洞**：
  当用户在内嵌搜索框或输入区使用中文/日文输入法（IME）打字时，按 `Enter` 键确认拼音上屏，或者按 `Space` 键选词，`keyboardNav.onKeyDown` 未检测 `e.isComposing` / `e.keyCode === 229`。
  这会导致输入法确认拼音的同时，**直接触发了菜单第一项的选中执行（Accidental Form Submit）**，输入法上屏与菜单选择同时发生，造成严重数据污染。

---

## 六、魔鬼审查修复整改指令清单

为确保移植方案具备真正工业级的稳定性，必须在实施前对全部 6 份方案文件进行针对性补充与修正，执行以下铁律整改：

| 序号 | 漏洞模块 | 必须落地的强制整改要求（Non-Negotiable） | 目标文件 |
| :--- | :--- | :--- | :--- |
| **R1** | `SafeAimEngine` | 1. 引入 `activeSubmenuStack` 栈式管理，支持 $\ge 3$ 级级联保护；<br>2. 增加光标运动方向向量夹角判定（$\vec{v} \cdot \vec{d} > 0$），反向移动时立即失效；<br>3. 增加 300ms 安全超时（Safety Timeout）熔断机制，光标停滞时自动释放悬停锁；<br>4. 废除硬编码全局 ID 单例，改为基于 React Context 或容器绑定的独立实例隔离。 | `01-foundation-adapters-plan.md`<br>`00-total-migration-plan.md` |
| **R2** | `PositionEngine` | 1. 重构 Hysteresis 算术模型：当滞后方向可用空间小于面板最小保证高度（`minHeight: 180px`）时，强制解除滞后锁并向空间充足方向翻转，绝对禁止覆盖触发器；<br>2. 接入真正的 `ResizeObserver` 与全局 `scroll`/`resize` 监听，使用 RAF 节流调度实现真正的 120Hz 窗口跟随；<br>3. 彻底移除 `measureNaturalHeight` 中的 DOM 读写交替，改用克隆脱标测量或 `getBoundingClientRect` 纯读缓存；<br>4. 二级子菜单水平翻转增加双向视口约束与最小错位偏移（Offset Stagger），杜绝 100% 重叠覆盖父级。 | `01-foundation-adapters-plan.md`<br>`00-total-migration-plan.md` |
| **R3** | `keyboardNav` & ARIA | 1. 修复搜索框焦点流：`ArrowDown` 从 Input 进入首项，首项按 `ArrowUp` 必须精准回弹回 Input，并保留输入光标；<br>2. 补齐 `Tab` / `Shift+Tab` 键的 Focus Trap 循环焦点锁定，防止焦点逃逸 Portal；<br>3. 过滤手风琴隐藏项：仅在 `collapsible.expanded === true` 时才将子节点计入可漫游项；<br>4. 统一无障碍契约：为 `SelectAdapter` 动态注入 `role="listbox"` / `role="option"`，杜绝非法 Combobox-Menu 嵌套；<br>5. 为 `trailingAction` 次级按钮提供行内快捷键（如 `Delete` / `Backspace`）或二级焦点遍历。 | `01-foundation-adapters-plan.md`<br>`02-composer-chat-plan.md`<br>`03-headers-workspace-plan.md` |
| **R4** | Wheel Isolation | 1. 废除 React 合成事件 `stopPropagation` 伪实现，改用原生挂载 `{ passive: false }` 的 `wheel` 监听并调用原生 `e.preventDefault()`；<br>2. 修复短列表误杀：仅当 `scrollHeight > clientHeight` 存在真实溢出时才启动隔离；<br>3. 修复浮点精度：采用 `scrollTop <= 0.5` 与 `scrollTop + clientHeight >= scrollHeight - 0.5` 兼容 High-DPI 缩放；<br>4. 优化 Outside Click 优先级，确保分屏拖拽 Sash 与跨窗格首击不被吞并。 | `01-foundation-adapters-plan.md`<br>`05-sidebar-files-diff-plan.md` |
| **R5** | 规范与口径对齐 | 1. 彻底清剿全仓方案中残留的 `var(--sidebar-hover)` / `var(--sidebar-active)`，一律纠正为专属 `--sep-bg-item-hover` / `--sep-bg-item-selected`；<br>2. 在所有键盘事件与搜索输入拦截中，强制加入 `e.nativeEvent.isComposing` / `keyCode === 229` 检查，彻底阻断 IME 拼音确认误触；<br>3. 为 `FileBreadcrumb` 引入骨架占位（Skeleton/Keep-Previous）机制，异步加载下级目录时维持面板高度，消灭剧烈塌缩弹跳。 | 全量 6 份方案文件 |

---
*本审查报告由交互状态机、Safe-Aim 算法与无障碍防退避审查专家完成，所有缺陷与指令均基于严格的数学几何计算、DOM 规范与无障碍基准，严禁降级或退避。*
