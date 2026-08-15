# 02 - CSS 包含块、层叠上下文与裁剪隐患深度分析报告

**分析师**：Agent 02: CSS 包含块与 3D 渲染层深度分析师  
**分析基准**：严格零信任穿透扫描全前端 CSS / SCSS / Modules / 样式契约与 DOM 挂载树  
**代码变更**：纯分析，零代码修改（0 diffs）

---

## Executive Summary（执行摘要）

本次深度审计穿透扫描了 `apps/crish-desktop`（118 个 CSS 文件、65 个核心 TSX 视图组件）及 `packages/` 共享样式。发现并定位了 **4 大类、共 19 处高危 CSS 架构隐患**：

1. **视口基准破坏（Containing Block Destabilization）**：`.workspaces-stack` 被施加了 `transform: translateZ(0)`，使工作区内所有未 Portal 的 `position: fixed` 浮层与定位锚点的包含块退化为工作区容器而非 Viewport，造成 `top/left` 叠加 TopBar（36px）与 Sidebar（240px）双重坐标偏移。
2. **包含块与硬件加速污染（Containment & Backdrop-Filter Traps）**：`.toolBodyInner` 声明了 `contain: content`（等价于 `contain: layout style paint`），`.pinnedBar` 声明了 `backdrop-filter: blur(8px)`，直接在消息与工具流中拦截了 `position: fixed` 逃逸能力。
3. **多级子菜单裁剪与溢出（Overflow Clipping Hazards）**：`ProjectPickerMenu` 的 `.cascadeSubmenu`、`SidebarContextMenus` 的 `.sortFilterFlyout`、`FileViewerCard` 的 `.filesOpenMenu`/`.filesMoreMenu`、`LeafToolTabStrip` 的 `.addDropdownMenu` 均在具有 `overflow: hidden` / `overflow-y: auto` 的父容器中采用内联绝对定位，导致子菜单被直接切断截断或触发非预期滚动条。
4. **动画命名断层与瞬态测量干扰（Animation & Keyframe Desync）**：`Menu.module.css` 等 6 处样式引用的 `@keyframes cds-popover-enter` 在全仓**未定义**（定义实为 `crish-popover-enter`）；同时，带有 `scale(0.96)` 的过渡形变若在生命周期内触发 `getBoundingClientRect()` 会导致 4%~5% 的几何测量失真。

---

## 一、包含块（Containing Block）与 3D 渲染层穿透分析

### 1.1 视口基准破坏点清单（破坏 `position: fixed`）

当祖先元素具有 `transform`、`perspective`、`filter`、`backdrop-filter`、`contain: paint/content/strict` 或 `will-change` 时，W3C 规范明确规定该元素成为其所有 `position: fixed` 后代元素的包含块（Containing Block），不再以视口（Viewport）为基准。

| 序号    | 影响文件与行号                                                                                                                       | 受影响 CSS 选择器                                                                                                                | 污染属性与声明                                                                         | 架构影响与危害分析                                                                                                                                                                                                                                                                             |
| :------ | :----------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B01** | `apps/crish-desktop/src/styles/shell/shell-workspace.css:152`<br>`apps/crish-desktop/src/styles/shell/shell-workspace.css:435`       | `.app-container[data-shell-chrome='classic'] .workspaces-stack`<br>`.app-container[data-shell-chrome='inset'] .workspaces-stack` | `transform: translateZ(0);`<br>`isolation: isolate;`<br>`overflow: hidden !important;` | **【最高危】** 强制将工作区提升为 3D 独立渲染层（Composited Layer）。使得工作区内所有未 Portal 的 `position: fixed` 元素（如 `TiptapSlashMenu` 内部虚拟锚点）的基准原点变为 `.workspaces-stack`，造成 `getBoundingClientRect()` 计算的屏幕绝对坐标发生 `(sidebar_width, topbar_height)` 偏移。 |
| **B02** | `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css:201`                                                  | `.toolBodyInner`                                                                                                                 | `contain: content;`<br>`overflow: hidden;`                                             | **【高危】** `contain: content` 等价于 `layout style paint`。`paint` 包含性使得 `.toolBodyInner` 成为新的包含块。工具块内部若包含复制按钮 Tooltip、路径 Popover 或 Diff 浮层且未 Portal，`position: fixed` 浮层将被锁死在代码折叠块内部。                                                      |
| **B03** | `apps/crish-desktop/src/components/chat-message-list/ChatMessageList.module.css:38`                                                  | `.pinnedBar`                                                                                                                     | `backdrop-filter: blur(8px);`                                                          | **【中危】** CSS 规范规定 `backdrop-filter` 会为其后代创建新的包含块与层叠上下文。置顶栏内的子浮层若未 Portal 将无法逃逸出置顶条高度（40px）。                                                                                                                                                 |
| **B04** | `apps/crish-desktop/src/components/overlay/ToastStack.module.css:50`                                                                 | `.toastAlert`                                                                                                                    | `backdrop-filter: blur(8px);`<br>`transform: translateX(-50%);`                        | **【低危/内聚】** Toast 自带 `transform` 与 `backdrop-filter`，但由于 Toast 内部无下级弹出层，仅对自身后代生效，风险可控。                                                                                                                                                                     |
| **B05** | `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css:538`<br>`apps/crish-desktop/src/styles/tab-drag.css:11, 38` | `.sidebarDragGhost`<br>`.card-tab.is-dragging-ghost`<br>`.drag-overlay-preview-card`                                             | `will-change: transform;`<br>`z-index: var(--z-drag-overlay);`                         | **【中危】** 拖拽 Ghost 元素在拖拽生命周期内创建 GPU 合成层与临时层叠上下文。                                                                                                                                                                                                                  |
| **B06** | `apps/crish-desktop/src/styles/settings/settings-base.css:1562`                                                                      | `.settings-dialog-backdrop`                                                                                                      | `backdrop-filter: blur(6px);`                                                          | **【中危】** 设置弹窗全屏遮罩创建包含块，但其内部由 `Dialog`（`createPortal` 至 `document.body`）独立挂载，避免了嵌套。                                                                                                                                                                        |

---

## 二、浮层组件定位与多级子菜单裁剪深度排查

### 2.1 核心浮层组件渲染机制全景矩阵

| 组件名称                       | 视图文件与样式文件                                                        | Portal 机制                                                       | 定位方式与坐标来源                                                                                                        | 是否存在裁剪/包含块陷阱                                                                                                                                                                                                                                               |
| :----------------------------- | :------------------------------------------------------------------------ | :---------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Menu (基座)**                | `ui/Menu/Menu.tsx`<br>`ui/Menu/Menu.module.css`                           | `<Popover.Portal>`<br>(挂载至 `document.body`)                    | Radix Popover<br>`position: fixed;`<br>Floating-UI 视口计算                                                               | **通过**。基座已全量 Portal，脱离父容器 DOM 流，不受普通祖先 `overflow: hidden` 裁剪。                                                                                                                                                                                |
| **TiptapSlashMenu**            | `chat-composer/TiptapSlashMenu.tsx`<br>`TiptapSlashMenu.module.css`       | `<Popover.Portal>`<br>(锚点内联，面板 Portal)                     | **致命陷阱**：<br>虚拟锚点 `<div style={{ position: 'fixed', top: rect.top, left: rect.left }} />` 渲染在 Tiptap 内联 DOM | **【严重故障】** 虚拟锚点落在 `.workspaces-stack` 内部。由于 `.workspaces-stack` 存在 `transform: translateZ(0)`，锚点 `position: fixed` 的基准被限制在 `.workspaces-stack` 内，而 `rect.top/left` 是视口绝对坐标，导致 Popover Anchor 发生二次位移，SlashMenu 错位！ |
| **ModelBadgePickerMenu**       | `provider/ModelBadgePickerMenu.tsx`<br>`ModelBadgePickerMenu.module.css`  | 主菜单走 `Menu`<br>子菜单 `.mbSubMenu` 内联                       | 主菜单 Radix 固定；<br>子菜单：`position: absolute; right: calc(100% + 4px);`                                             | **【裁剪隐患】** 子菜单通过 `right: 100%` 向左悬浮，虽然主菜单声明了 `overflow: visible !important`，但若主菜单选项过多需要纵向滚动时，`overflow: visible` 与纵向滚动互斥。且子菜单无视口翻转防碰撞。                                                                 |
| **PermissionModeMenu**         | `chat-composer/PermissionModeMenu.tsx`<br>`PermissionModeMenu.module.css` | 走 `Menu` 基座                                                    | Radix Popover `side="top"`                                                                                                | **【冗余样式】** `.permMenu` 中硬编码了 `position: fixed` 与未定义动画，虽被 Radix inline style 覆盖，但存在样式污染。                                                                                                                                                |
| **ComposePlusMenu**            | `chat-composer/ComposePlusMenu.tsx`<br>`ComposePlusMenu.module.css`       | 走 `Menu` 基座                                                    | Radix Popover `side="top"`                                                                                                | **通过**。采用 `restoreFocusRef` 真实按钮锚定，已通过 P1-F4 消除 (0,0) 陷阱。                                                                                                                                                                                         |
| **ProjectPickerMenu**          | `chat-card/ProjectPickerMenu.tsx`<br>`ProjectPickerMenu.module.css`       | 主菜单走 `Menu`<br>子菜单 `.cascadeSubmenu` 内联                  | 子菜单：`position: absolute; left: 100%; top: 0;`                                                                         | **【严重裁剪】** 主菜单 `Menu.module.css:12` 默认声明 `overflow-y: auto`。当打开「添加项目」右侧级联菜单 `.cascadeSubmenu` 时，子菜单被 `.menuContent` 横向裁切（Clipping）或迫使主菜单底部出现横向滚动条！                                                           |
| **SidebarContextMenus**        | `sidebar/SidebarContextMenus.tsx`<br>`SidebarContextMenus.module.css`     | `SessionContextMenu` 走 Portal；<br>`ContextMenuFlyout` 走 `Menu` | 飞层 `.sortFilterFlyout`：<br>`position: absolute; left: calc(100% + 6px);`                                               | **【严重裁剪】** `ContextMenuFlyout` 内的 `.sortFilterFlyout` 向右弹出，因 `Menu.module.css` 的 `overflow-y: auto` 导致飞层在某些 DPI/缩放下被横向裁剪；且其 `z-index: var(--z-sticky-bar)` (2) 极低。                                                                |
| **FileViewerCard (Menus)**     | `files/FileViewerCard.tsx`<br>`FileViewerCard.module.css`                 | **无 Portal** (内联)                                              | `position: absolute; top: calc(100% + 4px); right: 0;`                                                                    | **【严重裁剪】** 打开方式菜单 `.filesOpenMenu` 与更多菜单 `.filesMoreMenu` 位于卡片内。卡片父级 `.leaf` 具有 `overflow: hidden; isolation: isolate;`，小窗口或卡片贴底时菜单直接被截断！                                                                              |
| **FilesCard (Flyouts)**        | `files/FilesCard.tsx`<br>`FilesCard.module.css`                           | **无 Portal** (内联)                                              | `position: absolute;`                                                                                                     | **【严重裁剪】** 面包屑飞层 `.filesBcFlyout`（`width: min(320px, 70vw)`）内联在卡片内，在分屏紧凑模式下必定被 `.leaf` 边界裁剪。                                                                                                                                      |
| **LeafToolTabStrip (AddMenu)** | `binary-tree/LeafToolTabStrip.tsx`<br>`LeafToolTabStrip.module.css`       | **无 Portal** (内联)                                              | `.menuBackdrop`: `position: fixed; inset: 0;`<br>`.addDropdownMenu`: `position: absolute;`                                | **【遮罩失效 + 裁剪】** `.menuBackdrop` 被 `.workspaces-stack` 的 `transform` 限制在工作区内，无法覆盖 TopBar 与 Sidebar；`.addDropdownMenu` 易被 `overflow: hidden` 裁剪。                                                                                           |
| **WorkspaceChromeBars**        | `workspace/WorkspaceChromeBars.tsx`<br>`WorkspaceChromeBars.module.css`   | **无 Portal** (内联)                                              | `.wsChromeAddMenu`: `position: absolute; top: calc(100% + 6px);`                                                          | **【严重裁剪】** 父级 `.ws-chrome-row--sessions` 声明了 `overflow: hidden`，添加菜单弹出时直接被父容器截断。                                                                                                                                                          |

---

## 三、层叠上下文（Stacking Context）与 Z-Index 体系冲突审计

### 3.1 全局 Z-Index 阶梯基线（`z-index.css`）

```css
--z-base: 0 /* 基础画布 */ --z-decorative: 1 /* 装饰背景 */ --z-sticky-bar: 2
  /* 粘性工具栏/标题栏 */ --z-card-header: 3 /* 卡片头部 */ --z-card-footer: 5
  /* 卡片底部操作区 */ --z-pinned-bar: 10 /* 消息置顶栏 */ --z-scroll-fab: 12
  /* 滚底悬浮按钮 */ --z-sidebar: 100 /* 侧边栏及遮罩 */
  --z-sidebar-resizer: 100 /* 侧边栏拖拽手柄 */ --z-sidebar-menu: 150
  /* 侧边栏二级菜单 */ --z-popover: 200 /* 气泡弹出层 */ --z-splitter: 300
  /* 窗格分割线 */ --z-dropdown-menu: 400 /* 标准下拉菜单 */ --z-breadcrumb: 600
  /* 面包屑下拉 */ --z-floating-panel: 1000 /* 浮动面板 */
  --z-modal-backdrop: 9000 /* 模态框遮罩 */ --z-context-menu: 9500
  /* 右键上下文菜单 */ --z-tooltip: 9999 /* 工具提示 */ --z-toast: 10000
  /* 全局 Toast */ --z-settings-dialog: 20000 /* 设置对话框 */
  --z-permission-menu: 20040 /* 权限模式菜单 */;
```

### 3.2 发现的 Z-Index 体系断层与异常值

1. **倒挂陷阱 1（子菜单层级反低于父菜单）**：
   - `SidebarContextMenus.module.css:147`：`.sortFilterFlyout` 声明了 `z-index: var(--z-sticky-bar)`（值为 2），而父菜单 `Menu.module.css:7` 声明了 `z-index: var(--z-dropdown-menu)`（值为 400）。子菜单的 token 选用错误，导致在复杂的卡片叠层中，飞层可能被兄弟卡片的 Header（`--z-card-header: 3`）压在下方。
2. **倒挂陷阱 2（模型子菜单低于父菜单）**：
   - `ModelBadgePickerMenu.module.css:77`：`.mbSubMenu` 声明了 `z-index: var(--z-sidebar-menu)`（值为 150），而主菜单为 `var(--z-dropdown-menu)`（值为 400）。
3. **硬编码与 Token 漂移**：
   - `ProjectPickerMenu.module.css:138`：`.cascadeSubmenu` 声明了 `z-index: var(--z-sticky-bar, 50)`，回退值为魔数 50。
   - `SidebarContextMenus.module.css:3`：`.contextMenu` 声明了 `z-index: var(--z-dropdown-menu, 1000)`（主 token 为 400，回退值为 1000，且偏离了专用的 `--z-context-menu: 9500`）。
   - `FileViewerCard.module.css:189, 306`：`.filesOpenMenu` 与 `.filesMoreMenu` 错误地复用了侧栏 token `z-index: var(--z-sidebar)`（值为 100），导致低于 `--z-popover: 200` 与 `--z-dropdown-menu: 400`。
4. **孤岛层叠上下文压制（Stacking Context Trap）**：
   - `BinaryTreeWorkspace.module.css:24, 72`：`.leaf` 具有 `isolation: isolate;`。
   - 当非活动分屏卡片 `.leaf[data-active='false']`（`opacity: 0.96; z-index: auto`）内部渲染了未 Portal 的浮层（如 `FileViewerCard` 打开方式菜单）时，无论其内部声明 `z-index: 10000` 还是 `9999`，其全局层叠能力均被锁死在 `.leaf` 内部，当其展开超出分屏边界时，会被邻接的活动卡片 `.leaf[data-active='true']`（`z-index: 1`）**完全遮挡压制**！

---

## 四、动画与 DOM 矩形测量干扰排查

### 4.1 核心动画关键帧未定义（Keyframe Desync）

在全仓 CSS 扫描中发现严重的 Keyframe 命名断层：

- **调用方（6 处核心样式）**：
  1. `apps/crish-desktop/src/components/ui/Menu/Menu.module.css:21`
  2. `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css:73, 78`
  3. `apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css:7, 23`
  4. `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css:11, 16`
  5. `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css:19, 24`

  均声明了：

  ```css
  animation: cds-popover-enter var(--transition-popover-enter) forwards;
  animation: cds-popover-exit var(--transition-popover-exit) forwards;
  ```

- **实际定义方（`apps/crish-desktop/src/styles/design-system.css:28, 88`）**：
  ```css
  @keyframes crish-popover-enter {
    0% { opacity: 0; transform: scale(0.96) translateY(-4px); }
    100% { opacity: 1; transform: scale(1) translateY(0); }
  }
  @keyframes crish-popover-exit { ... }
  ```
- **现状结论**：`@keyframes cds-popover-enter` 在整个样式表中**根本不存在**！浏览器直接跳过动画执行，浮层以 0ms 瞬间生硬出现。

### 4.2 Scale 形变对 DOMRect 测量的瞬态干扰分析

1. **几何缩放失真**：
   - 无论是 `crish-popover-enter`（`scale(0.96)`）、`dialog-enter`（`scale(0.96)`）还是 `tooltip-enter`（`scale(0.95)`），在元素挂载的初始帧（t=0），元素的 CSS 视觉变换为原尺寸的 95%~96%。
2. **连锁测量灾难**：
   - 若子组件在入场动画进行中（例如在 `useLayoutEffect`、`useEffect` 或子菜单 `onMouseEnter` 延迟 80ms 时）调用 `el.getBoundingClientRect()` 或 `position.ts` 的 `measureMenu()`：
   - 此时测得的 `width` 与 `height` 是缩放后的缩小值（比真实 DOM 尺寸小 4%~5%）；
   - 基于此缩小值计算的子菜单坐标偏移（如 `left: rect.left + rect.width`）会导致子菜单与父菜单产生 **4px~12px 的错位间隙或重叠**！
   - 一旦动画结束（`scale(1.0)`），之前基于动画中计算的子菜单固定坐标将**永远无法对齐**，造成视觉上的「脱臼」与抖动。

---

## 五、受影响的文件、选择器与行号总索引表

|  序号  | 领域分类    | 绝对/相对文件路径                                                                | 准确行号             | CSS 选择器 / 代码段                                  | 隐患特征                                                     |
| :----: | :---------- | :------------------------------------------------------------------------------- | :------------------- | :--------------------------------------------------- | :----------------------------------------------------------- |
| **01** | 包含块破坏  | `apps/crish-desktop/src/styles/shell/shell-workspace.css`                        | L152, L435           | `.app-container[...] .workspaces-stack`              | `transform: translateZ(0)` 破坏视口基准                      |
| **02** | 包含块破坏  | `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css`  | L201                 | `.toolBodyInner`                                     | `contain: content` 阻断 `fixed` 逃逸                         |
| **03** | 包含块破坏  | `apps/crish-desktop/src/components/chat-message-list/ChatMessageList.module.css` | L38                  | `.pinnedBar`                                         | `backdrop-filter: blur(8px)` 形成隔离层                      |
| **04** | 定位与错位  | `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx`            | L151-165             | `<Popover.Anchor>` 虚拟 DOM                          | 内联 `fixed` 锚点落在被 transform 污染的祖先中               |
| **05** | 裁剪隐患    | `apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css`       | L124-140             | `.cascadeSubmenu`                                    | `left: 100%` 级联子菜单被父菜单 `overflow-y: auto` 裁剪      |
| **06** | 裁剪隐患    | `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css`       | L134-148             | `.sortFilterFlyout`                                  | `left: calc(100% + 6px)` 飞层被 `overflow-y: auto` 裁剪      |
| **07** | 裁剪隐患    | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css`     | L67-82               | `.mbSubMenu`                                         | `right: 100%` 子菜单无边界感知且受制于主菜单高度             |
| **08** | 裁剪隐患    | `apps/crish-desktop/src/components/files/FileViewerCard.module.css`              | L176-193, L300-315   | `.filesOpenMenu`, `.filesMoreMenu`                   | 未 Portal，直接被 `.leaf` 的 `overflow: hidden` 裁剪         |
| **09** | 裁剪隐患    | `apps/crish-desktop/src/components/files/FilesCard.module.css`                   | L328-343, L470, L668 | `.filesBcFlyout`, `.filesMoreMenu`, `.filesOpenMenu` | 未 Portal，直接被卡片/分屏容器裁剪                           |
| **10** | 裁剪隐患    | `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css`      | L155-182             | `.menuBackdrop`, `.addDropdownMenu`                  | 遮罩范围退化 + 下拉菜单被分屏边界切除                        |
| **11** | 裁剪隐患    | `apps/crish-desktop/src/components/workspace/WorkspaceChromeBars.module.css`     | L350-369             | `.wsChromeAddMenu`                                   | 被父级 `.ws-chrome-row--sessions` 的 `overflow: hidden` 裁剪 |
| **12** | Z-Index异常 | `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css`       | L147                 | `.sortFilterFlyout`                                  | `z-index: var(--z-sticky-bar)` (2) 严重倒挂                  |
| **13** | Z-Index异常 | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css`     | L77                  | `.mbSubMenu`                                         | `z-index: var(--z-sidebar-menu)` (150) 低于父级 400          |
| **14** | Z-Index异常 | `apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css`       | L138                 | `.cascadeSubmenu`                                    | `z-index: var(--z-sticky-bar, 50)` 使用魔数且偏低            |
| **15** | 动画未定义  | `apps/crish-desktop/src/components/ui/Menu/Menu.module.css`                      | L21                  | `.menuContent`                                       | 引用未定义 `@keyframes cds-popover-enter`                    |
| **16** | 动画未定义  | `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css`  | L73, L78             | `.permMenu`, `.permMenuExit`                         | 引用未定义 `@keyframes cds-popover-enter/exit`               |
| **17** | 动画未定义  | `apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css`     | L7, L23              | `.root`, `.main`                                     | 引用未定义 `@keyframes cds-popover-enter`                    |
| **18** | 动画未定义  | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css`     | L11, L16             | `.mbMenu`, `.mbMenuExit`                             | 引用未定义 `@keyframes cds-popover-enter/exit`               |
| **19** | 动画未定义  | `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css`       | L19, L24             | `.contextMenu.open`, `.contextMenuExit`              | 引用未定义 `@keyframes cds-popover-enter/exit`               |

---

## 六、结构性根治与架构重构建议（供后续实现参考）

1. **彻底清理祖先破坏性属性**：
   - 移除 `shell-workspace.css` 中 `.workspaces-stack` 的 `transform: translateZ(0)`，改用纯粹的 `contain: layout` 或标准的 `isolation: auto` 避免强制 3D 包含块生成；
   - 将 `ChatToolCallBlock.module.css` 的 `contain: content` 降级为 `contain: layout style`（剔除 `paint` 包含性）。
2. **全量浮层 Portal 归一化（SSOT）**：
   - 废除所有在组件卡片内部内联渲染绝对定位浮层的模式（`FileViewerCard`、`FilesCard`、`LeafToolTabStrip` 等）；
   - 所有浮层一律迁移至 `ui/Menu` 基座或 `createPortal(..., document.body)`，彻底免疫祖先 `overflow: hidden`、`isolation: isolate` 与 `opacity` 压制。
3. **多级子菜单级联重构**：
   - 将 `ModelBadgePickerMenu`、`ProjectPickerMenu`、`ContextMenuFlyout` 的内联二级飞层升级为嵌套 Radix Popover 或 Floating-UI 独立 SubMenu Portal，具备自动碰撞避让（Collision Avoidance）与横向翻转能力。
4. **动画 Keyframe 统一与测量安全**：
   - 全局将 `cds-popover-enter` / `cds-popover-exit` 统一收敛为 `tokens.css` / `design-system.css` 中的单一真实名称（或在 tokens 中添加别名桥接）；
   - 在几何尺寸测量函数（`position.ts`、`measureMenu`）中，确保在 `transform: none` 状态下计算或从 `offsetWidth` / `offsetHeight` 获取非变换尺寸，免疫 CSS 动画过渡期的瞬态形变干扰。
