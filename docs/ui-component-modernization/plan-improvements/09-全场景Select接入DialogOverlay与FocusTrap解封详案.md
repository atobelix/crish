# 09 · 全场景 Select 接入 DialogOverlay 与 FocusTrap 解封详案

> **文件标识**：`docs/ui-component-modernization/plan-improvements/09-全场景Select接入DialogOverlay与FocusTrap解封详案.md`  
> **所属战役**：UI 组件现代化与原生原子库升级（`ui-component-modernization`）  
> **方案版本**：v1.0.0 (Production Architecture Improvement Plan)  
> **编制依据**：
> - `docs/ui-component-modernization/analysis/09-全场景Select无法点击与FocusTrap物理封印排查.md`（第一步深度排查报告）
> - `docs/ui-component-modernization/plan-improvements/02-Select与Combobox大圆角同心架构与解耦拆分详案.md`
> - `docs/ui-component-modernization/plan-improvements/03-多行Select文字重叠根治与Menu弹性自适应详案.md`
> - `apps/crish-desktop/src/components/ui/Select/`（Select / Combobox 原子基座源码）
> - `apps/crish-desktop/src/components/ui/Dialog/`（Dialog 基座、FocusTrap、DialogOverlayContext 源码）
> - `apps/crish-desktop/src/styles/`（tokens.css, z-index.css, focus-visible.css）
> - `AGENTS.md`（§13 柔和焦点与克制发丝边框规范、§14 Zero-Blue 现代色彩空间、RL-03 行数门禁）
>
> **工程与架构铁律**：
> 1. **零外部 npm 组件库依赖**：绝对禁止引入第三方组件库（如 `@base-ui`, `@radix-ui`, `framer-motion` 等），所有浮层几何、FocusTrap 隔离状态机、Portal 挂载拓扑与事件响应均采用纯原生 React 18+ 与 CSS Modules 100% 纯净自研；
> 2. **严禁在调研与设计阶段修改任何源码或执行 git 命令**；
> 3. **色彩与发丝边框铁律**：严格遵循 `tokens.css`，纯白卡底 `var(--bg-card, hsl(0 0% 100%))`，边框加深混入比例严格 $\le 10\%$（`border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`）；**彻底剔除 `box-shadow: 0 0 0 1.5px` 扩散外阴影**，坚决杜绝 2.5px 粗黑死边与双重描边，回归 1px 细微发丝边框。

---

## 目录（Table of Contents）

- [一、深层物理封印与视觉违规根因解构](#一深层物理封印与视觉违规根因解构)
  - [1.1 根因一：`DialogOverlayContext` 脱节与 Stacking Context 300 < 1000 物理遮蔽](#11-根因一dialogoverlaycontext-脱节与-stacking-context-300--1000-物理遮蔽)
  - [1.2 根因二：`FocusTrapIsolationManager` 的 `inert=""` 硬件级事件灭活与 Tab 焦点强扯](#12-根因二focustrapisolationmanager-的-inert-硬件级事件灭活与-tab-焦点强扯)
  - [1.3 根因三：`1px border` + `1.5px box-shadow spread` = 2.5px 粗黑边与双重描边](#13-根因三1px-border--15px-box-shadow-spread--25px-粗黑边与双重描边)
- [二、三大核心改进架构设计](#二三大核心改进架构设计)
  - [2.1 架构一：`SelectContent` & `ComboboxContent` 统一消费 `DialogOverlayContext`](#21-架构一selectcontent--comboboxcontent-统一消费-dialogoverlaycontext)
  - [2.2 架构二：`FocusTrapIsolationManager` 白名单解封与 Tab 导航容错保护](#22-架构二focustrapisolationmanager-白名单解封与-tab-导航容错保护)
  - [2.3 架构三：剔除扩散 `box-shadow`，回归 1px 细微发丝边框（AGENTS.md §13）](#23-架构三剔除扩散-box-shadow回归-1px-细微发丝边框agentsmd-13)
- [三、全仓 9 大瘫痪场景穿透解封与无感适配](#三全仓-9-大瘫痪场景穿透解封与无感适配)
  - [3.1 首次启动向导（`WizardKeyStep`, `WizardModelStep`）](#31-首次启动向导wizardkeystep-wizardmodelstep)
  - [3.2 全屏通用设置驱动（`SettingsSchemaRenderer`、字体选择器等）](#32-全屏通用设置驱动settingsschemarenderer字体选择器等)
  - [3.3 设置子面板与表单（`SettingsRulesTab`, `SettingsSecurityTab`, `SkillsSettingsTab`, `McpServerForm`, `WorkflowForm`）](#33-设置子面板与表单settingsrulestab-settingssecuritytab-skillssettingstab-mcpserverform-workflowform)
- [四、核心组件完整重构代码实现（TSX + CSS Modules）](#四核心组件完整重构代码实现tsx--css-modules)
  - [4.1 `apps/crish-desktop/src/components/ui/Select/SelectContent.tsx`](#41-appscrish-desktopsrccomponentsuiselectselectcontenttsx)
  - [4.2 `apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx`](#42-appscrish-desktopsrccomponentsuiselectcomboboxcontenttsx)
  - [4.3 `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx`](#43-appscrish-desktopsrccomponentsuidialogfocustraptsx)
  - [4.4 `apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css`](#44-appscrish-desktopsrccomponentsuiselectselecttriggermodulecss)
  - [4.5 `apps/crish-desktop/src/components/ui/Select/Select.module.css`](#45-appscrish-desktopsrccomponentsuiselectselectmodulecss)
  - [4.6 `apps/crish-desktop/src/components/ui/Select/Combobox.module.css`](#46-appscrish-desktopsrccomponentsuiselectcomboboxmodulecss)
- [五、Vitest 自动化测试套件与验证矩阵](#五vitest-自动化测试套件与验证矩阵)
  - [5.1 `apps/crish-desktop/src/components/ui/Select/__tests__/SelectDialogOverlay.test.tsx`](#51-appscrish-desktopsrccomponentsuiselect__tests__selectdialogoverlaytesttsx)
  - [5.2 `apps/crish-desktop/src/components/ui/Dialog/__tests__/focusTrapSelectWhitelist.test.tsx`](#52-appscrish-desktopsrccomponentsuidialog__tests__focustrapselectwhitelisttesttsx)
  - [5.3 `apps/crish-desktop/src/components/ui/Select/__tests__/SelectHairlineBorder.test.ts`](#53-appscrish-desktopsrccomponentsuiselect__tests__selecthairlinebordertestts)
- [六、落地实施路线图与验收检查清单](#六落地实施路线图与验收检查清单)
  - [6.1 阶段性交付路线图](#61-阶段性交付路线图)
  - [6.2 质量门禁检查清单（Zero Regression Gate）](#62-质量门禁检查清单zero-regression-gate)

---

# 一、深层物理封印与视觉违规根因解构

基于排查报告 `09-全场景Select无法点击与FocusTrap物理封印排查.md` 的排查事实，全场景 Select 无法点击、列表沉入底层、事件被灭活以及粗黑边框的深层根因如下：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                          三大物理死锁与视觉缺陷机理全景图                                   │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  【死锁 1：层叠上下文脱节】                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ <body>                                                                                │  │
│  │   ├── <div data-dialog-overlay="" style="z-index: 1000; position: fixed; inset: 0;">   │  │
│  │   │     └── <div class="dialogFullscreen"> ... <button role="combobox">触发器</button>  │  │
│  │   └── <div data-slot="select-content" style="z-index: 300; position: fixed;">下拉列表 │  │
│  └───────────────────────────────────────────────────────────────────────────────────────┘  │
│      💥 列表被 1000 级 Dialog 实体面板完全盖死在背后，鼠标点击无法触达！                     │
│                                                                                             │
│  【死锁 2：FocusTrap 硬件级事件灭活与焦点抢回】                                             │
│  ┌───────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ FocusTrapIsolationManager:                                                            │  │
│  │   activeTrap = DialogContainer                                                        │  │
│  │   target = <div data-slot="select-content"> (未在 isWhitelisted 白名单)               │  │
│  │   ──> target.setAttribute('inert', ''); target.setAttribute('aria-hidden', 'true');    │  │
│  └───────────────────────────────────────────────────────────────────────────────────────┘  │
│      💥 浏览器排版引擎直接丢弃 PointerDown / Click 事件；Tab 键被 handleKeyDown 强行扯回！ │
│                                                                                             │
│  【缺陷 3：1px border + 1.5px spread box-shadow = 2.5px 粗黑边】                             │
│  ┌───────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ .trigger:focus-visible, .trigger.open {                                               │  │
│  │   border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);│  │
│  │   box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, ...);           │  │
│  │ }                                                                                     │  │
│  └───────────────────────────────────────────────────────────────────────────────────────┘  │
│      💥 扩散阴影与边框合并，呈现 2.5px 粗厚脏黑边框，严重违反 AGENTS.md §13 发丝级规范！   │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1.1 根因一：`DialogOverlayContext` 脱节与 Stacking Context 300 < 1000 物理遮蔽

1. **上下文存在但未消费**：
   - 项目在 [`apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts) 定义了 `DialogOverlayContext`；
   - [`apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx) 在 `overlayEl` 挂载时通过 `<DialogOverlayContext.Provider value={overlayEl}>` 向下注入；
   - 但自研原子组件 [`SelectContent.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx) 与 [`ComboboxContent.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx) 完全没有 `useContext(DialogOverlayContext)`，默认硬编码 fallback 到 `document.body`。
2. **层叠上下文碰撞过程**：
   - `Dialog` 的 `overlay` 具有 `position: fixed; inset: 0; z-index: var(--dialog-z, var(--z-modal));`（`--z-modal: 1000`）；
   - `SelectContent` 作为 `document.body` 的直接子节点，具有 `position: fixed; z-index: var(--z-dropdown, 300);`；
   - 处于同一 Root Stacking Context 下，`z-index: 1000` 必然完全覆盖 `z-index: 300`；
   - 导致 `SelectContent` 虽有坐标且可见，但被 `Dialog` 不透明实体物理遮蔽，点击事件全部被 Dialog 拦截。

---

## 1.2 根因二：`FocusTrapIsolationManager` 的 `inert=""` 硬件级事件灭活与 Tab 焦点强扯

1. **白名单漏网**：
   - [`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx:isWhitelisted`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx#L63-L76) 仅放行了第三方 Radix Popper、Tooltip 和 Toast；
   - 自研组件特征 `data-slot="select-content"`、`data-slot="combobox-content"`、`role="listbox"` 均未在白名单内；
2. **W3C `inert` 属性底层灭活机制**：
   - 当 `FocusTrapIsolationManager` 将 `SelectContent` 标记为 `inert=""` 时，Chromium / WebKit 排版引擎在命中测试（Hit-Testing）阶段直接忽略该节点；
   - 无论鼠标如何点击，`click` / `mousedown` / `pointerdown` 事件在底层被丢弃，React 事件循环根本接收不到事件；
3. **Tab 边界拦截强行抢焦**：
   - `FocusTrap.tsx:handleKeyDown` 判定 `!containerRef.current.contains(document.activeElement)` 为真，按下 Tab 键瞬间触发 `e.preventDefault()` 并将焦点强行扯回 Dialog 首尾元素。

---

## 1.3 根因三：`1px border` + `1.5px box-shadow spread` = 2.5px 粗黑边与双重描边

1. **粗边计算机理**：
   - 在 [`SelectTrigger.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css)、[`Select.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css) 与 [`Combobox.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Combobox.module.css) 中，`:focus-visible`、`.open` 与 `:focus-within` 均定义了：
     ```css
     box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
     border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
     ```
   - 1px border 与 1.5px 外阴影紧密结合，视觉总线宽达到 $1\text{px} + 1.5\text{px} = 2.5\text{px}$；
2. **违背设计规范**：
   - `AGENTS.md` §13 明确要求：**「禁粗黑边、禁输入重影；常规混入 $\le 10\%$（优先 3–6%）；控件柔和边框，严禁使用 1.5px / 2px 扩散外阴影形成粗框」**；
   - 必须彻底清除所有扩散 `box-shadow`，仅保留 1px `border-color` 细微发丝过渡。

---

# 二、三大核心改进架构设计

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                              三大改进技术架构与运行流程                                     │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  【改进 1：统一消费 DialogOverlayContext】                                                  │
│  SelectContent / ComboboxContent:                                                           │
│    const dialogOverlay = useContext(DialogOverlayContext);                                  │
│    const container = portalContainer ?? dialogOverlay ?? document.body;                    │
│    createPortal(contentNode, container);                                                    │
│    ──> 自动成为 <div data-dialog-overlay=""> 子节点，层级继承 1000 级 Stacking Context，     │
│        内部局部 z-index: 300 稳稳压过 Dialog 面板 (z: auto)，且不污染全仓全局层级！         │
│                                                                                             │
│  【改进 2：FocusTrap 白名单全面解封 + 键盘容错】                                            │
│  FocusTrapIsolationManager.isWhitelisted:                                                   │
│    放行 data-slot="select-content"、data-slot="combobox-content"、role="listbox"           │
│    ──> 彻底免除 inert="" 与 aria-hidden 标记，指针事件 100% 直通；                          │
│  FocusTrap.handleKeyDown:                                                                   │
│    放行 activeElement 处于自研浮层内的场景，杜绝 Tab 粗暴扯焦。                            │
│                                                                                             │
│  【改进 3：清除扩散 box-shadow，回归 1px 发丝边框】                                         │
│  SelectTrigger / Combobox:                                                                  │
│    剔除 box-shadow: 0 0 0 1.5px ...；                                                       │
│    保留 border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%) │
│    ──> 视觉保持纯正 1px 精准发丝边框，完全符合 AGENTS.md §13 规范！                         │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2.1 架构一：`SelectContent` & `ComboboxContent` 统一消费 `DialogOverlayContext`

### 1. 容器解析三级降级策略（Fallback Chain）
在 `SelectContent` 与 `ComboboxContent` 中，按以下优先级精准计算 Portal 目标挂载点：

$$\text{ResolvedContainer} = \text{props.portalContainer} \;\succ\; \text{useContext}(\text{DialogOverlayContext}) \;\succ\; \text{document.body}$$

```typescript
const ctx = useSelectContext('SelectContent');
const dialogOverlay = useContext(DialogOverlayContext);

// 三级解析：显式传参 > DialogOverlayContext > document.body
const resolvedContainer =
  portalContainer ??
  dialogOverlay ??
  (typeof document !== 'undefined' ? document.body : null);
```

### 2. 层叠上下文（Stacking Context）拓扑重构
- **当在 Dialog 内**：
  `SelectContent` 挂载到 `<div data-dialog-overlay="">` 节点下。
  - `data-dialog-overlay` 为 `position: fixed; inset: 0; z-index: 1000;`，建立了独立的层叠上下文；
  - `DialogPanel`（`.dialog`）在其内部具有 `position: absolute; z-index: auto`；
  - `SelectContent`（`.content`）在其内部具有 `position: fixed; z-index: var(--z-dropdown, 300)`；
  - 根据 CSS 渲染规则，在同一局部层叠上下文中，`300 > auto`，`SelectContent` 永远、必然渲染在 `DialogPanel` 顶层！
- **当在常规页面（非 Dialog）内**：
  `dialogOverlay` 为 `null`，降级为 `document.body`。`SelectContent` 依然以 `z-index: 300` 覆盖常规工作区内容（`z-index: 0`）。

### 3. `useFloatingPosition` 协同
将 `resolvedContainer` 同时传递给 `useFloatingPosition({ ..., portalContainer: resolvedContainer })`，确保 `useLayerRegistration` 层级调度中枢同步记录正确的宿主容器，保证退栈与 ESC 监听链路完整。

---

## 2.2 架构二：`FocusTrapIsolationManager` 白名单解封与 Tab 导航容错保护

### 1. 白名单判定函数增强（`isWhitelisted`）
在 [`apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx) 中，全面扩充对自研浮层特征的白名单匹配：

```typescript
private isWhitelisted(node: Element): boolean {
  if (
    node.hasAttribute('data-radix-popper-content-wrapper') ||
    node.getAttribute('data-tooltip-portal') === 'true' ||
    node.getAttribute('data-toast-container') === 'true' ||
    node.classList.contains('radix-popper-content-wrapper') ||
    node.classList.contains('toaster') ||
    node.id === 'toast-portal' ||
    node.id === 'tooltip-portal' ||
    // 🌟 自研 Select / Combobox 原子组件白名单放行
    node.getAttribute('data-slot') === 'select-content' ||
    node.getAttribute('data-slot') === 'combobox-content' ||
    node.getAttribute('role') === 'listbox' ||
    node.hasAttribute('data-floating-layer') ||
    node.querySelector?.(
      '[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"]'
    ) != null
  ) {
    return true;
  }
  return false;
}
```

### 2. 键盘 Tab 键边界检测容错
在 `FocusTrap.tsx` 的 `handleKeyDown` 中，增加浮层活动焦点检测：当 `document.activeElement` 位于自研白名单浮层或 Radix Popper 内时，不执行强制将焦点扯回 Dialog 的逻辑，保证键盘焦点漫游平滑：

```typescript
const isInsideFloatingLayer = (el: Element | null): boolean => {
  if (!el) return false;
  return (
    el.closest?.(
      '[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-radix-popper-content-wrapper], [data-floating-layer]'
    ) != null
  );
};

// 在 Tab 检测中：
if (isInsideFloatingLayer(activeEl)) {
  // 焦点在浮层内，交由浮层自身键盘状态机处理，不强行扯回
  return;
}
```

---

## 2.3 架构三：剔除扩散 `box-shadow`，回归 1px 细微发丝边框（AGENTS.md §13）

### 1. 样式剔除清单
1. **`SelectTrigger.module.css`**：
   - 彻底删除 `.trigger:focus-visible` 中的 `box-shadow: 0 0 0 1.5px ...;`
   - 彻底删除 `.trigger.open` 中的 `box-shadow: 0 0 0 1.5px ...;`
   - 从 `transition` 中移除 `box-shadow` 过渡，仅保留 `background-color` 与 `border-color`。
2. **`Select.module.css`**：
   - 同步删除全量 Select 样式的 `.trigger:focus-visible` 与 `.trigger.open` 中的 1.5px 扩散阴影。
3. **`Combobox.module.css`**：
   - 彻底删除 `.comboboxInputWrapper:focus-within` 中的 `box-shadow: 0 0 0 1.5px ...;`
   - 彻底删除 `.chipsWrapper:focus-within` 中的 `box-shadow: 0 0 0 1.5px ...;`
   - 彻底删除 `.chip.chipActive` 中的 `box-shadow: 0 0 0 1.5px ...;`

### 2. 边框加深标准规范（10% 墨阶红线）
聚焦与激活状态下，边框严格遵循 AGENTS.md §13 与 `tokens.css`：
```css
border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
```
- 常态：`1px solid var(--border-color)`；
- Hover 态：`border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)`；
- Focus / Open / Focus-within 态：`border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`；
- **视觉线宽恒定为 1px，零外圈光晕、零粗黑描边**。

---

# 三、全仓 9 大瘫痪场景穿透解封与无感适配

通过本详案改造，全仓 9 大受困于 Dialog 的 Select 实例将获得 100% 自动无感恢复，**无需修改任何业务代码**：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                全仓 9 大瘫痪 Select 实例无感恢复对照表                           │
├────┬─────────────────────────────┬──────────────────────────┬────────────────────────────────────┤
│ 序 │ 业务组件文件及行号          │ 宿主 Dialog              │ 恢复效果与穿透机理解析             │
├────┼─────────────────────────────┼──────────────────────────┼────────────────────────────────────┤
│ 01 │ WizardKeyStep.tsx:49        │ FirstRunWizard (向导)    │ 自动挂载至向导 Overlay，服务商下拉秒开│
│ 02 │ WizardModelStep.tsx:59      │ FirstRunWizard (向导)    │ 自动挂载至向导 Overlay，模型列表可点击│
│ 03 │ SettingsSchemaRenderer.tsx:95│ SettingsPanel (设置全屏) │ 外观风格/代码缩进等 Schema 下拉全解封│
│ 04 │ SettingsSchemaRenderer.tsx:191│ SettingsPanel (设置全屏)│ 字体选择器下拉模式完全正常         │
│ 05 │ SettingsRulesTab.tsx:142    │ SettingsPanel (设置全屏) │ 规则预设下拉选择正常交互           │
│ 06 │ SettingsSecurityTab.tsx:182 │ SettingsPanel (设置全屏) │ 权限安全模式下拉选择正常交互       │
│ 07 │ SkillsSettingsTab.tsx:180   │ SettingsPanel (设置全屏) │ 技能类型过滤下拉框正常展开与选择   │
│ 08 │ McpServerForm.tsx:51        │ SettingsPanel (设置全屏) │ MCP 传输协议下拉列表正常弹出       │
│ 09 │ WorkflowForm.tsx:106        │ SettingsPanel (设置全屏) │ 工作流触发源类型下拉列表正常弹出   │
└────┴─────────────────────────────┴──────────────────────────┴────────────────────────────────────┘
```

---

## 3.1 首次启动向导（`WizardKeyStep`, `WizardModelStep`）
- **业务上下文**：首次运行应用时，`FirstRunWizard` 弹出（`z-index: 1000`），包含服务商选择和模型选择；
- **改造后机制**：
  - `WizardKeyStep` 内 `<Select options={...} />` 实例化 `SelectLegacyAdapter` -> `SelectContent`；
  - `SelectContent` 通过 React Context 读取到 `FirstRunWizard` 提供的 `overlayEl`；
  - 下拉列表直接 Portal 进向导 Overlay 内部（z: 300 > modal backdrop/panel）；
  - `FocusTrapIsolationManager` 白名单放行，用户鼠标点击与键盘方向键选择流畅无阻。

## 3.2 全屏通用设置驱动（`SettingsSchemaRenderer`、字体选择器等）
- **业务上下文**：全屏设置面板（`SettingsPanel`）承载了所有基于 JSON Schema 渲染的配置下拉项（主题、代码格式、网络代理、推理模式等）；
- **改造后机制**：
  - 所有通用 Select 实例通过 Context 自动直通 `SettingsPanel` 的全屏 Overlay；
  - 完全告别被 `dialogFullscreen` 遮蔽的致命 Bug。

## 3.3 设置子面板与表单（`SettingsRulesTab`, `SettingsSecurityTab`, `SkillsSettingsTab`, `McpServerForm`, `WorkflowForm`）
- **业务上下文**：在设置面板的各个垂直 Tab 页及新增 MCP / 工作流弹层表单中的所有选择框；
- **改造后机制**：
  - 继承父级 Dialog 的 Overlay 挂载点；若在多层嵌套弹窗中，自动继承最内层 active Dialog 的 Overlay，多层嵌套弹窗互不干扰。

---

# 四、核心组件完整重构代码实现（TSX + CSS Modules）

以下为本次重构涉及的 6 个核心源码文件的完整实现，严格符合行数门禁与工程红线。

---

## 4.1 `apps/crish-desktop/src/components/ui/Select/SelectContent.tsx`

```tsx
import React, { useCallback, useContext } from 'react';
import { createPortal } from 'react-dom';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { useSelectContext } from './SelectRoot';
import { useFloatingPosition } from './useFloatingPosition';
import type { SelectContentProps } from './types';
import styles from './SelectContent.module.css';

export function SelectContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  edgePadding = 8,
  portalContainer,
  children,
}: SelectContentProps) {
  const ctx = useSelectContext('SelectContent');
  const dialogOverlay = useContext(DialogOverlayContext);

  // 三级解析策略：显式 prop > DialogOverlayContext > document.body
  const resolvedContainer =
    portalContainer ??
    dialogOverlay ??
    (typeof document !== 'undefined' ? document.body : null);

  const handleDismiss = useCallback(() => {
    ctx.setOpen(false);
  }, [ctx]);

  const position = useFloatingPosition({
    open: ctx.open,
    triggerRef: ctx.triggerRef,
    contentRef: ctx.contentRef,
    side,
    align,
    sideOffset,
    edgePadding,
    portalContainer: resolvedContainer,
    onDismiss: handleDismiss,
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (ctx.items.length > 0) {
          ctx.setHighlightedIndex((prev) => {
            const next = prev + 1;
            return next >= ctx.items.length ? 0 : next;
          });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (ctx.items.length > 0) {
          ctx.setHighlightedIndex((prev) => {
            const next = prev - 1;
            return next < 0 ? ctx.items.length - 1 : next;
          });
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        ctx.setHighlightedIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        ctx.setHighlightedIndex(ctx.items.length - 1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (ctx.highlightedIndex >= 0 && ctx.items[ctx.highlightedIndex]) {
          const target = ctx.items[ctx.highlightedIndex];
          if (target && !target.disabled) {
            ctx.selectValue(target.value);
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        ctx.setOpen(false);
        (ctx.triggerRef.current as HTMLElement | null)?.focus();
      }
    },
    [ctx]
  );

  if (!ctx.open) return null;

  const sizeClass =
    ctx.size === 'sm'
      ? styles.contentSm
      : ctx.size === 'lg'
        ? styles.contentLg
        : styles.contentMd;

  const contentClass = [
    styles.content,
    sizeClass,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const contentNode = (
    <div
      ref={ctx.contentRef as React.RefObject<HTMLDivElement>}
      id={ctx.listboxId}
      role="listbox"
      tabIndex={-1}
      aria-orientation="vertical"
      className={contentClass}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        visibility: position.isPositioned ? 'visible' : 'hidden',
        pointerEvents: position.isPositioned ? 'auto' : 'none',
      }}
      onKeyDown={handleKeyDown}
      data-slot="select-content"
      data-floating-layer="true"
      data-side={position.side}
      data-align={position.align}
      data-state={ctx.open ? 'open' : 'closed'}
    >
      <div className={styles.list}>{children}</div>
    </div>
  );

  return resolvedContainer ? createPortal(contentNode, resolvedContainer) : contentNode;
}
```

---

## 4.2 `apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx`

```tsx
import React, { useCallback, useEffect, useContext } from 'react';
import { createPortal } from 'react-dom';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { useComboboxContext } from './ComboboxRoot';
import { useFloatingPosition } from './useFloatingPosition';
import type { ComboboxContentProps } from './types';
import styles from './SelectContent.module.css';

export function ComboboxContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  edgePadding = 8,
  portalContainer,
  children,
}: ComboboxContentProps) {
  const ctx = useComboboxContext('ComboboxContent');
  const dialogOverlay = useContext(DialogOverlayContext);

  // 三级解析策略：显式 prop > DialogOverlayContext > document.body
  const resolvedContainer =
    portalContainer ??
    dialogOverlay ??
    (typeof document !== 'undefined' ? document.body : null);

  const handleDismiss = useCallback(() => {
    ctx.setOpen(false);
  }, [ctx]);

  const position = useFloatingPosition({
    open: ctx.open,
    triggerRef: ctx.triggerRef,
    contentRef: ctx.contentRef,
    side,
    align,
    sideOffset,
    edgePadding,
    portalContainer: resolvedContainer,
    onDismiss: handleDismiss,
  });

  // 自动滚动高亮项到可视区域
  useEffect(() => {
    if (ctx.open && ctx.highlightedIndex >= 0 && ctx.contentRef.current) {
      const activeEl = ctx.contentRef.current.querySelector<HTMLElement>(
        `[data-index="${ctx.highlightedIndex}"]`
      );
      activeEl?.scrollIntoView({ block: 'nearest' });
    }
  }, [ctx.open, ctx.highlightedIndex, ctx.contentRef]);

  if (!ctx.open) return null;

  const contentClass = [
    styles.content,
    styles[`size-${ctx.size}`],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const contentNode = (
    <div
      ref={ctx.contentRef as React.RefObject<HTMLDivElement>}
      id={ctx.listboxId}
      role="listbox"
      tabIndex={-1}
      aria-orientation="vertical"
      className={contentClass}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        visibility: position.isPositioned ? 'visible' : 'hidden',
        pointerEvents: position.isPositioned ? 'auto' : 'none',
      }}
      data-slot="combobox-content"
      data-floating-layer="true"
      data-side={position.side}
      data-align={position.align}
      data-state={ctx.open ? 'open' : 'closed'}
    >
      <div className={styles.list}>{children}</div>
    </div>
  );

  return resolvedContainer ? createPortal(contentNode, resolvedContainer) : contentNode;
}
```

---

## 4.3 `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx`

```tsx
/**
 * ui/Dialog 目录内私有焦点圈定基元（PE-05 T05.1.3, WO-21）
 *
 * 引用计数沙盒与白名单隔离（WO-21 / SPEC-03 / Plan-09）：
 * 1. 建立 FocusTrapIsolationManager 原生 Map<Element, number> inert 引用计数状态机；
 * 2. 精确隔离当前 activeTrapElement 自身，多层嵌套时父级 Dialog 被正确 inert 冻结；
 * 3. 白名单旁路：Radix Popper、Tooltip、Toast 以及自研 Select/Combobox 浮层不打上 aria-hidden / inert；
 * 4. Tab / Shift+Tab 循环锁定与边界 wrap-around 冒泡阻断，支持自研浮层内部焦点豁免。
 */
import React, {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

export interface FocusTrapProps {
  children: ReactNode;
  /** 是否启用 focus trap */
  active: boolean;
  /** 指定初始聚焦元素；不传则自动查找容器内第一个可交互元素 */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable]',
].join(', ');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

interface InertSnapshot {
  hadAriaHidden: boolean;
  originalAriaHidden: string | null;
  hadInert: boolean;
}

class FocusTrapIsolationManager {
  private static instance: FocusTrapIsolationManager;
  private trapStack: HTMLElement[] = [];
  private inertCounts = new Map<Element, number>();
  private snapshots = new Map<Element, InertSnapshot>();

  static getInstance(): FocusTrapIsolationManager {
    if (!FocusTrapIsolationManager.instance) {
      FocusTrapIsolationManager.instance = new FocusTrapIsolationManager();
    }
    return FocusTrapIsolationManager.instance;
  }

  private isWhitelisted(node: Element): boolean {
    if (
      node.hasAttribute('data-radix-popper-content-wrapper') ||
      node.getAttribute('data-tooltip-portal') === 'true' ||
      node.getAttribute('data-toast-container') === 'true' ||
      node.classList.contains('radix-popper-content-wrapper') ||
      node.classList.contains('toaster') ||
      node.id === 'toast-portal' ||
      node.id === 'tooltip-portal' ||
      // 🌟 Plan-09 自研 Select / Combobox 原子浮层白名单放行
      node.getAttribute('data-slot') === 'select-content' ||
      node.getAttribute('data-slot') === 'combobox-content' ||
      node.getAttribute('role') === 'listbox' ||
      node.hasAttribute('data-floating-layer') ||
      node.querySelector?.(
        '[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-floating-layer]'
      ) != null
    ) {
      return true;
    }
    return false;
  }

  pushTrap(trapEl: HTMLElement): void {
    this.trapStack.push(trapEl);
    this.applyIsolation();
  }

  popTrap(trapEl: HTMLElement): void {
    const idx = this.trapStack.lastIndexOf(trapEl);
    if (idx !== -1) {
      this.trapStack.splice(idx, 1);
    }
    this.applyIsolation();
  }

  private restoreNode(node: Element): void {
    const snap = this.snapshots.get(node);
    if (snap) {
      this.snapshots.delete(node);
      if (snap.hadAriaHidden) {
        if (snap.originalAriaHidden != null) {
          node.setAttribute('aria-hidden', snap.originalAriaHidden);
        } else {
          node.removeAttribute('aria-hidden');
        }
      } else {
        node.removeAttribute('aria-hidden');
      }
      if (!snap.hadInert) {
        node.removeAttribute('inert');
      }
    } else {
      node.removeAttribute('aria-hidden');
      node.removeAttribute('inert');
    }
  }

  private applyIsolation(): void {
    const activeTrap =
      this.trapStack.length > 0
        ? this.trapStack[this.trapStack.length - 1]
        : null;
    if (!activeTrap) {
      for (const [node] of Array.from(this.inertCounts.entries())) {
        this.restoreNode(node);
      }
      this.inertCounts.clear();
      this.snapshots.clear();
      return;
    }

    const currentInertTargets = new Set<Element>();
    const docBody = document.body;

    // 1. document.body 层级的所有非包含 activeTrap 的子元素
    if (docBody) {
      for (const child of Array.from(docBody.children)) {
        if (child === activeTrap || child.contains(activeTrap)) continue;
        if (this.isWhitelisted(child)) continue;
        currentInertTargets.add(child);
      }
    }

    // 2. 如果 activeTrap 在某一容器内嵌套，沿 DOM 树向上处理同层兄弟
    let curr: HTMLElement | null = activeTrap.parentElement;
    while (curr && curr !== docBody) {
      for (const child of Array.from(curr.children)) {
        if (child === activeTrap || child.contains(activeTrap)) continue;
        if (this.isWhitelisted(child)) continue;
        currentInertTargets.add(child);
      }
      curr = curr.parentElement;
    }

    // 3. 释放已不需要 inert 的节点
    for (const [node, count] of Array.from(this.inertCounts.entries())) {
      if (!currentInertTargets.has(node)) {
        if (count <= 1) {
          this.inertCounts.delete(node);
          this.restoreNode(node);
        } else {
          this.inertCounts.set(node, count - 1);
        }
      }
    }

    // 4. 对当前需要 inert 的目标施加状态并记录快照
    for (const target of currentInertTargets) {
      const prevCount = this.inertCounts.get(target) || 0;
      this.inertCounts.set(target, prevCount + 1);

      if (prevCount === 0) {
        if (!this.snapshots.has(target)) {
          this.snapshots.set(target, {
            hadAriaHidden: target.hasAttribute('aria-hidden'),
            originalAriaHidden: target.getAttribute('aria-hidden'),
            hadInert: target.hasAttribute('inert'),
          });
        }
        target.setAttribute('aria-hidden', 'true');
        target.setAttribute('inert', '');
      }
    }
  }
}

export function FocusTrap({
  children,
  active,
  initialFocusRef,
}: FocusTrapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const manager = FocusTrapIsolationManager.getInstance();
    manager.pushTrap(container);

    const target =
      initialFocusRef?.current && container.contains(initialFocusRef.current)
        ? initialFocusRef.current
        : getFocusableElements(container)[0];
    target?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (!containerRef.current) return;

      const focusable = getFocusableElements(containerRef.current);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const activeEl = document.activeElement;

      // 如果当前焦点位于自研或白名单浮层内部，交由浮层自身键盘状态机处理
      if (
        activeEl &&
        activeEl.closest?.(
          '[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-radix-popper-content-wrapper], [data-floating-layer]'
        )
      ) {
        return;
      }

      if (e.shiftKey) {
        if (activeEl === first || !containerRef.current.contains(activeEl)) {
          e.preventDefault();
          e.stopPropagation();
          last.focus();
        }
      } else {
        if (activeEl === last || !containerRef.current.contains(activeEl)) {
          e.preventDefault();
          e.stopPropagation();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      manager.popTrap(container);
    };
  }, [active, initialFocusRef]);

  return (
    <div
      ref={containerRef}
      data-focus-trap="true"
      style={{ display: 'contents' }}
    >
      {children}
    </div>
  );
}
```

---

## 4.4 `apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css`

```css
/* ui/Select/SelectTrigger.module.css — 闭合态触发器大圆角与发丝边框样式 */

.trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  width: 100%;
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  background: var(--bg-card, hsl(0 0% 100%));
  color: var(--text-primary);
  font-family: inherit;
  cursor: pointer;
  box-sizing: border-box;
  text-align: left;
  user-select: none;
  position: relative;
  transition:
    background-color var(--transition-micro, 100ms ease),
    border-color var(--transition-micro, 100ms ease);
}

.trigger:hover:not(:disabled) {
  background: var(--tint-hover);
  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
}

/* 🌟 Plan-09 彻底清除 1.5px 粗外阴影，严格保持 1px 发丝边框 (AGENTS.md §13) */
.trigger:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.trigger.open {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.trigger:disabled {
  opacity: var(--opacity-disabled, 0.45);
  cursor: not-allowed;
  background: var(--bg-secondary);
}

/* 尺寸矩阵 */
.triggerSm,
.size-sm {
  height: 28px;
  min-height: 28px;
  padding: 0 8px;
  font-size: var(--font-size-xs, 12px);
  border-radius: var(--radius-md, 6px);
}

.triggerMd,
.size-md {
  height: 32px;
  min-height: 32px;
  padding: 0 10px;
  font-size: var(--font-size-sm, 13px);
  border-radius: var(--radius-lg, 8px);
}

.triggerLg,
.size-lg {
  height: 40px;
  min-height: 40px;
  padding: 0 14px;
  font-size: var(--font-size-md, 14px);
  border-radius: var(--radius-xl, 10px);
}

/* 变体 */
.triggerSoft,
.variant-soft {
  background: var(--bg-secondary);
  border-color: transparent;
}

.triggerSoft:hover:not(:disabled),
.variant-soft:hover:not(:disabled) {
  background: var(--tint-hover);
  border-color: transparent;
}

.triggerOutline,
.variant-outline {
  background: var(--bg-card, hsl(0 0% 100%));
  border-color: var(--border-color, hsl(35 10% 86%));
}

/* 错误态 */
.triggerError {
  border-color: var(--color-error, hsl(0 84% 60%));
}

.startSlot,
.endSlot {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: transform var(--transition-transform, 150ms cubic-bezier(0.16, 1, 0.3, 1));
}

.chevron.open {
  transform: rotate(180deg);
}

.clearBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background-color var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
}

.clearBtn:hover {
  background: var(--tint-hover);
  color: var(--text-primary);
}
```

---

## 4.5 `apps/crish-desktop/src/components/ui/Select/Select.module.css`

```css
/* ui/Select/Select.module.css — Select 完整样式规范（Zero-Blue 墨阶、大圆角同心架构与发丝边框） */

.trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  width: 100%;
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  background: var(--bg-card, hsl(0 0% 100%));
  color: var(--text-primary);
  font-family: inherit;
  cursor: pointer;
  box-sizing: border-box;
  text-align: left;
  user-select: none;
  position: relative;
  transition:
    background-color var(--transition-micro, 100ms ease),
    border-color var(--transition-micro, 100ms ease);
}

.trigger:hover:not(:disabled) {
  background: var(--tint-hover);
  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
}

/* 🌟 Plan-09 彻底清除 1.5px 粗外阴影，严格保持 1px 发丝边框 (AGENTS.md §13) */
.trigger:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.trigger.open {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.trigger:disabled {
  opacity: var(--opacity-disabled, 0.45);
  cursor: not-allowed;
  background: var(--bg-secondary);
}

/* 尺寸矩阵 */
.triggerSm,
.size-sm {
  height: 28px;
  min-height: 28px;
  padding: 0 8px;
  font-size: var(--font-size-xs, 12px);
  border-radius: var(--radius-md, 6px);
}

.triggerMd,
.size-md {
  height: 32px;
  min-height: 32px;
  padding: 0 10px;
  font-size: var(--font-size-sm, 13px);
  border-radius: var(--radius-lg, 8px);
}

.triggerLg,
.size-lg {
  height: 40px;
  min-height: 40px;
  padding: 0 14px;
  font-size: var(--font-size-md, 14px);
  border-radius: var(--radius-xl, 10px);
}

/* 变体 */
.triggerSoft,
.variant-soft {
  background: var(--bg-secondary);
  border-color: transparent;
}

.triggerSoft:hover:not(:disabled),
.variant-soft:hover:not(:disabled) {
  background: var(--tint-hover);
  border-color: transparent;
}

.triggerOutline,
.variant-outline {
  background: var(--bg-card, hsl(0 0% 100%));
  border-color: var(--border-color, hsl(35 10% 86%));
}

/* 错误态 */
.triggerError {
  border-color: var(--color-error, hsl(0 84% 60%));
}

.startSlot,
.endSlot {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: transform var(--transition-transform, 150ms cubic-bezier(0.16, 1, 0.3, 1));
}

.chevron.open {
  transform: rotate(180deg);
}

.clearBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background-color var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
}

.clearBtn:hover {
  background: var(--tint-hover);
  color: var(--text-primary);
}
```

---

## 4.6 `apps/crish-desktop/src/components/ui/Select/Combobox.module.css`

```css
/* ui/Select/Combobox.module.css — 搜索输入框、Chips 胶囊与发丝边框样式 */

.comboboxInputWrapper {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
  width: 100%;
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  background: var(--bg-card, hsl(0 0% 100%));
  color: var(--text-primary);
  border-radius: var(--radius-lg, 8px);
  box-sizing: border-box;
  padding: 0 10px;
  position: relative;
  transition:
    border-color var(--transition-micro, 100ms ease);
}

/* 🌟 Plan-09 彻底清除 1.5px 粗外阴影，回归 1px 发丝边框 (AGENTS.md §13) */
.comboboxInputWrapper:focus-within {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.comboboxInputWrapper.size-sm {
  height: 28px;
  min-height: 28px;
  border-radius: var(--radius-md, 6px);
  padding: 0 8px;
}

.comboboxInputWrapper.size-md {
  height: 32px;
  min-height: 32px;
  border-radius: var(--radius-lg, 8px);
  padding: 0 10px;
}

.comboboxInputWrapper.size-lg {
  height: 40px;
  min-height: 40px;
  border-radius: var(--radius-xl, 10px);
  padding: 0 14px;
}

.comboboxInput {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
  padding: 0;
}

.comboboxInput::placeholder {
  color: var(--text-tertiary);
}

.startSlot,
.endSlot {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.clearBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background-color var(--transition-micro, 100ms ease), color var(--transition-micro, 100ms ease);
}

.clearBtn:hover {
  background: var(--tint-hover);
  color: var(--text-primary);
}

.chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

/* 多选 Chips 容器 */
.chipsWrapper {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-height: 32px;
  padding: 3px 8px;
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  background: var(--bg-card, hsl(0 0% 100%));
  border-radius: var(--radius-lg, 8px);
  box-sizing: border-box;
  cursor: text;
  transition:
    border-color var(--transition-micro, 100ms ease);
}

/* 🌟 Plan-09 彻底清除 1.5px 粗外阴影，回归 1px 发丝边框 (AGENTS.md §13) */
.chipsWrapper:focus-within {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

/* 胶囊 Chip */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm, 4px);
  font-size: var(--font-size-xs, 12px);
  color: var(--text-primary);
  user-select: none;
  box-sizing: border-box;
  transition:
    background-color var(--transition-micro, 100ms ease),
    border-color var(--transition-micro, 100ms ease);
}

/* 🌟 Plan-09 彻底清除 1.5px 粗外阴影，回归 1px 发丝边框 (AGENTS.md §13) */
.chip.chipActive {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.chipLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chipRemove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: 2px;
}

.chipRemove:hover {
  color: var(--text-primary);
  background: var(--tint-hover);
}
```

---

# 五、Vitest 自动化测试套件与验证矩阵

编写 3 套完备的单元测试，全面覆盖 DialogOverlay 穿透、FocusTrap 白名单免除与发丝边框静态检测。

---

## 5.1 `apps/crish-desktop/src/components/ui/Select/__tests__/SelectDialogOverlay.test.tsx`

```tsx
// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Select } from '../Select';
import { Dialog } from '../../Dialog/Dialog';
import { DialogOverlayContext } from '../../Dialog/dialogOverlayContext';

describe('Select: DialogOverlayContext Integration Suite (Plan 09)', () => {
  it('在 DialogOverlayContext 下自动 portal 到 overlay 容器中', () => {
    const mockOverlay = document.createElement('div');
    mockOverlay.setAttribute('data-dialog-overlay', '');
    document.body.appendChild(mockOverlay);

    render(
      <DialogOverlayContext.Provider value={mockOverlay}>
        <Select
          defaultOpen={true}
          options={[
            { id: 'opt1', label: '选项一' },
            { id: 'opt2', label: '选项二' },
          ]}
        />
      </DialogOverlayContext.Provider>
    );

    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    // 断言 listbox 挂载在 mockOverlay 内部，而不是 document.body 直接子节点
    expect(mockOverlay.contains(listbox)).toBe(true);

    document.body.removeChild(mockOverlay);
  });

  it('在真实 Dialog 弹窗内打开 Select 时，选项能被正常点击选中', () => {
    function TestDialogSelect() {
      const [val, setVal] = useState('none');
      return (
        <Dialog open={true} title="测试弹窗">
          <div data-testid="selected-display">{val}</div>
          <Select
            value={val}
            onChange={(v) => setVal(v)}
            options={[
              { id: 'apple', label: '苹果' },
              { id: 'banana', label: '香蕉' },
            ]}
          />
        </Dialog>
      );
    }

    render(<TestDialogSelect />);

    // 点击触发器
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    // 下拉列表可见
    const option = screen.getByRole('option', { name: '香蕉' });
    expect(option).toBeInTheDocument();

    // 点击选项
    fireEvent.click(option);

    // 状态成功更新
    expect(screen.getByTestId('selected-display')).toHaveTextContent('banana');
  });

  it('在非 Dialog 常规环境下，Select 自动优雅 fallback 挂载至 document.body', () => {
    render(
      <Select
        defaultOpen={true}
        options={[{ id: 'plain', label: '普通环境' }]}
      />
    );

    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(document.body.contains(listbox)).toBe(true);
  });
});
```

---

## 5.2 `apps/crish-desktop/src/components/ui/Dialog/__tests__/focusTrapSelectWhitelist.test.tsx`

```tsx
// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FocusTrap } from '../focusTrap';
import { Select } from '../../Select/Select';

describe('FocusTrap: Select Whitelist & Event Unblocking Suite (Plan 09)', () => {
  it('FocusTrap 激活时，自研 SelectContent 与 role="listbox" 节点不被施加 inert 与 aria-hidden', () => {
    render(
      <div>
        <FocusTrap active={true}>
          <div data-testid="trap-content">
            <button>弹窗内按钮</button>
          </div>
        </FocusTrap>
        <div
          data-slot="select-content"
          role="listbox"
          data-testid="external-select"
        >
          <button role="option">外置下拉项</button>
        </div>
      </div>
    );

    const externalSelect = screen.getByTestId('external-select');
    // 白名单放行断言
    expect(externalSelect).not.toHaveAttribute('inert');
    expect(externalSelect).not.toHaveAttribute('aria-hidden');
  });

  it('在 FocusTrap 激活且焦点处于 SelectContent 内部时，按下 Tab 键不会被强行扯回弹窗起点', () => {
    render(
      <div>
        <FocusTrap active={true}>
          <div data-testid="trap-content">
            <button data-testid="trap-btn-1">按钮 1</button>
            <button data-testid="trap-btn-2">按钮 2</button>
          </div>
        </FocusTrap>
        <div data-slot="select-content" role="listbox">
          <button data-testid="select-option-1" role="option">选项 1</button>
        </div>
      </div>
    );

    const selectOption = screen.getByTestId('select-option-1');
    selectOption.focus();
    expect(document.activeElement).toBe(selectOption);

    // 派发 Tab 键
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tabEvent);

    // 断言焦点依然处于浮层内或未被强制 reset 到 trap-btn-1
    expect(tabEvent.defaultPrevented).toBe(false);
  });
});
```

---

## 5.3 `apps/crish-desktop/src/components/ui/Select/__tests__/SelectHairlineBorder.test.ts`

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function getFileContent(relPath: string): string {
  const target = `../../../../${relPath}`;
  const absPath = fileURLToPath(new URL(target, import.meta.url));
  return readFileSync(absPath, 'utf8');
}

describe('Select & Combobox: 1px Hairline Border Guardrails (Plan 09)', () => {
  it('SelectTrigger.module.css 中零 1.5px 扩散外阴影', () => {
    const css = getFileContent('src/components/ui/Select/SelectTrigger.module.css');
    expect(css).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+1\.5px/);
    expect(css).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+2px/);
  });

  it('Select.module.css 中零 1.5px 扩散外阴影', () => {
    const css = getFileContent('src/components/ui/Select/Select.module.css');
    // 允许浮层下拉阴影 (0 12px 32px ...)，严禁 0 0 0 1.5px 边框阴影
    expect(css).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+1\.5px/);
  });

  it('Combobox.module.css 中零 1.5px 扩散外阴影', () => {
    const css = getFileContent('src/components/ui/Select/Combobox.module.css');
    expect(css).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+1\.5px/);
  });

  it('所有 Select/Combobox 聚焦态 border-color 混入比例严格 <= 10%', () => {
    const files = [
      'src/components/ui/Select/SelectTrigger.module.css',
      'src/components/ui/Select/Select.module.css',
      'src/components/ui/Select/Combobox.module.css',
    ];

    for (const rel of files) {
      const css = getFileContent(rel);
      const regex = /border(-color)?:\s*color-mix\([^;]*?var\(--text-primary\)\s*(\d+)%/g;
      let match;
      while ((match = regex.exec(css)) !== null) {
        const pct = parseInt(match[2], 10);
        expect(pct).toBeLessThanOrEqual(10);
      }
    }
  });
});
```

---

# 六、落地实施路线图与验收检查清单

## 6.1 阶段性交付路线图

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Plan-09 落地实施里程碑甘特图                                      │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  [M1: 原子组件接入]  ──► SelectContent & ComboboxContent 接入 DialogOverlayContext          │
│                          (3级 fallback 解析容器，同步接入 useFloatingPosition)              │
│                                                                                             │
│  [M2: FocusTrap 解封]──► focusTrap.tsx isWhitelisted 扩充自研白名单 + Tab 导航容错          │
│                          (彻底清除 inert="" 灭活，解封原生指针与点击事件)                   │
│                                                                                             │
│  [M3: 边框视觉瘦身]  ──► SelectTrigger / Select / Combobox CSS 剔除 1.5px 阴影              │
│                          (回归纯正 1px 发丝级微加深边框，消除 2.5px 粗黑死边)               │
│                                                                                             │
│  [M4: 全仓集成回归]  ──► 首次向导 / 设置全屏 / 表单等 9 大瘫痪场景实机验收 + 自动化测试通过  │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6.2 质量门禁检查清单（Zero Regression Gate）

| 序号 | 审查维度 | 严格验证标准 | 状态 |
| :---: | :--- | :--- | :---: |
| **G-01** | **DialogOverlayContext 接入** | `SelectContent` 与 `ComboboxContent` 统一消费 Context，在 Dialog 内渲染于 Overlay 节点下 | 待实施 |
| **G-02** | **Fallback 容器解析** | 非 Dialog 场景无缝降级至 `document.body`，不抛出异常 | 待实施 |
| **G-03** | **FocusTrap 白名单** | `[data-slot="select-content"]`、`[data-slot="combobox-content"]`、`[role="listbox"]` 零 `inert` 属性 | 待实施 |
| **G-04** | **鼠标点击事件直通** | 向导与全屏设置中点击 Select 选项立即触发 `onChange` 并关闭浮层 | 待实施 |
| **G-05** | **键盘导航与 Tab 防抢** | 浮层内焦点不被 FocusTrap 强行拉回，方向键与 Enter/Space 选值正常 | 待实施 |
| **G-06** | **2.5px 粗边彻底清除** | 触发器 `:focus-visible` / `.open` 零 `box-shadow` 扩散，纯 1px 发丝边框 | 待实施 |
| **G-07** | **Design Tokens 合规** | 边框加深混入比例 $\le 10\%$，纯白卡底 `var(--bg-card)`，无冷蓝偏色 | 待实施 |
| **G-08** | **9 大业务场景全解封** | FirstRunWizard、SettingsPanel (Schema/Rules/Security/Skills/MCP/Workflow) 实机 100% 畅通 | 待实施 |
| **G-09** | **零外部依赖** | 100% 纯自研原生 React + CSS Modules，零新增 npm 包 | 待实施 |
| **G-10** | **自动化测试通过率** | `SelectDialogOverlay.test.tsx`、`focusTrapSelectWhitelist.test.tsx`、`SelectHairlineBorder.test.ts` 100% PASS | 待实施 |

---

*本详案由调研与排查专家编制，已完成全仓代码拓扑与样式架构的无缝推演，可作为后续开发阶段的最高执行依据。*
