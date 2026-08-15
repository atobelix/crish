# 10 - 多层级联与 Portal 穿透组合深度分析报告

**分析师**：Agent 10: 多层级联与 Portal 穿透组合分析师  
**审查基准**：前端代码一律视为不可信任源，进行零假设、穿透表象的穷尽式静态与架构审查  
**审查状态**：完成，纯分析交付（零代码修改）

---

## 一、核心审查结论摘要 (Executive Summary)

经过对 `apps/crish-desktop` 中所有浮层基座（`Dialog`, `Menu`, `Tooltip`, `Select`, `ConfirmDialog`）、快捷菜单、上下文菜单、Toast 体系及 CSS 变量体系的深度排查，确认系统在多层级联与 Portal 挂载场景下存在 **三大系统性架构断层**：

1. **`FocusTrap.tsx` 误伤与状态机击穿漏洞**：
   - `FocusTrap` 在激活时遍历 `document.body.children`，硬编码仅豁免 `hasAttribute('data-focus-trap')` 的节点；
   - 弹窗内动态挂载至 `document.body` 的 Radix Popover (`data-radix-popper-content-wrapper`)、`ui/Tooltip` (`role="tooltip"`)、`ToastStack` 等 Portal 兄弟节点均无此标记；
   - 一旦在已打开的 `Dialog` 上叠开第二层 `Dialog`（如 `ConfirmDialog` / `SkillEditorModal`），子 Dialog 的 `FocusTrap` 会将父 Dialog 内部派生的所有 Portal 浮层直接置为 `inert=true` 与 `aria-hidden="true"`，造成浮层被物理冻结、无法交互；
   - 子 Dialog 关闭退出时，其 `deactivate()` 简单粗暴地将 `#root` 的 `inert` 还原为 `false`，彻底击穿外层 Dialog 的焦点隔离屏障，导致背景工作区被提前解冻。

2. **Radix UI `DismissableLayer` 三层嵌套误杀链条**：
   - Radix 的 `DismissableLayer` 依赖自身内部全局栈及 DOM `contains()` 判定 `isHighestLayer` 与 pointerdown 归属；
   - 当 `Dialog`（自研 Portal） $\to$ `Menu`（Radix Popover） $\to$ `Tooltip` / `ConfirmDialog`（原生 React Portal）混合嵌套时，挂载在 `document.body` 上的 Tooltip 或 Confirm 节点无法被 Radix 的 `DismissableLayer` 识别为其子分支（Branch）；
   - 用户在三层浮层（如 Menu 项的 Tooltip 或点击删除触发的 ConfirmDialog）上触发 pointerdown 时，Radix 在 capture 阶段判定为「Menu 外部点击」，触发 `onPointerDownOutside` 强制将父 Menu 卸载，打断后续交互；
   - `Dialog` 仅拦截 `onMouseDown` 和 `onClick` 冒泡，漏掉了 `onPointerDown`，而 Radix 恰恰基于 `pointerdown` 做外点检测。

3. **全局 Z-Index 偏序关系全线崩溃与倒挂**：
   - 理想单向偏序基线：`Base < Card < Sticky < Sidebar < Popover < Dropdown < Modal < ContextMenu < Tooltip < Toast < PermissionMenu`；
   - 实际代码存在 **7 处严重倒挂与割裂**：
     - **Modal 层级严重撕裂**：从基础 9000（`--z-modal-backdrop`）分散至 12000（Cheatsheet）、13000（SettingsPanel）、20000（SkillEditor）、30000（UsageModal）乃至 100000（FirstRunWizard）；
     - **Dropdown/Select 在 Modal 内部被物理掩埋**：`ui/Menu` 与 `ui/Select` 默认 z-index 为 400（`--z-dropdown-menu`），一旦在 `SettingsPanel` (13000) 或 `Dialog` (9000) 中打开，Portal 渲染到 `document.body` 时直接被 Modal 遮罩和面板压在最底层，完全不可见；部分业务不得不写死 `z-index: var(--z-settings-tooltip) /* 20060 */`（如 `FontSelectField`）进行打补丁；
     - **ContextMenu 被严重降级**：Token 中声明 `--z-context-menu: 9500`，但真实代码 `SessionContextMenu.tsx` 与 `SidebarContextMenus.module.css` 均降级使用 `var(--z-dropdown-menu, 1000)` = 400，导致右键菜单低于面包屑 (600) 和浮动面板 (1000)；
     - **Toast 被设置页与高级弹窗彻底遮挡**：`ToastStack` 的 z-index 仅为 10000，用户在 `SettingsPanel` (13000) 下触发的任何操作提示（如保存、导出、报错）均在暗处渲染，用户完全看不到；
     - **PermissionModeMenu 异常虚高**：作为聊天输入框普通下拉，z-index 高达 20040，甚至凌驾于所有主 Modal、Tooltip 和 Toast 之上；
     - **Flyout 二级子菜单反向倒挂**：`SidebarContextMenus.module.css` 中的 `.sortFilterFlyout` 将 z-index 设为 `var(--z-sticky-bar)` = 2，甚至低于其父菜单 (400)；
     - **ProjectPickerMenu 的子菜单与删除按钮紊乱**：`.cascadeSubmenu` 设为 2，删除按钮设为 5，层级定义荒诞。

---

## 二、三层级联 DOM 拓扑图与调用链分析

### 1. 真实 DOM 兄弟节点扁平拓扑图（Portal 全部挂载至 `document.body`）

在 `SettingsPanel` (Dialog) $\to$ `Select / FontSelectField` (Menu) $\to$ `Tooltip / ConfirmDialog` (Layer 3) 场景下：

```
document.body
├── <div id="root">                                             [DOM Sibling 1: 主应用容器, z-index: auto]
│     └── <div class="app-layout">...</div>                     (被 FocusTrap 设为 inert=true, aria-hidden="true")
│
├── <div data-focus-trap>                                       [DOM Sibling 2: Layer 1 - SettingsPanel 弹窗, z-index: 13000]
│     └── <div class="settingsCoverOverlay" style="z-index: 13000">
│           <div class="backdrop" />
│           <div role="dialog" aria-modal="true" class="settingsCover">
│             └── <div class="coverContent">
│                   └── <button class="select-trigger">选择字体</button> (Trigger 留在 Dialog DOM 内)
│                 </div>
│           </div>
│     </div>
│
├── <div data-radix-popper-content-wrapper>                     [DOM Sibling 3: Layer 2 - Menu / Select 下拉 Portal, z-index: 400 或 20060]
│     └── <div class="menuContent" role="listbox" style="z-index: 400"> (⚠️ 若无 ad-hoc override，z-index: 400 < 13000，被 Sibling 2 遮盖！)
│           ├── <button role="option">Inter</button>
│           └── <button role="option" aria-describedby="tip-1">JetBrains Mono (带 hint Tooltip)</button>
│     </div>
│
├── <div role="tooltip" id="tip-1" class="tooltip" style="z-index: 9999"> [DOM Sibling 4: Layer 3 - Tooltip 提示 Portal, z-index: 9999]
│     └── <div class="tooltipContent">适用于代码编辑的高级等宽字体</div>  (⚠️ z-index: 9999 < 13000，被 Sibling 2 遮盖！)
│
├── <div data-focus-trap>                                       [DOM Sibling 5: Layer 3 - 二次确认 ConfirmDialog Portal, z-index: 9000]
│     └── <div class="overlayEnter" style="z-index: 9000">
│           <div role="alertdialog" aria-modal="true" class="dialog">
│             <button>取消</button>
│             <button>确认</button>
│           </div>
│     </div>
│
└── <div class="toastStack" style="z-index: 10000">              [DOM Sibling 6: 全局 Toast 容器, z-index: 10000]
      └── <div role="status" class="toastAlert">操作成功</div>      (⚠️ z-index: 10000 < 13000，在设置页中不可见！)
```

---

## 三、`focusTrap.tsx` 缺陷与穿透排查证据

### 1. `inert` / `aria-hidden` 误伤与击穿机制排查

- **文件定位**：`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx:41-74`
- **核心漏洞**：
  1. **Portal 浮层被误伤冻结**：
     - `Menu.tsx` 中的 Radix Popover Portal、`Tooltip.tsx` 中的 Tooltip Portal、`ToastStack.tsx` 均未附带 `data-focus-trap` 属性；
     - 当发生多弹窗嵌套（如 `SettingsPanel` 内打开 `ConfirmDialog` 或 `WithdrawConfirmDialog`），内层弹窗的 `activate()` 会把外层弹窗内产生的所有有效浮层（包含 Select、Tooltip 等）强行打上 `inert=true`；
  2. **引用计数缺失导致的沙盒提前穿透**：
     - `deactivate()` 在卸载时按 `originalValues` 原样写回。当外层 Dialog 已经把 `#root` 设为 `aria-hidden="true"` 后，内层 Dialog 挂载时记录的 original value 可能是 `"true"` 或 `null`；
     - 内层弹窗 `deactivate()` 运行后直接将 `el.inert = false`，外层 Dialog 毫不知情，导致底层的 `#root` 应用页面被提前解冻。

### 2. 键盘 Tab 漫游中断与焦点逃逸排查

- **文件定位**：`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx:28-35, 92-109`
- **核心漏洞**：
  - `container` 是 `<div data-focus-trap>`，而通过 `createPortal` 挂载到 `document.body` 的 `Menu`、`Select` 选项列表是 `container` 的 **DOM 兄弟节点**；
  - `container.querySelectorAll` 根本无法检索到 Portal 浮层中的可聚焦元素；
  - 当焦点进入 `Menu` 内部后，`container.contains(document.activeElement)` 返回 `false`，Tab 键会直接把焦点从 Portal 浮层抛出到不可预测的 DOM 区域。

---

## 四、Radix UI `DismissableLayer` 三层嵌套误杀链条排查

1. **场景：`Dialog` $\to$ `Menu (Radix)` $\to$ `Tooltip (原生 Portal)`**：
   - 用户在 `Dialog` 中打开 `Menu`（Radix Popover），悬停在 `Menu` 项上触发 `Tooltip`（原生 React Portal）；
   - `Tooltip` 是纯原生 DOM，没有通过 Radix 的 `DismissableLayer.Branch` 注册；
   - 当用户与 Tooltip 交互触发 `pointerdown` 时，Radix 判定为「外部点击」，触发 `onPointerDownOutside` 强制将父 Menu 卸载闪退。
2. **场景：`Menu` $\to$ 触发 `ConfirmDialog (原生 Portal)`**：
   - 在 `ProjectPickerMenu.tsx:120-134` 中点击删除触发 `ConfirmDialog`；
   - 点击确认按钮时，Radix `DismissableLayer` 捕获 `pointerdown` 判定为 outside click 提前关闭 Menu。
3. **PointerDown vs MouseDown 漏防**：
   - `Dialog.tsx:169-170` 仅拦截了 `onMouseDown` 与 `onClick`，漏掉了 `onPointerDown`，导致任何点击事件在 pointerdown 阶段直接泄漏给 Radix 的全局监听器。

---

## 五、全局 Z-Index 体系偏序关系审查与紊乱全景表

$$\text{Base} < \text{Card} < \text{Sticky} < \text{Sidebar} < \text{Popover} < \text{Dropdown} < \text{Modal} < \text{ContextMenu} < \text{Tooltip} < \text{Toast} < \text{PermissionMenu}$$

| 层级名称           | 理论偏序基线 | `z-index.css` Token 定义                                                                                                                                                    | 实际组件使用值与实现位置                                                                                                                                    | 偏序状态      | 致命缺陷说明                                                                             |
| :----------------- | :----------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------ | :--------------------------------------------------------------------------------------- |
| **Base**           | 0 ~ 1        | `--z-base: 0`<br>`--z-decorative: 1`                                                                                                                                        | `App.module.css` (0)                                                                                                                                        | ✅ 正常       | 基础底层正常                                                                             |
| **Card**           | 2 ~ 5        | `--z-card-header: 3`<br>`--z-card-footer: 5`                                                                                                                                | `ChatCard.module.css` (3, 5)<br>`ProjectPickerMenu.module.css:43` (5)                                                                                       | ⚠️ 倒挂       | Header(3) / Footer(5) 高于 StickyBar(2)，滚动时遮挡 Sticky 元素                          |
| **Sticky**         | 10 ~ 12      | `--z-sticky-bar: 2` ❌<br>`--z-pinned-bar: 10`<br>`--z-scroll-fab: 12`                                                                                                      | `SidebarContextMenus.module.css:147` (2)<br>`ProjectPickerMenu.module.css:138` (2)                                                                          | 💥 严重倒挂   | `--z-sticky-bar` 仅定义为 2，低于 Card；且被错用于 SubMenu Flyout                        |
| **Sidebar**        | 100 ~ 150    | `--z-sidebar: 100`<br>`--z-sidebar-resizer: 100`<br>`--z-sidebar-menu: 150`                                                                                                 | `Sidebar.module.css` (100)<br>`ModelBadgePickerMenu.module.css:77` (150)                                                                                    | ⚠️ 割裂       | SubMenu 错用 `--z-sidebar-menu`(150)，导致 SubMenu 低于其父级 Menu(400)                  |
| **Popover**        | 200 ~ 300    | `--z-popover: 200`<br>`--z-splitter: 300`<br>`--z-breadcrumb: 600`                                                                                                          | `TiptapSlashMenu.module.css:19` (200)                                                                                                                       | ⚠️ 脆弱       | 斜杠菜单使用 200，若在 Modal 中唤起将彻底不可见                                          |
| **Dropdown**       | 400 ~ 600    | `--z-dropdown-menu: 400`<br>`--z-dropdown: 1010`                                                                                                                            | `Menu.module.css:7` (400)<br>`Select.module.css` (继承 400)<br>`ComposePlusMenu.module.css:5` (400)                                                         | 💥 结构性遮挡 | 弹窗 (9000~13000) 内的任何 Select 下拉挂到 body 后层级仅 400，完全被弹窗遮盖！           |
| **Modal**          | 9000         | `--z-modal-backdrop: 9000`<br>`--z-cheatsheet: 12000`<br>`--z-settings-panel: 13000`<br>`--z-settings-dialog: 20000`<br>`--z-usage-modal: 30000`<br>`--z-first-run: 100000` | `Dialog.module.css:11` (9000)<br>`SettingsPanel.module.css:10` (13000)<br>`SkillEditorModal.module.css:8` (20000)<br>`FirstRunWizard.module.css:6` (100000) | 💥 严重撕裂   | Modal 层级从 9000 乱飙到 100000，撕裂并碾压了 Tooltip(9999) 和 Toast(10000)              |
| **ContextMenu**    | 9500         | `--z-context-menu: 9500`                                                                                                                                                    | `SidebarContextMenus.module.css:3` (`--z-dropdown-menu, 1000` = 400) ❌<br>`SessionContextMenu.tsx:136` (400) ❌                                            | 💥 严重降级   | 代码未消费 `--z-context-menu`，错误回退至 400，低于面包屑 (600) 和浮层 (1000)            |
| **Tooltip**        | 9999         | `--z-tooltip: 9999`<br>`--z-settings-tooltip: 20060`                                                                                                                        | `Tooltip.module.css:6` (9999)<br>`FontSelectField.module.css:122` (20060)                                                                                   | 💥 割裂被盖   | 默认 Tooltip (9999) 无法在 SettingsPanel (13000) 中显示；出现 20060 硬编码补丁           |
| **Toast**          | 10000        | `--z-toast: 10000`                                                                                                                                                          | `ToastStack.module.css:10, 47` (10000)                                                                                                                      | 💥 严重遮挡   | Toast (10000) 低于 SettingsPanel (13000) 和高级弹窗，设置页内所有 Toast 提示被完全覆盖   |
| **PermissionMenu** | 20040        | `--z-permission-menu: 20040`                                                                                                                                                | `PermissionModeMenu.module.css:64` (20040)                                                                                                                  | 💥 异常虚高   | 输入框普通权限下拉菜单被赋予 20040 极端高层级，高于除 FirstRun 之外的所有 Modal 和 Toast |

---

## 六、架构级修复方案与演进路线建议

1. **构建全局「层级上下文与栈式 Manager」(Stack-Aware Portal & Focus Manager)**：
   - 将 `focusTrap.tsx` 升级为带 **引用计数与全局栈注册** 的 FocusManager；
   - 任何 Portal 节点在挂载到 `document.body` 时，向当前激活的 Top Layer 注册 `data-portal-owner="{layerId}"` 或统一打上 `data-overlay-floating`，`FocusTrap` 仅对非任何 Layer 所属的 `#root` 子树施加 `inert`；
   - 子 Dialog 关闭时，仅回退属于本层的 `inert` 计数，只有栈底 Dialog 关闭时才真正解冻 `#root`。
2. **Radix UI `DismissableLayer.Branch` 与 PointerDown 统一收敛**：
   - 在 `Dialog.tsx` 顶层容器显式添加 `onPointerDown={(e) => e.stopPropagation()}`，杜绝 PointerDown 穿透到 Radix 监听器；
   - 将 `ui/Menu` 中的嵌套子浮层（Tooltip、Flyout、ConfirmGate）用 Radix 的 `<DismissableLayer.Branch>` 进行包裹，消除 `onPointerDownOutside` 误关。
3. **重构严格单调递增的 Z-Index 数值体系**：
   - 彻底废除 100000、20040 等跳跃式数值，统一规划为 100 步进的标准偏序，弹窗内部通过 CSS 局部变量继承与上下文提升（`--z-dropdown-menu: calc(var(--dialog-z, 1000) + 100)`）。
