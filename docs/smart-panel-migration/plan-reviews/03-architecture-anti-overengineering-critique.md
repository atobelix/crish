# Conex / Crish — SmartExpandablePanel 移植方案架构解耦、反过度设计与测试回归审查报告

> **文档标识**：`docs/smart-panel-migration/plan-reviews/03-architecture-anti-overengineering-critique.md`  
> **审查性质**：极度严苛的架构解耦、反过度设计与测试回归专家审查（Architecture & Anti-Overengineering Devil Review）  
> **审查对象**：  
> - `docs/smart-panel-migration/00-total-migration-plan.md`  
> - `docs/smart-panel-migration/independent-plans/01-foundation-adapters-plan.md`  
> - `docs/smart-panel-migration/independent-plans/02-composer-chat-plan.md`  
> - `docs/smart-panel-migration/independent-plans/03-headers-workspace-plan.md`  
> - `docs/smart-panel-migration/independent-plans/04-settings-forms-plan.md`  
> - `docs/smart-panel-migration/independent-plans/05-sidebar-files-diff-plan.md`  
> **权威红线**：`AGENTS.md`（反退避铁律、严禁打补丁、测试资产保护）、`ANTI_OVERENGINEERING_GUARDRAILS.md`（13 项硬性禁令）  
> **审查基调**：**严禁任何褒奖、赞美与肯定性废话，通篇 100% 只说问题、缺陷、遗漏、模糊描述与潜在漏洞，直击架构断层！**

---

## 目录索引

- [一、反过度设计红线审查（对照 13 项禁令）](#一反过度设计红线审查对照-13-项禁令)
  - [1.1 违规点 1：自研 JS 视口解算抛弃成熟 Popper 避让，引入强制回流（违反禁令 11 / 12）](#11-违规点-1自研-js-视口解算抛弃成熟-popper-避让引入强制回流违反禁令-11--12)
  - [1.2 违规点 2：全局单例 SVG SafeAim 遮罩污染与常驻全局事件泄露（违反禁令 7 / 12）](#12-违规点-2全局单例-svg-safeaim-遮罩污染与常驻全局事件泄露违反禁令-7--12)
  - [1.3 违规点 3：虚假双轨适配器与 4~5 层过度包装套娃（违反禁令 11）](#13-违规点-3虚假双轨适配器与-45-层过度包装套娃违反禁令-11)
- [二、800+ 单元测试致命回归隐患审查（代码级定罪）](#二800-单元测试致命回归隐患审查代码级定罪)
  - [2.1 隐患 1：`Menu.test.tsx` 触发器克隆与挂载时序断裂，初始坐标归零 (0,0) 红灯](#21-隐患-1menutesttsx-触发器克隆与挂载时序断裂初始坐标归零-00-红灯)
  - [2.2 隐患 2：children 模式 `role="menu"` 容器属性丢失，`findByRole` 全线崩溃](#22-隐患-2children-模式-rolemenu-容器属性丢失findbyrole-全线崩溃)
  - [2.3 隐患 3：CSS Modules 类名契约私自变更，`menuItemDisabled` / `menuItemDanger` 断言全崩](#23-隐患-3css-modules-类名契约私自变更menuitemdisabled--menuitemdanger-断言全崩)
  - [2.4 隐患 4：`SelectAdapter` 颠覆 WAI-ARIA `combobox -> listbox -> option` 树形拓扑](#24-隐患-4selectadapter-颠覆-wai-aria-combobox---listbox---option-树形拓扑)
  - [2.5 隐患 5：`DialogOverlayContext` 消费完全遗漏，Dialog 模态层叠穿透沦陷](#25-隐患-5dialogoverlaycontext-消费完全遗漏dialog-模态层叠穿透沦陷)
  - [2.6 隐患 6：`onSelect` 回调签名参数类型与顺序不兼容引发业务静默故障](#26-隐患-6onselect-回调签名参数类型与顺序不兼容引发业务静默故障)
- [三、单文件行数与模块膨胀风险（对照 §11 行数门禁）](#三单文件行数与模块膨胀风险对照-11-行数门禁)
  - [3.1 膨胀风险 1：`SmartExpandablePanel.tsx` 职责严重过载必破 500 行 UI 门禁](#31-膨胀风险-1smartexpandablepaneltsx-职责严重过载必破-500-行-ui-门禁)
  - [3.2 膨胀风险 2：`PositionEngine.ts` 未拆分几何测量与布局决策必破 400 行逻辑门禁](#32-膨胀风险-2positionenginets-未拆分几何测量与布局决策必破-400-行逻辑门禁)
  - [3.3 膨胀风险 3：业务组件文件未物理剥离 Schema 树导致上帝组件回潮](#33-膨胀风险-3业务组件文件未物理剥离-schema-树导致上帝组件回潮)
- [四、性能与 144Hz 渲染开销深度质询（掉帧与布局抖动）](#四性能与-144hz-渲染开销深度质询掉帧与布局抖动)
  - [4.1 性能毒点 1：`measureNaturalHeight` 强制触发浏览器同步回流（Layout Thrashing）](#41-性能毒点-1measurenaturalheight-强制触发浏览器同步回流layout-thrashing)
  - [4.2 性能毒点 2：内联 options 浅比较失效导致每帧全量重构 Schema 树与 Hook 实例重建](#42-性能毒点-2内联-options-浅比较失效导致每帧全量重构-schema-树与-hook-实例重建)
  - [4.3 性能毒点 3：搜索过滤大列表无防抖且 O(N) 字符串重复拼接](#43-性能毒点-3搜索过滤大列表无防抖且-on-字符串重复拼接)
- [五、各分维方案（02 ~ 05）专项缺陷与遗漏挑刺](#五各分维方案02--05专项缺陷与遗漏挑刺)
  - [5.1 方案 02（对话流与输入区）：`PermissionModeMenu` 换汤不换药与胶囊双重焦点环冲突](#51-方案-02对话流与输入区permissionmodemenu-换汤不换药与胶囊双重焦点环冲突)
  - [5.2 方案 03（顶栏与工作区）：`ProjectPickerMenu` 尾部操作冒泡误切项目与空态浮层残留](#52-方案-03顶栏与工作区projectpickermenu-尾部操作冒泡误切项目与空态浮层残留)
  - [5.3 方案 04（设置与表单）：`FontSelectField` 顶置输入框回车键劫持与国际化时间戳溢出](#53-方案-04设置与表单fontselectfield-顶置输入框回车键劫持与国际化时间戳溢出)
  - [5.4 方案 05（侧边栏与差异）：`FileBreadcrumb` 异步加载高度塌陷与右键浮层重构开销](#54-方案-05侧边栏与差异filebreadcrumb-异步加载高度塌陷与右键浮层重构开销)
- [六、魔鬼用例（Devil Test Cases）防御清单](#六魔鬼用例devil-test-cases防御清单)
- [七、架构修正与重构强制改进要求（整改验收标准）](#七架构修正与重构强制改进要求整改验收标准)

---

## 一、反过度设计红线审查（对照 13 项禁令）

### 1.1 违规点 1：自研 JS 视口解算抛弃成熟 Popper 避让，引入强制回流（违反禁令 11 / 12）

- **违规定位**：`00-total-migration-plan.md` §5.1 与 `01-foundation-adapters-plan.md` §4.2 (`PositionEngine.ts`)。
- **缺陷剖析**：
  1. 项目既有依赖中已引入高度成熟的 `@radix-ui/react-popover` 与 `@floating-ui/react`，原生具备极其健壮的碰撞检测、翻转（`flip`）、偏移（`shift`）与虚拟锚点能力。
  2. 方案 01 抛弃现成底层 Popper 引擎，在 TypeScript 中自建 240+ 行 `PositionEngine.ts`，手动通过 `getBoundingClientRect()`、`getComputedStyle()`、`offsetHeight`、`scrollHeight` 计算浮层坐标，属于典型的**「重新发明有缺陷的轮子（Overengineered Reinvention）」**。
  3. 违反 **禁令 11（同进程虚假解耦与过度复杂分层）** 与 **禁令 12（交互高频状态穿透与主线程阻塞）**：自研引擎不仅在多显示器 DPI 缩放、极窄分屏及滚动容器嵌套时漏洞百出，还在运行时频繁引发强制同步排版（Layout Thrashing），给 144Hz 桌面渲染带来巨大隐患。

### 1.2 违规点 2：全局单例 SVG SafeAim 遮罩污染与常驻全局事件泄露（违反禁令 7 / 12）

- **违规定位**：`01-foundation-adapters-plan.md` §4.3 (`SafeAimEngine.ts:673-701`)。
- **缺陷剖析**：
  1. `SafeAimEngine` 在构造函数中直接向 `document.body` 注入全局唯一的 `<svg id="sepSafeAimOverlay">`，并无条件注册 `window.addEventListener('mousemove', ...)`。
  2. **事件泄露与性能浪费**：即便应用处于无任何菜单打开的静默期，全局鼠标移动仍以高频触发 `mouseHistory.push()` 与滑动窗口裁剪，严重违背 **禁令 12**。
  3. **单例冲突与 DOM 竞争**：在多窗口、多分屏或父子嵌套浮层场景下，多个 `SafeAimEngine` 实例竞争抢夺同一个 `#sepSafeAimOverlay` 节点；当其中一个实例被 React 卸载并调用 `destroy()` 时，会将整个全局 SVG 节点从 `document.body` 暴力移除，导致其余正在展示的级联菜单的 Safe-Aim 保护区瞬间蒸发！
  4. 违反 **禁令 7（单一真相源与上下文可追踪）**：全局隐式单例与局部 React 组件生命周期完全脱节。

### 1.3 违规点 3：虚假双轨适配器与 4~5 层过度包装套娃（违反禁令 11）

- **违规定位**：`00-total-migration-plan.md` §7.1 与 `01-foundation-adapters-plan.md` §5.2 (`MenuAdapter.tsx`)。
- **缺陷剖析**：
  1. `MenuAdapter.tsx` 表面宣称“双轨无损适配”，实则在 Radix `Menu`、`MenuAdapter`、`SmartExpandablePanel`、`PositionEngine`、`SafeAimEngine` 与 `keyboardNav` 之间构建了多达 **5 层嵌套代理**。
  2. `MenuAdapter` 内部既试图使用 Radix 的 `<Popover.Anchor>`，又同时调用 `SmartExpandablePanel` 的自研 `createPortal`，导致底层产生了**两套相互冲突的定位与销毁状态机**（Radix DismissableLayer vs LayerStackManager vs SmartExpandablePanel onClose）。
  3. 违反 **禁令 11（严禁 4~5 层逐级转发的虚假 Store/Service Facade）**：过度抽象不仅没有简化调用，反而让事件拦截、焦点还原与手势时序变得极难追踪和调试。

---

## 二、800+ 单元测试致命回归隐患审查（代码级定罪）

### 2.1 隐患 1：`Menu.test.tsx` 触发器克隆与挂载时序断裂，初始坐标归零 (0,0) 红灯

- **违规定位**：`01-foundation-adapters-plan.md` §5.2 (`MenuAdapter.tsx:1918-1934`) 与 `apps/crish-desktop/src/components/ui/Menu/Menu.test.tsx:54-64, 213-228`。
- **致命断层**：
  1. `Menu.test.tsx` 中大量用例采用 `<Menu trigger={<button>触发器</button>} ... />` 模式。
  2. 在 `MenuAdapter.tsx` 中，触发器的 ref 绑定在 `clonedTrigger` 的 `ref` 回调上；然而在首次渲染周期中，`clonedTrigger` 尚未完成真实 DOM 挂载时，`MenuAdapter` 就已经将 `anchor ?? triggerRef` 传递给了 `<SmartExpandablePanel triggerRef={...} />`。
  3. `SmartExpandablePanel` 的 `useEffect` 在 `open` 为 `true` 时立即执行 `updatePosition()`。此时 `triggerRef.current` 为 `null`，`calculateTriggerPosition` 根本无法获取 `getBoundingClientRect()`，直接放弃计算或将浮层钉在屏幕左上角 `(0, 0)`！
  4. 原版 `Menu.tsx` 依赖 Radix Popper 的 `asChild` 自动测量挂载生命周期，而 `MenuAdapter` 的手动解耦直接打破了这一时序，导致全部基于 trigger 的测试直接红灯！

### 2.2 隐患 2：children 模式 `role="menu"` 容器属性丢失，`findByRole` 全线崩溃

- **违规定位**：`01-foundation-adapters-plan.md` §4.7 (`SmartExpandablePanel.tsx:1678-1683`) 与 `apps/crish-desktop/src/components/ui/Menu/Menu.test.tsx:137, 164, 178, 243, 287`。
- **致命断层**：
  1. 查看方案 01 源码实现：
     ```tsx
     {children != null ? (
       <div ref={listRef} className={styles.listContainer}>
         {children}
       </div>
     ) : (
       <div ref={listRef} className={styles.listContainer} role="menu">
         ...
       </div>
     )}
     ```
  2. 当使用 `children` 模式（如自定义菜单项、`Select` 下拉选项列表）时，外层容器**被漏掉了 `role="menu"` 属性**！
  3. 既有测试套件 `Menu.test.tsx` 与 `Select.test.tsx` 中大量断言（如 `await screen.findByRole('menu')`、`expect(screen.queryByRole('menu')).not.toBeInTheDocument()`）在执行时将立即抛出 `Unable to find an accessible element with the role "menu"` 致命异常，测试 100% 暴毙！

### 2.3 隐患 3：CSS Modules 类名契约私自变更，`menuItemDisabled` / `menuItemDanger` 断言全崩

- **违规定位**：`01-foundation-adapters-plan.md` §4.6 (`SmartExpandablePanel.module.css:1311-1325`) 与 `apps/crish-desktop/src/components/ui/Menu/Menu.test.tsx:94-96`。
- **致命断层**：
  1. `Menu.test.tsx` 第 94–96 行存在显式强断言：
     ```typescript
     expect(disabled).toHaveClass(styles.menuItemDisabled);
     expect(danger).toHaveClass(styles.menuItemDanger);
     ```
  2. 方案 01 在重构 `SmartExpandablePanel.module.css` 时，擅自将类名改为 `.disabled` 和 `.danger`，并且完全没有在 `styles` 导出中提供 `menuItemDisabled` 与 `menuItemDanger` 的向后兼容别名。
  3. 存量测试在引用 `styles.menuItemDisabled` 时得到 `undefined`，直接触发断言失败！

### 2.4 隐患 4：`SelectAdapter` 颠覆 WAI-ARIA `combobox -> listbox -> option` 树形拓扑

- **违规定位**：`01-foundation-adapters-plan.md` §5.3 (`SelectAdapter.tsx:2059-2065`) 与 `apps/crish-desktop/src/components/ui/Select/Select.test.tsx`。
- **致命断层**：
  1. WAI-ARIA 规范与既有 `Select.tsx` 严格要求：触发器为 `role="combobox"`，浮层容器必须为 `role="listbox"`，选项必须为 `role="option"`，且带有 `aria-selected`。
  2. `SelectAdapter.tsx` 直接将选项转换为 `MenuItem[]` 丢给 `SmartExpandablePanel`，而 `SmartExpandablePanel` 容器固定写死 `role="menu"`，条目渲染为 `role="menuitem"`。
  3. 这将原有的 `listbox` 语义篡改为 `menu` 语义，导致 `Select.test.tsx` 中所有针对 `findByRole('listbox')`、`findAllByRole('option')`、`aria-selected` 的无障碍断言全线红灯！

### 2.5 隐患 5：`DialogOverlayContext` 消费完全遗漏，Dialog 模态层叠穿透沦陷

- **违规定位**：`01-foundation-adapters-plan.md` §4.7 (`SmartExpandablePanel.tsx:1624-1627`) 与 `apps/crish-desktop/src/components/ui/Menu/Menu.test.tsx:325-343`。
- **致命断层**：
  1. `Menu.test.tsx` 第 325–343 行核心用例断言：`Dialog 内 Menu portal 进 overlay，不挂 body（设置壳 z 压不住下拉）`。
  2. 方案 01 的 `SmartExpandablePanel.tsx` 根本没有调用 `useContext(DialogOverlayContext)`，仅简单判断 `const targetContainer = container || document.body;`。
  3. 当在 `Dialog`、`ConfirmDialog` 或 `SettingsModal` 内部展开任何下拉菜单时，菜单被错误挂载在 `document.body` 根节点，直接被 `Dialog` 的高层级遮罩阻断，测试 `expect(overlay?.contains(item)).toBe(true)` 必定失败，且真实 UI 中菜单将完全不可交互！

### 2.6 隐患 6：`onSelect` 回调签名参数类型与顺序不兼容引发业务静默故障

- **违规定位**：`00-total-migration-plan.md` §6.1 (`types.ts:620`) vs 既有 `Menu/types.ts`。
- **致命断层**：
  1. 既有 `MenuProps.onSelect` 签名：`(id: string, option: SelectOptionItem) => void`（第 1 参数为字符串 ID，第 2 参数为选项对象）。
  2. 新契约 `SmartPanelProps.onSelect` 签名：`(item: MenuItem) => void`（第 1 参数为对象）。
  3. 在直接将业务模块（如 `ProjectPickerMenu`、`ChatHeaderMore`、`SessionContextMenu`）重构为 `SmartExpandablePanel` 时，若旧业务消费方仍按 `(id, item)` 传参，其业务逻辑接收到的 `id` 实际上是整个 `MenuItem` 对象（`typeof id === 'object'`），导致所有 `switch(id)`、`id.startsWith()` 或 API 传参全部发生运行时 TypeError 或静默失败！

---

## 三、单文件行数与模块膨胀风险（对照 §11 行数门禁）

### 3.1 膨胀风险 1：`SmartExpandablePanel.tsx` 职责严重过载必破 500 行 UI 门禁

- **违规定位**：`01-foundation-adapters-plan.md` §4.7。
- **风险分析**：
  1. `SmartExpandablePanel.tsx` 目前单文件集成了：React Portal 逃逸、内嵌搜索状态、实时关键词过滤、二级子菜单状态、SafeAim 事件联动、KeyboardNav 事件分发、滚轮穿透隔离（Wheel Isolation）、Header/Footer 渲染与手风琴折叠。
  2. 方案中的骨架代码已达 330 行。一旦补齐缺失的 `DialogOverlayContext` 水合、React 19 安全克隆、错误边界（Error Boundary）与无障碍属性映射，该文件代码行数将**迅速飙升至 580+ 行**，严重违反 `AGENTS.md` §11 的「UI 组件单文件不得超过 500 行」硬性门禁！
  3. **改进要求**：必须立即将搜索 Header、内嵌滚动 List、二级子菜单 Portal 剥离为子组件，主文件仅保留拓扑装配逻辑。

### 3.2 膨胀风险 2：`PositionEngine.ts` 未拆分几何测量与布局决策必破 400 行逻辑门禁

- **违规定位**：`01-foundation-adapters-plan.md` §4.2。
- **风险分析**：
  1. `PositionEngine.ts` 当前包含 240 行，内部同时承载了自然高度 DOM 度量（`measureNaturalHeight`）、触发器锚点定位（`calculateTriggerPosition`）、绝对坐标点定位（`calculatePointPosition`）、二级子菜单翻转（`calculateSubmenuPosition`）与滞后防抖状态机。
  2. 随着高分屏 DPI 亚像素补偿与双向视口刚性钳位（Clamp）补齐，纯逻辑行数将突破 420 行，违反「业务逻辑单文件不得超过 400 行」门禁。
  3. **改进要求**：将 DOM 高度度量工具（`measureDom.ts`）与定位决策器（`calculatePlacement.ts`）解耦分立。

### 3.3 膨胀风险 3：业务组件文件未物理剥离 Schema 树导致上帝组件回潮

- **违规定位**：`02-composer-chat-plan.md`、`03-headers-workspace-plan.md`。
- **风险分析**：
  1. `ProjectPickerMenu.tsx`（原 417 行）、`ChatComposer.tsx`、`PermissionModeMenu.tsx` 等组件在重构方案中，将庞大的 Schema 数据构造函数（如 `buildModelPickerSchema`、`buildPermissionModeSchema`、大量图标与文案映射字典）直接堆放在组件文件内部。
  2. 这种写法导致 UI 视图逻辑与静态元数据高度耦合，单文件行数直逼 450~500 行，极易引发上帝组件（God Component）回潮。
  3. **改进要求**：强制要求所有业务模块将 Schema 构造与静态元数据物理剥离至同目录下的 `*Schema.ts` 纯函数文件中。

---

## 四、性能与 144Hz 渲染开销深度质询（掉帧与布局抖动）

### 4.1 性能毒点 1：`measureNaturalHeight` 强制触发浏览器同步回流（Layout Thrashing）

- **违规定位**：`00-total-migration-plan.md` §5.1 (`PositionEngine.ts:511-536`)。
- **代码级定罪**：
  ```typescript
  // 致命性能毒点：强制同步排版与样式重计算
  listEl.style.maxHeight = 'none';
  listEl.style.overflow = 'visible';
  const listScrollHeight = listEl.scrollHeight; // 🔴 触发 Reflow 1
  const panelStyle = window.getComputedStyle(panelEl); // 🔴 触发 Reflow 2
  const paddingTop = parseFloat(panelStyle.paddingTop) || 6;
  // ...
  listEl.style.maxHeight = prevMaxHeight; // 🔴 再次写 DOM 导致脏布局
  listEl.style.overflow = prevOverflow;
  ```
- **灾难推导**：
  当面板打开、窗口尺寸变化或列表动态增减项时，该函数在同一帧内连续执行「写样式 -> 读布局 -> 读样式 -> 写样式」，直接摧毁现代浏览器的异步批处理排版机制。在 144Hz 高刷屏或快速拖拽窗口时，主线程将产生高达 20ms~40ms 的卡顿掉帧！

### 4.2 性能毒点 2：内联 options 浅比较失效导致每帧全量重构 Schema 树与 Hook 实例重建

- **违规定位**：`01-foundation-adapters-plan.md` §5.2 (`MenuAdapter.tsx:1910-1912`)。
- **缺陷剖析**：
  1. 大量业务消费方（如 `ChatHeaderMore`、`SettingsRulesTab`）在 render 中传入内联 options（如 `options={[...]}`）。
  2. `MenuAdapter` 中 `useMemo(() => convertMenuOptionsToSmartItems(options), [options])` 浅比较失效，导致每一次父组件渲染都会生成全新的 `smartItems` 数组，且为每个项创建新的 `onSelect` 闭包。
  3. 传递给 `SmartExpandablePanel` 的 `items` 引用变化，连锁触发内部 `filteredItems` 的 `useMemo` 全量重算，以及 `keyboardNavEngine` 的全量重建与重新 `attach` 事件！
  4. 在用户在输入框（`ChatComposer`）高频打字时，输入流驱动的每一次渲染都会导致浮层底层状态机疯狂自我重构，CPU 占用率飙升。

### 4.3 性能毒点 3：搜索过滤大列表无防抖且 O(N) 字符串重复拼接

- **违规定位**：`01-foundation-adapters-plan.md` §4.7 (`SmartExpandablePanel.tsx:1601-1620`)。
- **缺陷剖析**：
  1. 搜索框 `onChange` 直接驱动 `query` 状态，触发 `filteredItems` 的即时同步计算。
  2. 过滤函数对每个条目均无缓存地执行 `${node.label || ''} ${node.sublabel || ''} ${node.searchKeywords || ''}` 字符串动态拼接与 `toLowerCase()`。
  3. 在长文件列表（`FileBreadcrumb` > 500 项）或复杂服务商/模型列表中，快速输入字符将导致主线程发生明显的按键响应延迟。

---

## 五、各分维方案（02 ~ 05）专项缺陷与遗漏挑刺

### 5.1 方案 02（对话流与输入区）：`PermissionModeMenu` 换汤不换药与胶囊双重焦点环冲突

1. **违规换汤不换药**：
   - `02-composer-chat-plan.md` §6.2 的 Diff 规划中，`PermissionModeMenu` 依然在使用旧版 `Menu` 并通过 `renderItem` 手写 `<button className={styles.permMenuItem}>`，根本没有真正接入 `SmartExpandablePanel` 的标准数据驱动体系！方案口径与总方案彻底脱节！
2. **胶囊双重焦点环撕裂**：
   - `ComposerFusedTrigger` 在 `:focus-within` 下定义了外层高亮边框，而左侧 `ModelBadgePicker` 与右侧 `thinkBtn` 在键盘 Tab 聚焦时又会触发浏览器原生或内层的 `:focus-visible`，导致胶囊上出现一内一外两个重叠错位的激活框，严重破坏视觉一致性。

### 5.2 方案 03（顶栏与工作区）：`ProjectPickerMenu` 尾部操作冒泡误切项目与空态浮层残留

1. **尾部删除操作事件冒泡致命 Bug**：
   - `03-headers-workspace-plan.md` §2.4 中为项目条目增加了 `trailingAction`（垃圾桶删除按钮）。
   - 该按钮虽在内联 `onClick` 处写了 `e.stopPropagation()`，但 `MenuItemRow` 外层容器使用的是 `onClick` 触发 `item.onSelect?.()`。在某些浏览器合成事件时序下，点击删除按钮依然会冒泡触发外层项目的 `pickProject(p.id)`，导致用户本意是“删除项目”，却在弹出确认框的同时意外打开并切换了该项目！
2. **`LeafToolTabStrip` 满占态残留空浮层**：
   - 方案未处理 Tab 被全部打开瞬间的状态同步：当用户打开最后一个可用工具时，加号面板未声明主动关闭逻辑，导致一个空无一物的死白面板悬挂在界面上。

### 5.3 方案 04（设置与表单）：`FontSelectField` 顶置输入框回车键劫持与国际化时间戳溢出

1. **回车键交互死锁冲突**：
   - `04-settings-forms-plan.md` §4.1 将自定义字体输入框顶置在 `.sepSearchWrapper`。
   - 当用户在输入框输入自定义字体并按下 `Enter` 期望提交时，`KeyboardNavEngine` 在捕获阶段拦截了 `Enter` 键，并将其解释为“选中当前高亮的列表项”，直接覆盖了用户的自定义输入！
2. **Grid 列宽写死导致多语言时间戳截断**：
   - `StatusDiagnosticsPanel` 将栅格写死为 `grid-template-columns: 72px 150px 1fr`。在不同系统语言或长格式时间戳（如 `Aug 20, 2026, 04:21:57 PM` 耗宽约 190px）下，时间戳直接被 `150px` 强制截断，换行或溢出。

### 5.4 方案 05（侧边栏与差异）：`FileBreadcrumb` 异步加载高度塌陷与右键浮层重构开销

1. **异步加载高度剧烈跳闪**：
   - `05-sidebar-files-diff-plan.md` §5.1 中，`FileBreadcrumb` 点击面包屑时先将 `entries` 置空（`loading: true`），异步获取列表后再填入 `items`。
   - 这导致浮层在弹出瞬间高度塌陷为 0px（或仅剩搜索框 38px），数据返回后瞬间暴涨到 300px，界面产生剧烈的物理弹跳与视觉闪烁，且未提供骨架占位态。
2. **`SessionContextMenu` 每次打开创建 10+ JSX 实例**：
   - 方案未对静态菜单项（如“重命名”、“复制 ID”、“删除”）进行静态常量化，每次右键呼出菜单都在渲染函数内重新实例化 10 个 Lucide 图标与对象，造成不必要的 GC 压力。

---

## 六、魔鬼用例（Devil Test Cases）防御清单

为封死上述全部漏洞，以下 6 组魔鬼测试用例必须作为硬性门禁写入自动化测试套件：

```typescript
// ============================================================================
// Conex / Crish SmartExpandablePanel Architecture Devil Tests (DEVIL-SEP-01 ~ 06)
// ============================================================================

describe('SmartExpandablePanel 工业级架构魔鬼压力测试集', () => {

  // DEVIL-01: 触发器克隆首次挂载时序测试（防坐标 0,0 归零）
  it('DEVIL-01 [Trigger Mount Sync]: 首次点击未经预挂载的触发器，浮层绝对坐标严禁落于 (0, 0)', async () => {
    render(<Menu trigger={<button>独立触发器</button>} options={[{ id: '1', label: '项' }]} />);
    const btn = screen.getByText('独立触发器');
    fireEvent.click(btn);
    const panel = await screen.findByRole('menu');
    const transform = window.getComputedStyle(panel.parentElement!).transform;
    expect(panel.parentElement!.style.top).not.toBe('0px');
    expect(panel.parentElement!.style.left).not.toBe('0px');
  });

  // DEVIL-02: Dialog 模态层叠上下文穿透测试（防 Portal 到 body 沉没）
  it('DEVIL-02 [Dialog Overlay Containment]: 在 Dialog 内部展开时，浮层必须 Portal 进 DialogOverlay 容器', async () => {
    render(
      <Dialog open onClose={() => {}} title="测试弹窗">
        <SmartExpandablePanel open items={[{ id: '1', label: '测试项' }]} />
      </Dialog>
    );
    const item = await screen.findByText('测试项');
    const overlay = document.querySelector('[data-dialog-overlay]');
    expect(overlay).toBeTruthy();
    expect(overlay!.contains(item)).toBe(true);
  });

  // DEVIL-03: children 模式下的 WAI-ARIA 容器契约完整性测试
  it('DEVIL-03 [A11y Role Integrity]: 无论使用 items 还是 children，浮层容器必须具备标准 role="menu"', async () => {
    const { rerender } = render(
      <SmartExpandablePanel open items={[{ id: '1', label: '项' }]} />
    );
    expect(screen.getByRole('menu')).toBeInTheDocument();

    rerender(
      <SmartExpandablePanel open items={[]}>
        <div role="menuitem">自定义子项</div>
      </SmartExpandablePanel>
    );
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  // DEVIL-04: SelectAdapter 的 combobox / listbox / option 语义一致性
  it('DEVIL-04 [SelectAdapter A11y]: SelectAdapter 必须严格维持 listbox 语义，绝不能篡改为 menu', async () => {
    render(
      <SelectAdapter
        options={[{ id: 'opt1', label: '选项一' }]}
        value="opt1"
      />
    );
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    const option = await screen.findByRole('option', { name: /选项一/ });
    expect(option).toHaveAttribute('aria-selected', 'true');
  });

  // DEVIL-05: 顶置输入框与键盘漫游回车键冲突判定
  it('DEVIL-05 [Search Input Enter Immunity]: 在搜索/自定义输入框按 Enter 时，严禁误触发列表项选中', async () => {
    const onSelect = vi.fn();
    render(
      <SmartExpandablePanel
        open
        enableSearch
        items={[{ id: 'item1', label: '默认高亮项' }]}
        onSelect={onSelect}
      />
    );
    const searchInput = screen.getByPlaceholderText(/搜索/);
    fireEvent.change(searchInput, { target: { value: '自定义内容' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'item1' }));
  });

  // DEVIL-06: 列表尾部操作按钮点击冒泡隔离测试
  it('DEVIL-06 [Trailing Action Bubble Isolation]: 点击条目尾部删除按钮，绝不能触发父级 onSelect', async () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <SmartExpandablePanel
        open
        items={[
          {
            id: 'proj1',
            label: '项目一',
            onSelect,
            trailingAction: <button onClick={onDelete}>删除</button>,
          },
        ]}
      />
    );
    const deleteBtn = screen.getByText('删除');
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
```

---

## 七、架构修正与重构强制改进要求（整改验收标准）

所有方案作者与实施 Agent 必须无条件执行以下 **6 项强制架构整改**，方可放行进入代码落地阶段：

1. **【剔除自研 DOM 回流度量，复用成熟 Popper 几何基座】**：
   - 彻底废除 `measureNaturalHeight` 中的实时 style 读写与强制回流；
   - 几何定位引擎必须与既有 `@floating-ui/react` / `@radix-ui/react-popover` 深度对齐，采用纯数学视口双向刚性钳位（`Pure Math Clamp`），杜绝 144Hz 掉帧与亚像素抖动。
2. **【SafeAim 局部化与生命周期受控】**：
   - 彻底移除 `document.body` 上的常驻单例 SVG 与全局无条件 `mousemove` 监听；
   - SafeAim 遮罩必须作为当前打开面板的局部子节点渲染，仅在面板处于 `open` 状态时按需挂载事件监听，关闭时立即销毁。
3. **【100% 修复双轨适配器与测试断言契约】**：
   - `MenuAdapter` 必须完整保留 `styles.menuItemDisabled`、`styles.menuItemDanger` 类名导出，完整实现 `DialogOverlayContext` 注入；
   - `SelectAdapter` 必须显式输出 `role="listbox"` 与 `role="option"`，严禁破坏 WAI-ARIA combobox 树。
4. **【强制拆分物理文件，严守 400/500 行门禁】**：
   - `SmartExpandablePanel.tsx` 必须拆分为 `SmartPanelSearchHeader.tsx`、`SmartPanelList.tsx`、`SmartPanelSubmenu.tsx` 等独立子模块；
   - 所有业务组件的 `MenuItem[]` 构造逻辑必须抽离为独立的 `*Schema.ts` 纯函数文件。
5. **【实施 Schema 对象级缓存与搜索防抖】**：
   - 在适配器与业务组件中采用深度 memoization 或常量 Schema 提取，防止输入高频打字时引发全量重构；
   - 超过 50 项的列表搜索必须加入预分词索引或 30ms 微防抖。
6. **【事件冒泡严格隔离】**：
   - 所有 `trailingAction` 与行内操作按钮必须在组件层原生封装 `e.stopPropagation()`，彻底消灭误触穿透。

---
*报告编制：极度严苛架构与反过度设计审查专家（Architecture & Anti-Overengineering Devil Reviewer）*  
*签署生效日期：2026-08-20*
