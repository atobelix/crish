# DOM 几何渲染与滚动穿透隔离深度审计报告

> **文档标识**：`docs/model-capability/plan-reviews/05-DOM几何渲染与滚动隔离深度审计.md`  
> **审计日期**：2026-09-03  
> **审计目标**：
> 1. [`00-AI服务商与模型管理全面重构终极方案.md`](file:///c:/Software/conex/docs/model-capability/00-AI服务商与模型管理全面重构终极方案.md)
> 2. [`05-视口弹性布局与滚动穿透根治方案.md`](file:///c:/Software/conex/docs/model-capability/analysis/05-视口弹性布局与滚动穿透根治方案.md)
> 3. [`07-下拉级联菜单双滚动条消除与交互打磨方案.md`](file:///c:/Software/conex/docs/model-capability/analysis/07-下拉级联菜单双滚动条消除与交互打磨方案.md)  
> **关联源码基线**：
> - [`SettingsPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx) / [`SettingsPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css)
> - [`SettingsUI.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.tsx) / [`SettingsUI.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.module.css)
> - [`ModelsSettingsTab.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx) / [`ModelsSettingsTab.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css)
> - [`ModelProfileList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx) / [`ModelConfigEditor.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx)
> - [`Dialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx) / [`focusTrap.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx) / [`dialogOverlayContext.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts)
> - [`Menu.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.tsx) / [`position.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/position.ts) / [`SafeTriangle.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts)
> - [`useLayerRegistration.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/layer-registration/useLayerRegistration.ts)  
> **审计裁决**：**有条件通过（CONDITIONAL PASS · 发现 3 项重大隐患与 2 项临界退化，需执行刚性加固）**

---

## 一、 审计结论与裁决总览

经过对目标方案在 DOM 盒模型几何受力、事件流转管线（Event Pipeline）、浏览器硬件合成层（Compositor Layer）、React Fiber/DOM 双树映射、LayerStack 浮层拓扑及 W3C WAI-ARIA 无障碍规范的穷举级跨层穿透审计：

### 1.1 方案优点与架构突破（认可项）
1. **彻底拔除魔术数字与纯逻辑规划**：方案 05 准确定位了 `calc(100vh - 220px)` 导致外层恒定溢出 88px+ 的根本病因，通过 `fillViewport` 建立了自顶向下的纯 CSS Flexbox 弹性链（`flex: 1 1 0; min-height: 0;`），完全遵循反退避与反打补丁原则。
2. **滚动上下文单一化收敛**：方案 07 准确剖析了 `Menu` 与 `.cascadeList` 套娃导致的“并列双滚动条”，将外壳装饰与滚动职责完全收敛至 `<Menu>` 基座，解耦非常彻底。
3. **安全三角动态同构**：方案 07 纠正了历史遗留的展开方向（`right` vs `left`）与向量叉积计算的 180° 方向背离，消除了 4px 间隙闪退。

### 1.2 审计发现的重大隐患与缺陷（待加固项）
| 缺陷编号 | 严重级别 | 涉及文件 / 方案 | 核心隐患摘要 |
| :--- | :--- | :--- | :--- |
| **DEF-GEO-01** | **高危 (High)** | 方案 05 §4.4 & §4.6 (`ModelConfigEditor`) | **极扁视口/高 DPI 下固定头部（`mrdPinnedHeader`）物理截断不可用**：在窗口高度 $< 650\text{px}$ 或 150% DPI 缩放下，当用户展开手动添加模型表单（`ManualAddForm`）且为自定义服务商时，固定头高达 296px，超过右侧总高度，导致操作按钮被 `overflow: hidden` 永久切断且无法滚动。 |
| **DEF-A11Y-01** | **致命 (Critical)** | 方案 07 §4.2 (`ModelsCascadeSelect`) | **LayerStack 缺失 `parentId` 导致点击二级菜单误判 Outside Click 闪退**：`useLayerRegistration` 注册二级菜单时未传入 `parentId: menuId`，导致父级 `<Menu>` 的 `onPointerDownOutside` 判定该点击为外部点击并立刻关闭菜单，子项点击事件被阻断。 |
| **DEF-A11Y-02** | **致命 (Critical)** | 方案 07 §4.2 与基座 `focusTrap.tsx` | **FocusTrap 白名单排除导致外部 Portal 浮层被 `inert` 物理冻结与 Tab 焦点扯回**：若二级菜单挂载至 `document.body`，因未携带 `data-floating-layer` 等白名单属性，被 `FocusTrapIsolationManager` 施加 `inert` 属性导致不可交互；按下 Tab 键时焦点被暴力重置回弹窗起点。 |
| **DEF-WHL-01** | **中危 (Medium)** | 方案 05 §4.2 (`SettingsPanel.tsx`) | **`handleRootWheel` 优化不彻底与双倍速缺陷漏网**：仅对 `safeActiveTab === 'models'` 阻断，但未在全全局消除 `target === contentAreaRef.current` 时的双倍速原生+JS叠加滚动缺陷；且 `onWheel.stopPropagation` 忽略了多层嵌套对话框的潜在隔离。 |
| **DEF-GEO-02** | **中危 (Medium)** | 方案 07 §4.2 (`position.ts` 结合) | **极窄分屏（300px~500px）下二级菜单重叠退化态导致安全三角失效**：当屏幕左右空间均不足 200px 时，钳位算法导致二级菜单完全重叠在主菜单之上，光标直接落入子菜单内部引发非预期的进入/离开抖动。 |

---

## 二、 视口弹性布局与 DOM 几何受力深度分析（300px ~ 4K 宽屏 & DPI 缩放）

### 2.1 自顶向下 Flex 弹性高度传导力学拓扑

当前设置面板在全屏/大窗口下的垂直几何受力与高度继承链路如下所示：

```
[Window Viewport] (高: H_vp, 宽: W_vp)
 └── Dialog (Fullscreen, fixed inset: 0, height: 100vh)
      └── FocusTrap (display: contents)
           └── .settingsPanel (height: 100%, display: flex, flex-direction: column)
                ├── .coverHeader [WindowControls] (H = 36px, flex-shrink: 0)  <── 刚性占位
                └── .coverBody (flex: 1 1 0, min-height: 0, overflow: hidden, display: flex)
                     ├── SettingsSidebar (width: 240px, flex-shrink: 0)
                     └── .coverContent[data-settings-tab="models"]
                          ├── display: flex, flex-direction: column
                          ├── flex: 1 1 0, min-height: 0, height: 100%
                          ├── padding: 20px 32px 24px (上下占用: 44px)
                          ├── overflow: hidden; overscroll-behavior: none; <── 刚性抹除外层滚动
                          └── SettingsPage (fillViewport = true)
                               ├── .settingsUiPageFill (flex: 1 1 0, min-height: 0, height: 100%)
                               ├── .settingsUiPageHead (H ≈ 36px, flex-shrink: 0, gap: 12px)
                               └── .settingsUiPageBodyFill (flex: 1 1 0, min-height: 0, height: 100%)
                                    ├── [默认模型卡片容器] (flex-shrink: 0, H ≈ 84px, gap: 12px)
                                    └── .modelsSplit (flex: 1 1 0, min-height: 0, height: 100%)
                                         ├── .modelsRail (width: 220px, flex-shrink: 0)
                                         │    ├── .mrlHeader (flex-shrink: 0)
                                         │    └── .mrlList (flex: 1 1 0, min-height: 0, overflow-y: auto)
                                         └── .modelsDetail (flex: 1 1 0, min-width: 0, min-height: 0)
                                              └── .mrdBody (flex: 1 1 0, min-height: 0, height: 100%)
                                                   ├── .mrdPinnedHeader (flex-shrink: 0)  <── ⚠️ 几何应力集中点
                                                   └── .mrdModelListScroll (flex: 1 1 0, min-height: 0, overflow-y: auto)
```

### 2.2 极端视口与高 DPI 缩放受力极限测算（Stress Test Calculations）

#### 场景 1：标准 1080p 笔记本在 Windows 150% 缩放下（逻辑视口 $1280 \times 720$）
- 除去 Windows 底部任务栏（约 40px），窗口可用高度 $H_{\text{avail}} = 680\text{px}$。
- 扣除顶栏与外层边距：
  - 顶栏：$36\text{px}$
  - `coverContent` 边距：$20 + 24 = 44\text{px}$
  - `settingsUiPageHead` 及间距：$36 + 12 = 48\text{px}$
  - “默认模型”卡片及间距：$84 + 12 = 96\text{px}$
  - **进入 `.modelsSplit` 前的物理消耗**：$36 + 44 + 48 + 96 = 224\text{px}$。
- `.modelsSplit` 可分得的高度：$H_{\text{split}} = 680 - 224 = 456\text{px}$。
- `.modelsDetail` 内边距：$16 \times 2 = 32\text{px}$，剩余高度：$424\text{px}$。
- **此时如果在右侧展开自定义服务商的 `ManualAddForm`**：
  - `ProfileHeader`：$40\text{px}$
  - `ProviderProfileForm`（Base URL + Key）：$72\text{px}$
  - `ModelListHeader`（搜索框 + 工具栏）：$36\text{px}$
  - `ManualAddForm`（3 个输入框 + CapEditor + 按钮）：$156\text{px}$
  - `mrdPinnedHeader` 间距（gap: 12px $\times 3$）：$36\text{px}$
  - **`mrdPinnedHeader` 占用总高**：$40 + 72 + 36 + 156 + 36 = 340\text{px}$！
- **结果分析**：
  - 模型列表滚动区 `.mrdModelListScroll` 仅剩：$424 - 340 = 84\text{px}$。虽然狭窄，但由于 `min-height: 0` 和 `overflow-y: auto`，列表仍能滚动浏览。

#### 场景 2：极限扁平窗口（用户调整窗口为 $H = 500\text{px}$，或分屏模式）——【DEF-GEO-01 爆破点】
- 可用高度 $H_{\text{avail}} = 500\text{px}$。
- 顶层必要消耗：$224\text{px}$。
- `.modelsSplit` 可用高度：$500 - 224 = 276\text{px}$。
- `.modelsDetail` 内部可用净高：$276 - 32 = 244\text{px}$。
- 此时 `mrdPinnedHeader` 需求高度为 $340\text{px}$：
  $$\Delta H = 244\text{px} - 340\text{px} = -96\text{px} \quad (\text{严重溢出！})$$
- **致命后果**：
  1. `.mrdPinnedHeader` 设置了 `flex-shrink: 0;`，拒绝收缩；
  2. `.mrdModelListScroll` 的 `flex: 1 1 0` 被挤压至 $0\text{px}$ 完全不可见；
  3. 父容器 `.modelsDetail` 设置了 `overflow: hidden;`；
  4. **`ManualAddForm` 底部的「取消」与「确认添加」按钮被物理裁切，且没有任何滚动条可以滑到该位置，用户陷入无法完成添加也无法取消的死锁状态！**

#### 场景 3：4K 超宽屏（$3840 \times 2160$）下 `max-width` 局限
- `SettingsUI.module.css` 声明了 `max-width: var(--settings-content-max, 820px);`。
- 在 4K 宽屏下，整个屏幕宽度 $3840\text{px}$，设置面板居中占据仅 $820\text{px}$，左右两侧留白各达 $1510\text{px}$。
- 在这狭窄的 $820\text{px}$ 中，左侧服务商栏强占 $220\text{px}$，中间仅留 $600\text{px}$ 给模型工作区，造成严重的巨屏空间浪费；而在常规宽屏（$1920\text{px}$）下亦显得局促。

### 2.3 几何受力加固方案
1. **解除固定头刚性死锁（Elastic Header Cap）**：
   在 `.mrdPinnedHeader` 上声明最大高度限制并允许自身在极限场景下弹性滚动：
   ```css
   .mrdPinnedHeader {
     display: flex;
     flex-direction: column;
     gap: var(--space-3, 12px);
     flex-shrink: 0;
     max-height: min(60%, 360px); /* 刚性上限保护，至少保留 40% 给列表 */
     overflow-y: auto;           /* 极限小屏时头区内部滚动，绝不截断按钮 */
     scrollbar-width: thin;
   }
   ```
2. **工作区型 Tab 释放 `max-width` 约束**：
   在 `SettingsUI.module.css` 的 `.settingsUiPageFill` 中，将 `max-width` 覆盖为 `min(1280px, 100%)` 或 `none`，让工作区在宽屏下饱满舒展。

---

## 三、 事件捕获/冒泡链路与滚动隔离深度审计

### 3.1 滚轮事件（Wheel Event）双轨流转机制

在 React 桌面应用中，存在「浏览器原生 DOM 滚动引擎」与「React 合成事件（SyntheticEvent）冒泡系统」两条并发链路：

```
[用户在 mrdModelListScroll 区域拨动滚轮]
  │
  ├─────────────────────────────────────────────────────────────────────────────┐
  │ 链路 A：浏览器原生渲染管线 (GPU Compositor Thread)                           │ 链路 B：React 合成事件派发 (JS Main Thread)
  ▼                                                                             ▼
[Native Wheel Event on DOM Element]                                           [React Root Listener (#root)]
  │                                                                             │
  ├── 检查当前元素 overflow-y: auto?                                            ├── 沿着 Fiber 树自底向上派发 onWheel
  │    ├── 是 ➔ 消耗 deltaY，更新 mrdModelListScroll.scrollTop                   │    │
  │    └── 否 ➔ 准备向上链式传递 (Scroll Chaining)                              │    ▼
  │                                                                             │   [ModelList 容器: onWheel={e => e.stopPropagation()}]
  ├── 检查边界: 抵达 Top (0) 或 Bottom (scrollHeight - clientHeight)?           │    │
  │    ├── 未触底/顶 ➔ 在当前容器完成滚动，终止                                  │    └── 【关键断点】调用 e.stopPropagation()
  │    └── 触底/顶 ➔ 检查 overscroll-behavior:                                  │         │
  │         ├── auto ➔ 沿 DOM 树向上寻找祖先滚动容器 (Scroll Chaining)           │         └── 阻止 React 合成事件冒泡到父级！
  │         │    └─ 祖先 .coverContent 被迫接盘滚动 ➔ 【产生穿透 Bug!】         │              │
  │         └── contain / none ➔ 硬件合成层强行吸收动量，阻断传递！              │              ▼
  │              └─ 【方案 05 成功防御！】                                       │        [SettingsPanel.tsx: handleRootWheel]
  │                                                                             │         由于冒泡已断，handleRootWheel 根本不被触发！
  ▼                                                                             ▼
[浏览器原生滚动结束]                                                           [React 事件循环结束]
```

### 3.2 `onWheel.stopPropagation` 的副作用穿透评估

方案 05 在 `mrdModelListScroll` 上挂载了 `onWheel={(e) => e.stopPropagation()}`。我们对其内部可能包含的所有表单与富文本控件进行了副作用穷举审计：

| 内部控件类型 | 真实场景示例 | 是否受 `onWheel.stopPropagation` 负面影响 | 深度机理分析 |
| :--- | :--- | :---: | :--- |
| **原生 `<textarea>`** | 模型 Prompt 系统预设 / 描述输入框 | **否（安全）** | 滚轮在 `<textarea>` 内部滚动时，事件从 `<textarea>` 向外冒泡。`e.stopPropagation()` 位于其父级 `mrdModelListScroll` 上，子元素的原生滚动与自身内部事件已被消费，不受父级阻断影响。 |
| **原生 `<select>` / 自研 `<Select>`** | 思考强度选择器（`thinkingLevel`） | **否（安全）** | 自研 `Select` 的展开内容 `SelectContent` 是通过 Portal 挂载在外部 `dialogOverlay` 中的，根本不在 `mrdModelListScroll` DOM 树内；而触发器上的滚动天然不产生额外行为。 |
| **数字输入框 `<input type="number">`** | 上下文长度输入框 | **否（安全）** | 现代浏览器与规范均禁止滚轮在非聚焦的数字输入框上修改数值；聚焦时的微调发生在元素自身，父级的阻断不会拦截元素自身捕获。 |
| **代码编辑器（`YamlConfigEditorModal`）** | 内置 YAML 配置文件代码编辑器 | **否（安全）** | 代码编辑器位于独立的大型弹窗（`<Dialog size="lg">`）中，通过 Portal 挂载在最外层 `document.body` 或 `#modal-root`，完全脱离模型管理页面的 DOM 拓扑，零耦合。 |

### 3.3 `handleRootWheel` 的全局隐患与 2x 双倍速漏洞修复

审查当前 `SettingsPanel.tsx` 源码现状（第 215-231 行）：
```tsx
const handleRootWheel = (e: React.WheelEvent) => {
  if (contentAreaRef.current) {
    const target = e.target as HTMLElement;
    if (
      target.closest('textarea') ||
      target.closest('pre') ||
      target.closest('select')
    )
      return;
    if (
      contentAreaRef.current.contains(target) &&
      target !== contentAreaRef.current  // ⚠️ 漏洞根源
    )
      return;
    contentAreaRef.current.scrollTop += e.deltaY;
  }
};
```

#### 审计结论与漏洞溯源：
1. 当用户鼠标悬停在 `contentAreaRef.current`（即 `.coverContent`）的 padding 空白区域（上 20px、下 24px、左右 32px）或子组件间的 gap 上时，`e.target === contentAreaRef.current`。
2. 条件 `target !== contentAreaRef.current` 判定为 **`false`**！
3. 函数不会 return，而是强行执行 `contentAreaRef.current.scrollTop += e.deltaY;`。
4. 与此同时，浏览器底层原生也在对 `.coverContent` 执行基于 `deltaY` 的原生平滑滚动。
5. **两者叠加，直接导致滚动位移扩大为 2 倍，且伴随剧烈的视觉跳跃与加速度失控（Double Scroll Acceleration）！**
6. 方案 05 提出的加固代码（第 366-371 行）将条件修正为：
   ```tsx
   if (contentAreaRef.current.contains(target)) {
     return;
   }
   ```
   **该修正彻底封杀了 2x 狂飙 bug，审计确认有效**。
7. **进一步加固要求**：该修复应推广至全部 Tab，而不仅仅在 `models` 标签页生效。在 `models` 标签页下，直接在函数入口处硬性 `return;`。

---

## 四、 Portal 挂载、React 上下文传递与 Tab 键焦点流深度审计

### 四维交互拓扑映射图：

```
[React Virtual Tree (Fiber)]                        [Real Browser DOM Tree]
 Dialog (SettingsPanel)                              #document
   └── DialogOverlayContext.Provider value={overlay}   ├── body
        └── ModelsSettingsTab                           │    ├── div#modal-root
             └── ModelsCascadeSelect                    │    │    └── div.settingsCoverOverlay [data-dialog-overlay]
                  ├── Menu (Radix Popover)              │    │         ├── FocusTrap (display: contents)
                  │    └── MenuContext ({ menuId })     │    │         │    └── div.settingsPanel
                  │         └── cascadeList             │    │         │         └── ... ModelsCascadeSelect Trigger
                  │                                     │    │         │
                  └── createPortal ─────────────────────┼────┼─────────┼── div.cascadeFlyoutPortal (Portal 子节点)
                       (保留 React Context 访问权)        │    │         │    │  (脱离了 Menu 的 DOM 包含块)
                                                        │    │         │    ▼
                                                        │    │         └── ⚠️ 必须正确接入 LayerStack & FocusTrap!
```

### 4.1 React Context 在 Portal 跨宿主挂载中的连续性验证
- **React 规范断言**：在 React 16+ 中，Portal 仅改变 DOM 节点的挂载宿主，**绝不改变 React 组件树的父子层级关系**。
- **验证结果**：
  - `ModelsCascadeSelect` 内部调用的 `useContext(DialogOverlayContext)` 能够 100% 稳定获取外层 `Dialog` 注入的 `overlayEl` DOM 句柄；
  - 若处于全屏设置面板中，Portal 容器被正确解析为 `dialogOverlay`；
  - 若在独立浮层或无 Dialog 环境下，平滑回退至 `document.body`。
  - **上下文传递链完全健康，无断裂风险**。

### 4.2 【重大缺陷 DEF-A11Y-01】LayerStack 缺失 `parentId` 导致子菜单点击闪退

#### 代码病灶审查（方案 07 §4.2 第 455-464 行）：
```tsx
// 方案 07 拟定的代码：
useLayerRegistration(
  {
    id: submenuLayerId,
    type: 'cascade-submenu',
    dismissible: true,
    onDismiss: closeSubmenu,
    elementRef: flyoutRef,
    // 致命缺失：未声明 parentId: menuId！
  },
  Boolean(flyProfileId && flyoutPlacement)
);
```

#### 崩溃链路全景推导：
1. `<Menu>` 基座内部持有全局唯一的 `menuId`（通过 `useId()` 生成），并通过 `MenuContext.Provider` 向下广播；
2. 当二级菜单展开并渲染在 Portal 中时，用户点击二级菜单中的某个模型选项（`.cascadeOption`）；
3. 鼠标指针按下时，Radix Popover 的 `Popover.Content` 触发原生 `onPointerDownOutside` 事件；
4. 审查 `Menu.tsx` 第 322-340 行的守卫逻辑：
   ```tsx
   onPointerDownOutside={(e) => {
     ...
     const isDescendant = layerStackService
       .getDescendants(menuId)
       .some((child) => {
         const el = resolveElement(child.elementRef);
         return el && target && el.contains(target);
       });
     if (isDescendant) {
       e.preventDefault(); // 仅当点击目标属于 menuId 的后代浮层时，才豁免关闭！
     }
   }}
   ```
5. 因为方案 07 在注册 `submenuLayerId` 时**完全没有传入 `parentId: menuId`**，`layerStackService` 内部构建的树状拓扑中，`submenuLayerId` 是一个孤立的根节点，并非 `menuId` 的子节点；
6. `layerStackService.getDescendants(menuId)` 返回的数组中**根本不包含二级子菜单**！
7. `isDescendant` 被判定为 **`false`**！
8. `e.preventDefault()` 未能执行，Radix Popover 判定用户点击了菜单外部，**立即强行派发关闭事件将整个主菜单卸载销毁**！
9. **结果**：用户点击模型的一瞬间，菜单瞬间崩溃消失，模型选择可能未生效或触发未预期的状态震荡。

#### 刚性加固补丁：
在 `ModelsCascadeSelect` 中必须消费 `MenuContext`：
```tsx
import { MenuContext } from '../ui/Menu/Menu';

// 组件内部：
const { menuId } = useContext(MenuContext);

useLayerRegistration(
  {
    id: submenuLayerId,
    type: 'cascade-submenu',
    parentId: menuId ?? undefined, // 🌟 关键修复：显式锚定父子拓扑链
    dismissible: true,
    onDismiss: closeSubmenu,
    elementRef: flyoutRef,
  },
  Boolean(flyProfileId && flyoutPlacement)
);
```

---

### 4.3 【重大缺陷 DEF-A11Y-02】FocusTrap 沙盒与 `inert` 对二级菜单的物理冻结

#### 机制穿透分析：
查看 `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx` 的实现：
1. `SettingsPanel` 由 `Dialog variant="fullscreen"` 承载，内部激活了 `FocusTrap active={open}`；
2. `FocusTrapIsolationManager` 负责保证模态弹窗的可访问性，它会遍历 `document.body` 下的所有兄弟子节点：
   ```typescript
   // focusTrap.tsx 第 138-145 行
   if (docBody) {
     for (const child of Array.from(docBody.children)) {
       if (child === activeTrap || child.contains(activeTrap)) continue;
       if (this.isWhitelisted(child)) continue;
       currentInertTargets.add(child);
     }
   }
   ```
3. 对所有非白名单的外部节点，强行施加 `inert` 和 `aria-hidden="true"` 属性！
4. **如果 `ModelsCascadeSelect` 的 Portal 挂载到 `document.body`**（例如 `dialogOverlay` 为空回退）：
   - `.cascadeFlyoutPortal` 位于 `document.body` 根部；
   - 它不在 `activeTrap` 内部；
   - 审查 `focusTrap.tsx` 的白名单函数 `isWhitelisted`（第 63-84 行）：
     ```typescript
     private isWhitelisted(node: Element): boolean {
       if (
         node.hasAttribute('data-radix-popper-content-wrapper') ||
         node.getAttribute('data-tooltip-portal') === 'true' ||
         node.getAttribute('data-slot') === 'select-content' ||
         node.getAttribute('role') === 'listbox' ||
         node.hasAttribute('data-floating-layer') ||
         ...
       ) return true;
       return false;
     }
     ```
   - 方案 07 拟定的 `.cascadeFlyoutPortal` **没有设置上述任何一个属性**！
   - `isWhitelisted` 返回 `false`！
   - **浏览器直接对 `.cascadeFlyoutPortal` 注入 `inert=""`，导致整个二级菜单彻底被禁用，鼠标 hover 无效、click 点击无响应、文字无法选中！**

5. **Tab 键焦点劫持陷阱（Tab Key Stealing Trap）**：
   查看 `focusTrap.tsx` 第 224-248 行的键盘监听：
   ```typescript
   if (
     activeEl &&
     activeEl.closest?.(
       '[data-slot="select-content"], [role="listbox"], [data-floating-layer]'
     )
   ) {
     return; // 豁免自研浮层内部的键盘操作
   }

   if (e.shiftKey) {
     if (activeEl === first || !containerRef.current.contains(activeEl)) {
       e.preventDefault();
       last.focus(); // 暴力扯回
     }
   } else {
     if (activeEl === last || !containerRef.current.contains(activeEl)) {
       e.preventDefault();
       first.focus(); // 暴力扯回
     }
   }
   ```
   如果焦点进入未打标的二级菜单，用户按下 `Tab` 键，因为 `!containerRef.current.contains(activeEl)` 成立且不在白名单内，**`FocusTrap` 会判定焦点越界逃逸，立即 `preventDefault()` 并把焦点强行拉回弹窗开头的搜索框，菜单瞬间失焦闭合！**

#### 刚性加固补丁：
在 `cascadeFlyoutPortal` 容器元素上必须强制声明标记属性：
```tsx
<div
  ref={flyoutRef}
  data-floating-layer="true"           // 🌟 放行白名单 1：免疫 inert 冻结
  data-slot="cascade-submenu-content"  // 语义槽位
  role="listbox"                       // 🌟 放行白名单 2：免疫 Tab 焦点暴力扯回
  aria-label="模型列表"
  className={styles.cascadeFlyoutPortal}
  style={{ ... }}
>
```

---

### 4.4 键盘漫游状态机补齐（Keyboard Navigation Matrix）

方案 07 在设计陈述中提出支持键鼠分离，但在落地代码中缺失了具体的键盘事件绑定。为达到 `AGENTS.md` §7.1 立体验证要求，必须提供完备的键盘事件响应机理：

```
[键盘事件在 cascadeRow 上触发]
  │
  ├── 按下 ArrowDown ➔ 焦点切换至下一个 Provider Profile
  ├── 按下 ArrowUp   ➔ 焦点切换至上一个 Provider Profile
  ├── 按下 ArrowRight (或展开方向对应的按键):
  │    ├── 若当前行包含模型 ➔ 执行 openSubmenu(p.id)，将焦点转移至二级菜单首个可用模型项
  │    └── 若当前方向为翻转向左 (isFlippedLeft) ➔ 响应 ArrowLeft 进入
  ├── 按下 Enter / Space ➔ 同 ArrowRight 展开子菜单
  │
[键盘事件在 cascadeFlyoutPortal 选项上触发]
  │
  ├── 按下 ArrowDown / ArrowUp ➔ 循环聚焦选项（跳过 disabled）
  ├── 按下 ArrowLeft (或进入的反方向):
  │    └── 关闭二级菜单，将焦点平滑归还给父级对应 Provider Profile 行（保持连续性）
  ├── 按下 Enter / Space ➔ 选中当前模型，触发 onChange，关闭整个级联菜单
  └── 按下 Escape ➔ 仅关闭二级菜单并归还焦点至主行；第二次 Escape 才关闭主 Menu
```

---

## 五、 几何向量算法与安全三角鲁棒性审计

### 5.1 浮点数叉积容差加固（IEEE 754 Epsilon Tolerance）

审查 `apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts`：
```typescript
export function isPointInTriangle(
  m: Point2D,
  a: Point2D,
  b: Point2D,
  c: Point2D
): boolean {
  const cp1 = crossProduct(a, b, m);
  const cp2 = crossProduct(b, c, m);
  const cp3 = crossProduct(c, a, m);

  const hasNeg = cp1 < 0 || cp2 < 0 || cp3 < 0;
  const hasPos = cp1 > 0 || cp2 > 0 || cp3 > 0;

  return !(hasNeg && hasPos);
}
```

#### 临界缺陷推演：
- 在 125%、150% 等分数 DPI 缩放下，鼠标移动事件返回的 `e.clientX` 与 `e.clientY` 包含浮点小数（如 `128.45px`）；
- 当光标恰好沿着三角形边线（如光标刚滑出服务商行右侧边缘）移动时，向量叉积在理论上为 0，但受 IEEE 754 双精度浮点舍入误差影响，可能计算出 `-1.4210854715202004e-14`；
- 这导致一个微小的负数被判定为 `hasNeg = true`，而另外两个边为正数 `hasPos = true`；
- **结果**：`!(hasNeg && hasPos)` 返回 `false`，光标明明处于三角区边界，却被误判为“已离开三角区”，导致 300ms Grace Period 意外中断，二级菜单出现偶发性微小闪退！

#### 刚性加固补丁：
引入 `EPSILON = 1e-4` 容差判定：
```typescript
const EPSILON = 1e-4;
const hasNeg = cp1 < -EPSILON || cp2 < -EPSILON || cp3 < -EPSILON;
const hasPos = cp1 > EPSILON || cp2 > EPSILON || cp3 > EPSILON;
return !(hasNeg && hasPos);
```

### 5.2 极窄视口重叠退化态（Overlap Degradation）与光标迷航

在 300px~450px 极窄视口（或桌面双窗口平铺 1/4 屏幕）下：
- 视口总宽 $W = 380\text{px}$；
- 主菜单宽 $220\text{px}$，二级菜单宽 $200\text{px}$；
- 空间需求 $220 + 200 + 4 = 424\text{px} > 380\text{px}$，左右任何一侧均无法完全容纳子菜单；
- `calculateSubmenuPosition` 的数学双向钳位会保证 $X \ge 8\text{px}$ 且 $X \le 380 - 200 - 8 = 172\text{px}$；
- **几何物理现象**：二级菜单被迫部分或全部“压在”主菜单之上展开（重叠面积 $> 50\%$）；
- **此时光标行为**：
  - 当光标还在主菜单行内时，它可能已经进入了重叠后的二级菜单包围盒；
  - `SafeTriangle.ts` 中根据光标和子菜单边界生成的三角形发生退化（底边和顶点反向重合）；
  - `onMouseLeave` 频繁触发。
- **降级保护规则**：
  若检测到 `spaceLeft < submenuWidth && spaceRight < submenuWidth`（即完全重叠态）：
  将二级菜单的 `transformOrigin` 设为 `center`，并跳过安全三角判断，光标移入即刻激活，移出即刻收起；或者触发移动端抽屉/全屏选择器降级。

---

## 六、 综合安全保障加固实施规范

为指导后续落地实施，将上述各项审计加固措施收敛为精准的代码修改规范：

### 6.1 `ModelsCascadeSelect.tsx` 完整加固方案
```tsx
// apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx 对应重构
import React, {
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import {
  profileDisplayLabel,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { formatModelDisplayName } from '../../api/modelCatalog';
import styles from './ModelsSettingsTab.module.css';
import { Menu } from '../ui';
import { MenuContext } from '../ui/Menu/Menu'; // 🌟 引入 MenuContext 获取 parentId
import { DialogOverlayContext } from '../ui/Dialog/dialogOverlayContext';
import { useLayerRegistration } from '../ui/internal/layer-registration/useLayerRegistration';
import { SafeTriangleTracker } from '../ui/internal/SafeTriangle';
import {
  calculateSubmenuPosition,
  type SubmenuPlacementResult,
} from '../ui/Menu/position';

interface ModelsCascadeSelectProps {
  profiles: ProviderProfile[];
  activeProfileId: string;
  activeModelId: string;
  onChange: (profileId: string, modelId: string) => void;
}

export const ModelsCascadeSelect: React.FC<ModelsCascadeSelectProps> = ({
  profiles,
  activeProfileId,
  activeModelId,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [flyProfileId, setFlyProfileId] = useState<string | null>(null);
  const [flyoutPlacement, setFlyoutPlacement] = useState<SubmenuPlacementResult | null>(null);

  const safeTrackerRef = useRef(new SafeTriangleTracker(300));
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const flyoutRef = useRef<HTMLDivElement | null>(null);

  const dialogOverlay = useContext(DialogOverlayContext);
  const { menuId } = useContext(MenuContext); // 🌟 读取父级菜单 ID
  const submenuLayerId = useId();

  const enabledProfiles = useMemo(() => {
    return profiles.filter((p) => p.enabled !== false && p.models.length > 0);
  }, [profiles]);

  const activeProfile = enabledProfiles.find((p) => p.id === activeProfileId);
  const activeLabel =
    activeProfile && activeModelId
      ? `${profileDisplayLabel(activeProfile).replace(/\s*\/\s*默认$/, '')} · ${formatModelDisplayName(
          activeProfile.id,
          activeModelId
        )}`
      : '请选择默认模型...';

  const closeSubmenu = useCallback(() => {
    safeTrackerRef.current.reset();
    setFlyProfileId(null);
    setFlyoutPlacement(null);
  }, []);

  const openSubmenu = useCallback((profileId: string) => {
    const rowEl = rowRefs.current.get(profileId);
    if (!rowEl) return;
    const rect = rowEl.getBoundingClientRect();
    const placement = calculateSubmenuPosition(rect, 200, 280, 4, 8, 'right');
    // 对坐标执行亚像素四舍五入，消除高 DPI 模糊
    placement.x = Math.round(placement.x);
    placement.y = Math.round(placement.y);
    setFlyoutPlacement(placement);
    setFlyProfileId(profileId);
  }, []);

  const currentFlyProfile = useMemo(() => {
    return enabledProfiles.find((p) => p.id === flyProfileId) ?? null;
  }, [enabledProfiles, flyProfileId]);

  // 🌟 核心加固 1：绑定 parentId 与注册浮层，彻底根除 Outside Click 误杀
  useLayerRegistration(
    {
      id: submenuLayerId,
      type: 'cascade-submenu',
      parentId: menuId ?? undefined, // 传递父级 ID
      dismissible: true,
      onDismiss: closeSubmenu,
      elementRef: flyoutRef,
    },
    Boolean(flyProfileId && flyoutPlacement)
  );

  return (
    <Menu
      openState={{
        open,
        onOpenChange: (nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) closeSubmenu();
        },
      }}
      position={{ align: 'start', side: 'bottom', sideOffset: 4 }}
      panel={{ contentClassName: styles.cascadeMenuContent }}
      trigger={
        <button
          type="button"
          className={styles.cascadeSelectTrigger}
          style={{ minWidth: '220px', justifyContent: 'space-between' }}
        >
          <span className={styles.cascadeSelectValue}>{activeLabel}</span>
          <Lucide.ChevronDown
            size={14}
            style={{ opacity: 0.6, flexShrink: 0 }}
          />
        </button>
      }
    >
      <div
        className={styles.cascadeList}
        role="menu"
        onMouseLeave={() => {
          if (!safeTrackerRef.current.isGraceActive()) {
            closeSubmenu();
          }
        }}
      >
        <div className={styles.addMenuTitle}>选择服务商与模型</div>

        {enabledProfiles.length === 0 ? (
          <div className={styles.cascadeEmpty}>暂无已启用的可用模型</div>
        ) : (
          enabledProfiles.map((p) => {
            const isFly = flyProfileId === p.id;
            const isCurrentActive = p.id === activeProfileId;
            const cleanLabel = profileDisplayLabel(p).replace(/\s*\/\s*默认$/, '');
            const isFlippedLeft = isFly && flyoutPlacement?.side === 'left';

            return (
              <div
                key={p.id}
                role="menuitem"
                tabIndex={0}
                ref={(el) => {
                  if (el) rowRefs.current.set(p.id, el);
                  else rowRefs.current.delete(p.id);
                }}
                className={`${styles.cascadeRow} ${isFly ? styles.isOpen : ''}`}
                onMouseEnter={(e) => {
                  if (flyProfileId && flyProfileId !== p.id) {
                    if (safeTrackerRef.current.isGraceActive()) {
                      const isSafe = safeTrackerRef.current.check({
                        x: e.clientX,
                        y: e.clientY,
                      });
                      if (isSafe) return;
                    }
                  }
                  openSubmenu(p.id);
                }}
                onMouseLeave={(e) => {
                  if (isFly && flyoutRef.current && flyoutPlacement) {
                    const rect = flyoutRef.current.getBoundingClientRect();
                    safeTrackerRef.current.enter(
                      { x: e.clientX, y: e.clientY },
                      rect,
                      flyoutPlacement.side
                    );
                  }
                }}
                onKeyDown={(e) => {
                  // 键盘向右展开支持
                  if (e.key === 'ArrowRight' || e.key === 'Enter') {
                    e.preventDefault();
                    openSubmenu(p.id);
                  }
                }}
              >
                <span
                  style={{
                    fontWeight: isCurrentActive ? '500' : 'normal',
                    flex: 1,
                  }}
                >
                  {cleanLabel}
                </span>

                {isFlippedLeft ? (
                  <Lucide.ChevronLeft size={14} className={styles.cascadeChev} />
                ) : (
                  <Lucide.ChevronRight size={14} className={styles.cascadeChev} />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 🌟 核心加固 2：注入 data-floating-layer 与 role="listbox"，免疫 FocusTrap inert 与 Tab 焦点扯回 */}
      {currentFlyProfile && flyoutPlacement &&
        createPortal(
          <div
            ref={flyoutRef}
            data-floating-layer="true"
            data-slot="cascade-submenu-content"
            role="listbox"
            aria-label={`${currentFlyProfile.name || currentFlyProfile.id} 模型列表`}
            className={styles.cascadeFlyoutPortal}
            style={{
              left: `${flyoutPlacement.x}px`,
              top: `${flyoutPlacement.y}px`,
              transformOrigin: flyoutPlacement.transformOrigin,
            }}
            onMouseEnter={() => safeTrackerRef.current.reach()}
            onMouseLeave={() => closeSubmenu()}
          >
            {currentFlyProfile.models.map((m) => {
              const selected =
                currentFlyProfile.id === activeProfileId && m === activeModelId;
              return (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`${styles.cascadeOption} ${selected ? styles.isOn : ''}`}
                  onClick={() => {
                    onChange(currentFlyProfile.id, m);
                    closeSubmenu();
                    setOpen(false);
                  }}
                >
                  <span className={styles.cascadeOptionText}>
                    {formatModelDisplayName(currentFlyProfile.id, m)}
                  </span>
                  {selected && (
                    <Lucide.Check size={14} className={styles.cascadeCheck} />
                  )}
                </button>
              );
            })}
          </div>,
          dialogOverlay ?? document.body
        )}
    </Menu>
  );
};
```

### 6.2 `ModelsSettingsTab.module.css` 弹性加固方案
```css
/* 优化一：为右侧顶部固定区域设置安全弹性上限与局部滚动，防止小屏截断 */
.mrdPinnedHeader {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
  flex-shrink: 0;
  max-height: min(60%, 360px); /* 🌟 刚性上限保护 */
  overflow-y: auto;           /* 🌟 极限小高视口时自身滚动，杜绝操作按钮被物理裁切 */
  scrollbar-width: thin;
}

/* 优化二：为二级 Portal 浮层赋予精准 z-index 阶梯与抗锯齿优化 */
.cascadeFlyoutPortal {
  position: fixed;
  min-width: 190px;
  max-width: 260px;
  max-height: 280px;
  height: auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--border-color) transparent;
  z-index: calc(var(--z-dropdown-menu, 2000) + 10); /* 🌟 阶梯层级压制 */
  background: var(--sep-bg-panel, var(--bg-elevated));
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  box-shadow: var(--shadow-dropdown, 0 12px 32px -4px rgba(0, 0, 0, 0.18));
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  animation: cascadeFlyoutEnter 120ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  will-change: transform, opacity;
}
```

---

## 七、 立体验证断言与门禁检查清单（Verification Matrix）

为确保加固方案在实施后不发生任何几何坍塌或事件回潮，制定以下立体化验证矩阵：

### 7.1 刚性自动化验收断言（Automated Invariants）

| 断言编号 | 验证目标 | 实施断言方法 | 预期物理/逻辑结果 |
| :--- | :--- | :--- | :--- |
| **AST-GEO-01** | 极小高度视口截断防护 | 将窗口高度设为 480px，展开 `custom` 服务商的 `ManualAddForm` | `mrdPinnedHeader` 的 `scrollHeight > clientHeight` 时滚动条激活，底部「保存」按钮完全可滚动见并可点击 |
| **AST-GEO-02** | 4K 宽屏布局伸展 | 视口设为 $3840 \times 2160$ | `.modelsSplit` 宽度突破 820px 限制，自适应占满工作区，无大量无意义白边 |
| **AST-A11Y-01** | LayerStack 拓扑链完整性 | 展开二级菜单后，断言 `layerStackService.getDescendants(menuId)` | 数组包含 `submenuLayerId`，且 `parentId === menuId` |
| **AST-A11Y-02** | 外部点击豁免断言 | 模拟在二级菜单内触发 `pointerdown` | 父级 `Menu` 的 `onPointerDownOutside` 执行 `e.preventDefault()`，菜单保持打开 |
| **AST-A11Y-03** | FocusTrap 白名单豁免断言 | 处于 Fullscreen Dialog 下展开二级菜单 | `.cascadeFlyoutPortal` 无 `inert` 属性，无 `aria-hidden="true"` 属性 |
| **AST-A11Y-04** | Tab 键焦点不脱靶断言 | 将焦点移至二级菜单选项，派发 Tab 事件 | `FocusTrap` 不调用 `preventDefault()`，焦点不被强行拉回弹窗开头的搜索框 |
| **AST-WHL-01** | 表单滚轮隔离与冒泡阻断 | 在模型列表中滚动滚轮 | 外层 `.coverContent.scrollTop === 0` 恒成立，且输入框自身输入不受影响 |
| **AST-VEC-01** | 浮点数叉积容差断言 | 构造点 $M$ 距边线 $-10^{-12}$ 的极限浮点坐标 | `isPointInTriangle(M, A, B, C)` 返回 `true`，不发生误判退出 |

### 7.2 真实环境现场验收（4000 Tauri MCP 通道）
依据 `AGENTS.md` §15~16 调试通道唯一合法口径：
1. 在桌面真实宿主环境（125%、150% Windows DPI 笔记本）中打开「设置 -> 模型」；
2. 连续快速滑动滚轮、甩动无阻尼滚轮，检查页面大标题与全局默认模型是否发生哪怕 1px 的垂直位移；
3. 打开全局默认模型下拉，斜向快速滑入二级模型列表，检查是否有任何闪退；
4. 点击二级菜单中的非当前模型，检查是否瞬时完成选择并优雅闭合，控制台零未捕获异常。

---

## 八、 审计结论签发

本审计报告对方案 00、05、07 的几何布局弹性、事件捕获/冒泡链路与 Portal 交互生命周期进行了全面穿透，指出了关键的截断隐患与 LayerStack / FocusTrap 集成漏洞，并提供了完整的代码级加固补丁。

**签发裁决**：**批准进入 Wave 1 落地实施（APPROVED WITH REINFORCEMENTS）**，实施团队须直接吸收本文 §6 的加固补丁规范，严格落实立体验证矩阵。
