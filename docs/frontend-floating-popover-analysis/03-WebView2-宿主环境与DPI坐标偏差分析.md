# 03 - WebView2 宿主环境、DPI 缩放与窗口坐标偏差深度分析报告

【分析师角色】：Agent 03: WebView2 宿主环境与 DPI 缩放深度分析师
【执行纪律】：纯分析模式，零代码改动；证据链包含具体文件路径与行号。

---

## 摘要与核心缺陷全景图

经过对 Tauri 2.0 桌面端架构、Windows OS 窗口管理子系统（DWM/Win32）、Chromium WebView2 渲染进程以及前端坐标/浮层体系的严格审计，共发现 **3 大类、8 处严重破坏坐标一致性与交互稳定性的系统级断层**：

1. **DPI 缩放与亚像素断层**：
   - `position.ts` 存在**二次钳位（Double Clamping）与坐标二次反转（Double Flip）**：初始使用预估宽高修改了原始鼠标坐标，导致后续 `measureMenu` 基于已被篡改的坐标重新计算，引发反向跳变与动画原点 `originX` 误判；
   - `Tooltip.tsx` 存在**整型截断与浮点混合导致的亚像素渗透（Sub-pixel Penetration）**，且首帧挂载前 `clampedPos` 为 `null` 导致 FOUC 闪烁与错位；
   - Windows 下 `decorations: false` 无边框窗口在最大化时**缺少 Win32 `WM_NCCALCSIZE` 补偿**，导致视口向屏幕外膨胀 8px，`window.innerWidth/innerHeight` 虚高 16px，导致所有贴边浮层基于虚假坐标系计算。
2. **窗口拖拽与尺寸广播延迟断层**：
   - `Menu.module.css`、`SessionContextMenu`、`ContextMenuFlyout` 等 Portal 浮层**全量缺失 `-webkit-app-region: no-drag`**。当浮层伸展至顶栏（`AppTopBar`）等 `data-tauri-drag-region` 区域时，Windows 直接触发 `WM_NCLBUTTONDOWN`（`HTCAPTION`）拖拽模态循环，强行吞噬 `click` 与 `pointerdown` 事件，导致菜单点击失灵并引发窗口误拖动；
   - `ContextMenuFlyout` 的三级子菜单（Flyout）使用**硬编码右偏移**（`left: calc(100% + 6px)`），完全无视视口边界，在侧栏贴右或窗口缩小时发生 100% 溢出截断；
   - `WindowResizeBridge`（200ms 防抖 + 2x rAF）与 `ResizeObserverManager`（挂起 + 每帧仅 5 个元素排空）构成**长达 300ms+ 的布局冻结链**，在 Snap Assist 和窗口最大化时导致前端 JS 布局与真实 DOM 发生严重脱节与视觉撕裂。
3. **WebView2 与 Vite HMR 样式脱节断层**：
   - `index.css` 中 `@import layer(base)` 导致 CSS Cascade Layers 优先级倒置；
   - Vite dev 下 CSS Modules 动态 `<style>` 标签热重载不触发 WebView2 的 DOM 测量刷新，导致 JS 计算的旧坐标与新 CSS 盒模型失步。

---

## 一、Windows DPI 缩放与亚像素坐标断层分析

### 1.1 Windows DPI 缩放与 Chromium 视口测量分歧

在 Windows 环境下，不同缩放比例（100%、125%、150%、175%、200%）对应的设备像素比（DPR）：

- **100% (96 DPI)**: 1 CSS px = 1.0 physical px
- **125% (120 DPI)**: 1 CSS px = 1.25 physical px (1 physical px = 0.8 CSS px)
- **150% (144 DPI)**: 1 CSS px = 1.50 physical px (1 physical px = 0.6667 CSS px)
- **175% (168 DPI)**: 1 CSS px = 1.75 physical px (1 physical px = 0.5714 CSS px)
- **200% (192 DPI)**: 1 CSS px = 2.0 physical px (1 physical px = 0.5 CSS px)

在 Chromium/WebView2 中：

- `window.visualViewport.width/height` 返回精确的 `double` 浮点数（如 125% 下 1321 物理像素 = 1056.8 CSS px）；
- `window.innerWidth/innerHeight` 在部分场景下返回截断/四舍五入后的整数；
- `element.getBoundingClientRect()` 返回高精度浮点 `DOMRect`；
- DOM 渲染的光栅化（Rasterization）在物理像素栅格上对浮点 CSS 像素执行 `Math.round(x * dpr) / dpr` 贴靠。

### 1.2 `position.ts` 中的视口外溢与「二次钳位反转」根因

- **证据位置**：
  - `apps/crish-desktop/src/components/ui/Menu/position.ts:41-97` (`clampPosition`)
  - `apps/crish-desktop/src/components/ui/Menu/position.ts:106-119` (`measureMenu`)
  - `apps/crish-desktop/src/components/sidebar/useSidebarContextMenu.ts:133-135`
  - `apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx:86-93`

#### 缺陷机制深入剖析：

1. **输入坐标篡改与二次翻转（Double Flip Bug）**：
   在 `useSidebarContextMenu.ts:134` 中：

   ```ts
   const { x, y } = clampPosition(e.clientX, e.clientY);
   setContextMenu({ x, y, sessionId });
   ```

   此处使用默认预估尺寸 `menuW = 160, menuH = 280` 对 `clientX` 进行了第一次钳位。
   假设视口宽度为 1280px，鼠标点击在 `clientX = 1130px`：
   `1130 + 160 = 1290 > 1280 - 8 (1272)` → 命中右侧贴边避让条件，`x` 被计算为 `1130 - 160 = 970px`，并存入 state `contextMenu.x = 970`。

2. 随后，`SessionContextMenu.tsx:89` 在挂载阶段执行 `useLayoutEffect`：

   ```ts
   const next = measureMenu(el, contextMenu.x, contextMenu.y);
   ```

   此时 `measureMenu` 获取了菜单真实宽度 `rect.width = 180px`，并将 `contextMenu.x`（即 **970px**，已被减过一次 160）作为锚点传入 `clampPosition(970, y, 180, ...)`！
   - 计算：`970 + 180 = 1150px < 1272px`！
   - `clampPosition` 认为该坐标「并未贴近右边缘」，因此**不再翻转**，并且将 `originX` 判定为 `'left'`！
   - 结果：菜单的左边缘被固定在 970px（相对于鼠标点击处 1130px 偏移了 160px），导致菜单右侧距离鼠标点击点有大段空白；且动画原点从右侧被篡改为左侧！
   - 更严重情况：若鼠标在 1200px，初次翻转至 1040px；若菜单实际宽度为 260px，`1040 + 260 = 1300 > 1272`，将再次触发翻转：`1040 - 260 = 780px`！发生了**双重翻转（Double Flip）**，菜单直接漂移到了距离鼠标 420px 的远端！

3. **亚像素外溢误判**：
   在 125% / 175% DPI 下，`vw = window.visualViewport.width` 为浮点数（如 1056.8px）。`MENU_EDGE_PAD = 8`。
   `clampPosition` 计算 `vw - menuW - MENU_EDGE_PAD = 1056.8 - 160 - 8 = 888.8px`。
   当应用 `left: 888.8px` 时，物理像素为 `888.8 * 1.25 = 1111px`。若元素实际含有 1px border（物理 1px = 0.8 CSS px），元素真实宽度变为 160.8px，`888.8 + 160.8 = 1049.6px > 1048.8px`，导致浮层边框直接刺破 8px 安全留白，甚至在 1px 误差下被 WebView2 视口边缘裁切。

### 1.3 `Tooltip.tsx` 亚像素混合与首帧闪烁

- **证据位置**：
  - `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:115-116`
  - `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:226-232`
  - `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:350-356`

#### 缺陷机制深入剖析：

1. **视口取值与基座不统一**：
   `Tooltip.tsx:115-116` 仅读取 `window.innerWidth/innerHeight`，并未像 `position.ts` 一样优先读取 `window.visualViewport`。在缩放模式下，`innerWidth`（整数）与 `visualViewport`（浮点）存在 0.5~1.5px 的偏差。
2. **整数 `offsetWidth` 与浮点 `DOMRect` 混合计算**：
   `Tooltip.tsx:229-230` 使用 `tipEl.offsetWidth`（整型四舍五入）计算提示框宽度，而目标元素的 `rect` 来源于 `getBoundingClientRect()`（高精度浮点）。在 125%/150% DPI 下，`offsetWidth` 会丢失小数位（如 114.6px 被截断为 114px），导致反算的几何安全边距产生 0.6px~1px 渗透。
3. **首帧 FOUC（样式与定位未水合闪烁）**：
   在组件初次挂载时，`clampedPos` 初始值为 `null`。
   `Tooltip.tsx:352-353` 回退为 `top: rect.top, left: rect.left`。
   若 `side = 'top'`，正确位置应为 `(rect.left + rect.width / 2, rect.top - 8)`。首帧直接以 `(rect.left, rect.top)` 渲染并施加 `translate(-50%, -100%)`，导致提示框在首帧瞬间向左上方偏移半个身位，在 `useLayoutEffect` 计算出 `clampedPos` 后才瞬移回中心，在高刷新率屏幕和动画入场时产生肉眼可见的残影与抖动。

### 1.4 Tauri 无边框窗口（`decorations: false`）最大化有效客户区尺寸测量偏差

- **证据位置**：
  - `apps/agent-workbench/src-tauri/tauri.conf.json:13-23`
  - `apps/agent-workbench/src-tauri/Cargo.toml:17-30`

#### 缺陷机制深入剖析：

1. Windows Win32 DWM 机制：为了在无边框（`decorations: false`）窗口保留系统级边缘缩放手柄，Windows 会保留 `WS_THICKFRAME` 样式，并附带 7~8px 的不可见 resize 边框（`SM_CXSIZEFRAME` + `SM_CXPADDEDBORDER`）。
2. 当调用 `win.maximize()` 或用户将窗口拖至顶部最大化时，Win32 窗口管理器为了隐藏外部 resize 阴影，会自动将窗口矩形向屏幕 4 周外扩 8px（即 HWND 坐标变为 `[-8, -8, screen_width + 8, screen_height + 8]`）。
3. 由于 Tauri 壳工程未接入 Windows 专属的 `WM_NCCALCSIZE` 拦截与校正，WebView2 的客户区 HWND 直接被拉伸至 `[-8, -8, width + 16, height + 16]`。
4. **测量偏差影响**：
   - WebView2 内部的 `window.innerWidth` 和 `visualViewport.width` 比显示器物理工作区宽度多出整整 16px！
   - 顶部 `AppTopBar` 的上边缘 8px 以及左/右边缘 8px 实际被渲染在显示器可视区域之外（被显示器边缘裁切）；
   - 前端所有依据 `window.innerWidth` 进行的边缘钳位（如 `vw - 8`）实际定位在显示器外 8px 处，导致右侧/底部的菜单和 Tooltip 边框被直接切掉！

---

## 二、窗口拖拽区域（`data-tauri-drag-region`）与事件抢占延迟

### 2.1 Windows 宿主拖拽系统对浮层鼠标事件的强制抢占

- **证据位置**：
  - `apps/crish-desktop/src/components/AppTopBar.tsx:46, 48, 78`
  - `apps/crish-desktop/src/styles/shell/shell-polish.css:146-154`
  - `apps/crish-desktop/src/components/ui/Menu/Menu.module.css:5-23`
  - `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css:1-15`
  - `apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx:63-76`

#### 缺陷机制深入剖析：

1. **Windows WebView2 拖拽桥接机制**：
   WebView2 通过 `-webkit-app-region: drag`（或 `data-tauri-drag-region`）在渲染引擎内标记拖拽区域。当鼠标在标记区域按下时，WebView2 内部直接向 Windows 发送 `WM_NCLBUTTONDOWN` 并附带 `HTCAPTION` 命中测试代码，由宿主 OS 接管进入模态拖拽消息循环。
2. **浮层穿透抢占事故链**：
   - `AppTopBar.tsx` 将整行以及 `app-top-bar__rail`、`app-top-bar__main` 均标记了 `data-tauri-drag-region`；
   - 当侧栏顶部会话触发右键菜单（`SessionContextMenu`）、或顶栏快捷操作弹出 `Menu`、或搜索提示下拉框展开时，这些 Portal 元素在视觉上遮盖了 `AppTopBar`；
   - 检查 `Menu.module.css` 中的 `.menuContent` 以及 `SidebarContextMenus.module.css` 中的 `.contextMenu`：**两者均未设置 `-webkit-app-region: no-drag` 或类名 `.no-drag`**！
   - 结果：在 Windows WebView2 下，当用户试图点击位于顶栏上方的菜单项时，底层宿主窗口直接捕获 `HTCAPTION` 拖拽信号，前端 DOM 根本无法接收到 `click` 或 `pointerup` 事件，菜单不仅无法点击选中，还会导致整个应用窗口被意外拖走！

### 2.2 `ContextMenuFlyout` 三级菜单（Flyout）无避让硬编码越界

- **证据位置**：
  - `apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx:63-76`
  - `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css:134-148`
  ```css
  .sortFilterFlyout {
    position: absolute;
    left: calc(100% + 6px);
    top: -4px;
    min-width: 148px;
    ...
  }
  ```
- **缺陷表现**：
  - `sortFilterFlyout` 直接通过 CSS 绝对定位钉死在父容器右侧（`left: calc(100% + 6px)`）；
  - 完全没有接入 `clampPosition` 或任何视口碰撞检测（Collision Detection）；
  - 当侧栏在右侧布局、窗口较窄、或侧栏位于屏幕右边缘时，展开「排序方式 / 分组方式 / 列表范围」子菜单，该浮层 100% 溢出到视口右边界之外，用户完全无法看到或点击子菜单项！

### 2.3 全屏/最大化/Snap Assist 视口尺寸更新的「300ms+ 三重冻结延迟」

- **证据位置**：
  - `apps/crish-desktop/src/services/WindowResizeBridge.ts:13-14, 84-113`
  - `apps/crish-desktop/src/store/layoutAnimationStore.ts:176-267, 342-364`
  - `apps/crish-desktop/src/services/ResizeObserverManager.ts:20-83`

#### 延迟传播链精确时序分析：

1. 用户触发 Windows Snap Assist（如快捷键 `Win + Left/Right`）或双击顶栏最大化：
   - 操作系统向 WebView2 发送窗口尺寸变化消息；
   - `WindowResizeBridge.ts:42` 监听到 `win.onResized` 或 `window.resize`；
2. `WindowResizeBridge.ts:84-113` 触发 `handleWindowChange`：
   - 立即调用 `beginLayoutInteraction('window-resizing')`，将全局 store 状态 `isLayoutFrozen` 置为 `true`；
   - 启动 **200ms 防抖定时器**（`DEBOUNCE_MS = 200`）；
   - 若窗口动画过程中触发了多次 resize，每次均会重置 200ms 计时器；
3. 全局布局冻结副作用：
   - `layoutAnimationStore.ts:357` 监听到 `isLayoutFrozen = true`，调用 `ResizeObserverManager.getInstance().setSuspended(true)`；
   - 此时，应用内所有注册到 `ResizeObserverManager` 的组件（包括：虚拟化消息列表 `VirtualScrollManager`、编辑器容器、终端 xterm、分屏 sash、Canvas 等）**全部停止响应尺寸变化，ResizeObserver 回调被截留在 `pendingQueue` 中**；
4. 解冻与排空阻塞：
   - 200ms 防抖计时器超时后，嵌套了 **2 次 `requestAnimationFrame`**（约 33.3ms @60Hz）才调用 `endLayoutInteraction('window-resizing')`；
   - `ResizeObserverManager.setSuspended(false)` 触发 `flushPending()`；
   - `ResizeObserverManager.ts:11` 设定 `FLUSH_BATCH_SIZE = 5`（每帧仅处理 5 个目标元素）；
   - 若页面上有 20 个被观察元素，需要额外消耗 `20 / 5 = 4` 个 rAF 帧（约 66.6ms）才能完成全部组件的布局排空！
5. **综合延迟统计**：
   $$\text{总滞后时间} = 200\text{ms (防抖)} + 33.3\text{ms (2x rAF)} + 66.6\text{ms (4x rAF 批次排空)} = \mathbf{299.9\text{ms}}$$
   在近 0.3 秒的时间内，DOM 视觉已按照 CSS flex/grid 伸展，但所有依赖 JS 测量的浮层锚点、Canvas 分辨率、虚拟滚动列表高度完全处于陈旧尺寸状态，造成严重的视觉撕裂与操作失准。

---

## 三、WebView2 独立渲染进程与 Vite dev server 通信与资源水合

### 3.1 CSS Cascade Layers 特异性倒置隐患

- **证据位置**：
  - `apps/crish-desktop/src/index.css:1-27`
  ```css
  @import './styles/tokens.css';
  @import './styles/design-system.css';
  @import './styles/responsive.css';
  @import './styles/z-index.css' layer(base);
  ...
  @import './styles/focus-visible.css' layer(base);
  @import './styles/reduced-motion.css' layer(base);
  @import './styles/sr-only.css' layer(base);
  @import './styles/breakpoints.css' layer(base);
  ```
- **机制与风险剖析**：
  - 根据 W3C CSS Cascading and Inheritance Level 5 规范：**任何未分层（Unlayered）的样式规则，其优先级永远高于分层（Layered）规则**，无论选择器特异性（Specificity）有多高；
  - `z-index.css` 被放置在 `layer(base)` 中，而各业务 CSS Modules（如 `Menu.module.css`、`SidebarContextMenus.module.css`）以及 `shell-menus.css` 均为未分层样式；
  - 若未分层样式中存在任何对 `z-index` 或交互属性的微小覆盖，`layer(base)` 内定义的全局层级规范将被无条件覆盖失效，导致浮层层级在不同编译/合并形态下出现偶发性被遮挡。

### 3.2 Vite HMR 热更新时的 CSS 与 DOM 测量脱节

- **证据位置**：
  - `apps/crish-desktop/vite.config.ts:293-382`
- **机制与风险剖析**：
  1. Vite 在开发模式下将 CSS Modules 编译为 JS 模块，并通过 Vite client 在 `<head>` 动态创建/更新 `<style data-vite-dev-id="...">` 标签。
  2. 当开发者修改 `.module.css` 时，Vite HMR 通过 WebSocket 下发样式更新，DOM 节点的类名保持不变，但 `<style>` 标签内容被即时替换。
  3. **WebView2 的 Layout Invalidation 盲区**：
     - 在 Chromium/WebView2 引擎中，当已挂载的 React Portal 元素（如 `SessionContextMenu`）脱离常规 DOM 树渲染在 `document.body` 根节点下时，仅仅更新 `<style>` 标签内的属性并不一定会触发父级或关联组件的 React `useLayoutEffect` 重跑；
     - 此时，CSS 盒模型的尺寸（padding/margin/min-width）已经发生变化，但 JS 之前测得并写入内联 `style="left: ...px; top: ...px"` 的坐标依然是旧尺寸计算出的值；
     - 最终导致浮层位置与更新后的 CSS 盒模型发生错位脱节，只有通过强制刷新页面或触发新的鼠标事件才能恢复同步。

---

## 四、问题汇总与技术改造建议（无侵入设计推演）

| 缺陷编号   | 影响区域             | 核心根因                                                               | 建议修复方向（推演）                                                                                               |
| :--------- | :------------------- | :--------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| **DEF-01** | `position.ts`        | 预估尺寸先入为主改写原坐标，`measureMenu` 产生二次翻转（Double Flip）  | `clampPosition` 改为纯入参计算，保留原始 anchor 坐标；`measureMenu` 仅根据真实尺寸计算最终偏移，废除两段式坐标修改 |
| **DEF-02** | `Tooltip.tsx`        | 浮点与整型混合（`offsetWidth`），首帧 `clampedPos` 为 `null` 导致 FOUC | 统一使用 `getBoundingClientRect()` 浮点值；首帧计算同步或初始透明隐藏                                              |
| **DEF-03** | Win32 宿主           | `decorations: false` 最大化时缺少 `WM_NCCALCSIZE` 边框补偿             | 在 Rust/Tauri 窗口事件或前端侦测最大化状态，补偿 8px 系统边界偏移                                                  |
| **DEF-04** | 浮层拖拽抢占         | Portal 菜单未声明 `-webkit-app-region: no-drag`                        | 在 `Menu.module.css`、`SessionContextMenu` 等浮层根部统一增加 `-webkit-app-region: no-drag`                        |
| **DEF-05** | `ContextMenuFlyout`  | 三级子菜单使用硬编码 `left: calc(100% + 6px)` 且无边界检测             | 子菜单接入 `Menu` 基座或 `clampPosition` 碰撞避让机制                                                              |
| **DEF-06** | `WindowResizeBridge` | 200ms 防抖 + 2x rAF + 5 个/帧批次刷新导致 300ms+ 布局冻结              | 缩短防抖至 60ms 或 rAF 节流；加大 `FLUSH_BATCH_SIZE` 至 20+                                                        |
| **DEF-07** | `index.css`          | `layer(base)` 与 unlayered 样式混合引发特异性倒置                      | 移除 `layer(base)` 或将整个样式体系统一进行 layer 分层定义                                                         |
