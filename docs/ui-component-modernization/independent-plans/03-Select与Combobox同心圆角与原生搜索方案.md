# Conex / Crish — Select 与 Combobox 同心圆角与原生搜索方案

> **文档版本**：v1.0 (Production Master Architecture Plan)  
> **文件路径**：`docs/ui-component-modernization/independent-plans/03-Select与Combobox同心圆角与原生搜索方案.md`  
> **调研对齐资产**：
> - `reference/appica-ui/packages/react/src/components/select/select.tsx`
> - `reference/appica-ui/packages/react/src/components/combobox/combobox.tsx`
> - `apps/crish-desktop/src/components/ui/Select/`（现存单体 Select）
> - `apps/crish-desktop/src/components/ui/Menu/position.ts`（浮层几何定位单源引擎）
> - `apps/crish-desktop/src/components/ui/internal/layer-stack/`（浮层层级中枢）
> - `apps/crish-desktop/src/styles/tokens.css`（Zero-Blue 墨阶设计令牌）
>
> **红线纪律**：严禁引入 `@base-ui/react` 或 `@radix-ui/react-select` 等外部新组件库；基于项目既有自研基础设施（纯函数定位引擎 + LayerStack），采用原生 React + CSS Modules 完整复刻 Appica UI 的极致设计与工程架构。

---

## 目录

- [一、现状痛点与架构断层深度剖析](#一现状痛点与架构断层深度剖析)
  - [1.1 现存 Select 的架构缺陷](#11-现存-select-的架构缺陷)
  - [1.2 Combobox 的功能缺失](#12-combobox-的功能缺失)
  - [1.3 核心重构目标与收益对照](#13-核心重构目标与收益对照)
- [二、同心圆角与尺寸矩阵几何标准](#二同心圆角与尺寸矩阵几何标准)
  - [2.1 数学同心几何体系与公式](#21-数学同心几何体系与公式)
  - [2.2 三档标准化尺寸矩阵（sm / md / lg）](#22-三档标准化尺寸矩阵sm--md--lg)
  - [2.3 设计令牌（Design Tokens）映射与 Zero-Blue 契约](#23-设计令牌design-tokens映射与-zero-blue-契约)
- [三、Select / Combobox 统一复合组件架构设计](#三select--combobox-统一复合组件架构设计)
  - [3.1 复合组件模式（Compound Components）优势](#31-复合组件模式compound-components优势)
  - [3.2 Select 复合组件谱系与状态模型](#32-select-复合组件谱系与状态模型)
  - [3.3 Combobox 复合组件谱系与状态模型](#33-combobox-复合组件谱系与状态模型)
  - [3.4 Context 状态中枢与 Hook 契约](#34-context-状态中枢与-hook-契约)
- [四、零依赖 Floating 定位与视口碰撞翻折解算引擎](#四零依赖-floating-定位与视口碰撞翻折解算引擎)
  - [4.1 几何测量与 Anchor Width 动态同步](#41-几何测量与-anchor-width-动态同步)
  - [4.2 视口避让与双向翻折算法（Flip Y / Flip X）](#42-视口避让与双向翻折算法flip-y--flip-x)
  - [4.3 平滑弹性缩放进场动画与 Transform Origin 联动](#43-平滑弹性缩放进场动画与-transform-origin-联动)
  - [4.4 LayerStack 浮层中枢装配与防脱节调度](#44-layerstack-浮层中枢装配与防脱节调度)
- [五、Raycast 级全键盘无障碍漫游与 IME 状态机](#五raycast-级全键盘无障碍漫游与-ime-状态机)
  - [5.1 WAI-ARIA 1.2 语义拓扑与属性矩阵](#51-wai-aria-12-语义拓扑与属性矩阵)
  - [5.2 全键盘漫游状态机与行为规范](#52-全键盘漫游状态机与行为规范)
  - [5.3 IME 输入法合成锁状态机（Composition Guard）](#53-ime-输入法合成锁状态机composition-guard)
  - [5.4 快捷键删除与一键清空机制（Clearable Flow）](#54-快捷键删除与一键清空机制clearable-flow)
- [六、Chips 多选排版与内嵌搜索过滤系统](#六chips-多选排版与内嵌搜索过滤系统)
  - [6.1 ComboboxChips 原地自适应排版引擎](#61-comboboxchips-原地自适应排版引擎)
  - [6.2 选值胶囊（ComboboxChip）与微型删除交互](#62-选值胶囊comboboxchip与微型删除交互)
  - [6.3 原生搜索匹配与关键词高亮渲染器](#63-原生搜索匹配与关键词高亮渲染器)
- [七、完整 TypeScript 契约与 API 规范](#七完整-typescript-契约与-api-规范)
  - [7.1 Select 家族 TypeScript 类型契约](#71-select-家族-typescript-类型契约)
  - [7.2 Combobox 家族 TypeScript 类型契约](#72-combobox-家族-typescript-类型契约)
  - [7.3 兼容适配器（SelectLegacyAdapter）实现](#73-兼容适配器selectlegacyadapter实现)
- [八、CSS Modules 视觉规范与发丝边框设计](#八css-modules-视觉规范与发丝边框设计)
  - [8.1 `Select.module.css` 完整规范](#81-selectmodulecss-完整规范)
  - [8.2 `Combobox.module.css` 完整规范](#82-comboboxmodulecss-完整规范)
- [九、单元测试与反回归验证设计](#九单元测试与反回归验证设计)
  - [9.1 Select 自动化测试用例集](#91-select-自动化测试用例集)
  - [9.2 Combobox 自动化测试用例集](#92-combobox-自动化测试用例集)
- [十、实施路线图与验收门禁](#十实施路线图与验收门禁)
  - [10.1 5 步精细化实施路线图](#101-5-步精细化实施路线图)
  - [10.2 质量门禁清单](#102-质量门禁清单)

---

# 一、现状痛点与架构断层深度剖析

## 1.1 现存 Select 的架构缺陷

当前项目中 `apps/crish-desktop/src/components/ui/Select/Select.tsx` 存在显著的架构短板：

1. **单体式（Monolithic Props）黑盒架构**：
   - 依赖单一的大型 Props 接口（`options: SelectOption[]`），消费方无法自由插入分组、分割线、头部操作、自定义前缀（`startSlot`）或后缀（`endSlot`）；
   - 无法实现复杂的富文本项排版与自定义 JSX 嵌套。
2. **几何圆角与尺寸脱节（Radius Disconnect）**：
   - 现存 Trigger 使用 `border-radius: var(--radius-md, 6px)`，高度 32px / 28px；
   - 浮层 Popup 使用 `border-radius: 14px`，内部选项 Item 使用 `border-radius: 8px`；
   - Trigger 与 Popup 的圆角、内边距缺乏严格的同心曲率数学约束，视觉上存在「方圆不匹配」的粗糙感。
3. **定位与宽度缺乏联动（Anchor Width Mismatch）**：
   - 现存实现依托通用 `Menu` 基座，浮层默认使用 `min-width: 180px`，无法根据 Trigger 的真实物理宽度自动缩放（`width: var(--anchor-width)`）；
   - 导致在宽输入场景（如 300px 以上的模型选择器）中，下拉浮层缩在一角，极不协调。
4. **一键清除与快捷键交互缺失**：
   - 缺乏像 Appica UI 那样优雅的内嵌清除按钮（`clearable`）；
   - 不支持在 Trigger 聚焦态下按 `Delete / Backspace` 直接清空选值。

## 1.2 Combobox 的功能缺失

项目中目前**完全缺失**独立的 `Combobox`（可输入过滤下拉选择器）基础组件：

1. **搜索选型困难**：在模型列表、知识库标签、工具集、Session 分类等超过 10 项的场景中，用户必须滚动长列表肉眼查找，无法原地快速键入拼音或关键字过滤；
2. **多选标签（Chips Inline Wrap）真空**：当前多选场景多采用分散的 Checkbox 列表或多级菜单，缺乏现代 CLI / AI 工作台中标配的「输入框内嵌入 Chips 胶囊 + 键入过滤 + 倒格删除」的高密度排版基元。

## 1.3 核心重构目标与收益对照

| 维度 | 现存实现 (`ui/Select`) | 重构目标 (`Select` & `Combobox`) |
|---|---|---|
| **组件架构** | 单体 Props（`options: []`） | 统一复合组件（Compound Components）架构，声明式 + 函数式渲染双模 |
| **几何圆角** | Trigger 6px / Popup 14px 脱节 | **严格同心几何矩阵**：Trigger 8px ↔ Popup 14px ↔ Item 8px（Padding 6px） |
| **原生搜索** | ❌ 无搜索能力 | 🟢 支持原地键入、忽略大小写、多字段拼音/子串模糊过滤与高亮 |
| **多选模式** | ❌ 仅支持单选 | 🟢 支持 `multiple` 模式与 `ComboboxChips` 原地排版自适应换行 |
| **清空机制** | ❌ 需额外业务逻辑 | 🟢 内置 `clearable` 图标按钮，支持 `Delete / Backspace` 零闪烁清空 |
| **浮层定位** | 通用固定宽度 | 零依赖浮层解算，动态注入 `--anchor-width`，双向碰撞自动翻折（Flip Y/X） |
| **动画质感** | 简单淡入淡出 | 平滑弹性缩放动画 `scale(0.95) -> scale(1)` + 纯白卡底 + 单层发丝边框 |
| **键盘无障碍** | 基础 ArrowDown/Enter | **Raycast 级体验**：Arrow/Home/End/PageUp/Down/Esc/Backspace + IME 状态机防抢断 |

---

# 二、同心圆角与尺寸矩阵几何标准

## 2.1 数学同心几何体系与公式

为彻底根治 Trigger 与 Popup、Popup 与 Item 之间的圆角脱节问题，方案采用纯几何数学推导的**同心曲率体系（Concentric Curvature Hierarchy）**：

$$R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 4\text{px})$$

```
+-------------------------------------------------------------------+  -- Popup Shell (R_outer: 14px)
|  Padding: 6px                                                     |
|  +-------------------------------------------------------------+  |
|  |  +-------------------------------------------------------+  |  |  -- Item Row (R_item = 14 - 6 = 8px)
|  |  | [Icon]  Label Text                 [Check / Kbd]      |  |  |
|  |  +-------------------------------------------------------+  |  |
|  |  +-------------------------------------------------------+  |  |
|  |  | [Icon]  Hovered Option                                |  |  |
|  |  +-------------------------------------------------------+  |  |
|  +-------------------------------------------------------------+  |
+-------------------------------------------------------------------+

+-------------------------------------------------------------------+  -- Trigger (R_trigger: 8px)
| [Start Slot]  Selected Text / Placeholder    [Clear] [Chevron ⬇] |  -- Height: 32px (md)
+-------------------------------------------------------------------+
```

- **Trigger 外壳圆角**：与 Item 圆角严格一致（$R_{\text{trigger}} = R_{\text{item}} = 8\text{px}$）；
- **Popup 外层浮层圆角**：$R_{\text{popup}} = R_{\text{item}} + \text{Padding} = 8 + 6 = 14\text{px}$；
- **Item 选中与悬停层**：圆角精准为 $8\text{px}$，与 Popup 保持 $6\text{px}$ 均等安全间距，杜绝切角与形变。

## 2.2 三档标准化尺寸矩阵（sm / md / lg）

对齐 Conex / Crish 的系统级四档栅格与 Appica UI 规范：

| 规格参数 | `sm`（紧凑/表格内） | `md`（标准默认） | `lg`（重点/主表单） |
|---|---|---|---|
| **Trigger 高度** | `28px` | `32px` | `40px` |
| **Trigger 圆角** | `6px` (`--radius-md`) | `8px` (`--radius-lg`) | `10px` (`--radius-xl`) |
| **Trigger 左右内边距**| `8px` | `10px` | `14px` |
| **Trigger 字号/行高** | `12px` / `1.3` | `13px` / `1.35` | `14px` / `1.4` |
| **Popup 浮层圆角** | `12px` | `14px` | `16px` |
| **Popup 内边距** | `4px` | `6px` | `8px` |
| **Popup 最小宽度** | `140px` | `160px` | `180px` |
| **Item 高度 / 行高** | `26px` | `30px` | `36px` |
| **Item 圆角** | `6px` | `8px` | `8px` |
| **Item 左右内边距** | `8px` | `10px` | `12px` |
| **Chip 标签高度** | `20px` (R: `4px`) | `24px` (R: `6px`) | `28px` (R: `8px`) |
| **图标尺寸 (Icon Size)** | `14px` | `16px` | `18px` |

## 2.3 设计令牌（Design Tokens）映射与 Zero-Blue 契约

所有组件样式严格绑定 `apps/crish-desktop/src/styles/tokens.css` 中的权威 Token，杜绝任何硬编码颜色与魔法数字：

- **背景基底**：
  - Trigger：`var(--bg-card, #ffffff)` / `var(--bg-secondary)`
  - Popup：`var(--bg-card, #ffffff)`
  - Item 悬浮与激活：`var(--tint-hover)`（`color-mix(in srgb, var(--text-primary) 3.5%, transparent)`）
  - Item 选中态：`var(--tint-active)`（`color-mix(in srgb, var(--text-primary) 6.5%, transparent)`）
- **发丝边框（Hairline Border）**：
  - 单层纯色：`1px solid var(--border-color)`（浅色 `#e2dfd9` / 深色 `#2b2926`），无重叠双边框；
  - 错误态：`var(--color-error-border)`。
- **克制焦点环（Soft Focus Ring）**：
  - 聚焦态：`box-shadow: 0 0 0 1.5px var(--tint-focus-ring)`（混入度严格控制在 3%~10%），禁止粗重全黑描边。
- **投影体系**：
  - Popup 浮层：`var(--shadow-dropdown, 0 12px 32px -4px rgba(29, 28, 26, 0.12), 0 4px 12px -2px rgba(29, 28, 26, 0.04))`。
- **品牌签名（Emerald Accent）**：
  - 选中对勾（Check Icon）：`var(--accent-color, hsl(160 84% 36%))`。

---

# 三、Select / Combobox 统一复合组件架构设计

## 3.1 复合组件模式（Compound Components）优势

采用 Compound Components 模式，将状态管理、无障碍通信、定位解算与视觉表现彻底解耦：
1. **结构无限自由**：允许在选项中任意插入 `SelectGroup`、`SelectSeparator`、自定义 Header、Footer、快捷操作按钮；
2. **渐进增强**：简单场景仅需 5 行 JSX，复杂场景支持自定义渲染函数、多列网格与异步检索；
3. **一致的 Slot 接口**：Trigger 与 Input 均提供 `startSlot`、`endSlot`、`clearable`、`prefixIcon` 统一插槽。

## 3.2 Select 复合组件谱系与状态模型

```
<Select>                                  -- 顶层 Provider，维护选中值、展开状态、尺寸与尺寸契约
  ├── <SelectTrigger>                     -- 触发器按钮（combobox 角色）
  │     ├── <SelectValue />               -- 当前选值 / Placeholder 渲染器
  │     ├── [startSlot / endSlot]         -- 前缀图标 / 状态徽标
  │     ├── <SelectClearButton />         -- 一键清除按钮（clearable=true 且有值时激活）
  │     └── <SelectIcon />                -- 旋转下拉箭头（0° -> 180°）
  └── <SelectContent>                     -- 浮层卡片（Portal + 零依赖 Floating Positioner）
        ├── <SelectScrollUpButton />      -- 列表溢出顶部滚动提示（可选）
        ├── <SelectGroup>                 -- 选项分组
        │     ├── <SelectGroupLabel />    -- 分组标题
        │     └── <SelectItem />          -- 选项行（支持 checkmark, hover, hint, shortcut）
        ├── <SelectSeparator />           -- 分割线
        └── <SelectScrollDownButton />    -- 列表溢出底部滚动提示（可选）
```

## 3.3 Combobox 复合组件谱系与状态模型

```
<Combobox>                                -- 顶层 Provider，集成搜索过滤引擎、多选/单选状态机
  ├── <ComboboxInput>                     -- 搜索输入框壳（单选/搜索模式）
  │     ├── [startSlot (如放大镜)]
  │     ├── <input role="combobox" />     -- 原生输入域（支持 IME 状态机保护）
  │     ├── <ComboboxClearButton />       -- 清空当前输入/选值
  │     └── <ComboboxToggleButton />      -- 展开/收起浮层按钮
  │   <!-- 或者多选模式 -->
  ├── <ComboboxChips>                     -- 多选标签换行排版容器
  │     ├── <ComboboxValue>               -- 渲染函数：(items) => items.map(item => ...)
  │     │     └── <ComboboxChip />        -- 胶囊标签（含微型叉号移除）
  │     └── <input role="combobox" />     -- 随流内联搜索输入框
  └── <ComboboxContent>                   -- 浮层卡片（支持锚点宽度自适应）
        ├── <ComboboxEmpty />             -- 搜索无匹配时的优雅空态
        └── <ComboboxList cols={1|2}>     -- 选项列表（支持网格布局与函数式渲染）
              ├── <ComboboxGroup>
              │     ├── <ComboboxLabel />
              │     └── <ComboboxItem />  -- 项（集成关键词匹配高亮与快捷键）
              └── <ComboboxSeparator />
```

## 3.4 Context 状态中枢与 Hook 契约

```typescript
// Select 上下文状态
interface SelectContextValue {
  value: string | string[] | null;
  defaultValue?: string | string[] | null;
  onValueChange: (val: string | string[] | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  size: 'sm' | 'md' | 'lg';
  variant: 'outline' | 'soft';
  multiple: boolean;
  clearable: boolean;
  disabled?: boolean;
  highlightedIndex: number;
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  registerItem: (id: string, value: string, disabled?: boolean) => () => void;
  itemMap: Map<string, { id: string; value: string; disabled?: boolean; index: number }>;
  clear: (e?: React.SyntheticEvent) => void;
}

// Combobox 上下文状态
interface ComboboxContextValue extends Omit<SelectContextValue, 'registerItem' | 'itemMap'> {
  query: string;
  setQuery: (q: string) => void;
  filteredItems: unknown[];
  grid: boolean;
  cols?: number;
}
```

---

# 四、零依赖 Floating 定位与视口碰撞翻折解算引擎

## 4.1 几何测量与 Anchor Width 动态同步

项目已拥有高精度的纯函数定位引擎 `apps/crish-desktop/src/components/ui/Menu/position.ts`。在此基础上，方案提炼出专用 `useFloatingPosition` Hook：

1. **不可变真实尺寸测量**：
   - 采用 `offsetWidth` / `offsetHeight` 测量，完全免疫进场动画中 `scale(0.95)` 产生的瞬态形变干扰；
2. **Anchor Width 动态注入**：
   - 在挂载与窗口 Resize 时测量 Trigger 边界（`triggerRect = triggerEl.getBoundingClientRect()`）；
   - 将 Trigger 宽度写入 Popup 容器的 CSS 变量 `--anchor-width: ${triggerRect.width}px`；
   - 样式中定义 `width: var(--anchor-width); min-width: var(--min-popup-width)`，实现浮层与触发器的完美等宽。

## 4.2 视口避让与双向翻折算法（Flip Y / Flip X）

算法以触发器物理矩形为不可变原始锚点（Immutable Anchor），纯函数解算最终放置位置：

```typescript
export interface FloatingComputeOptions {
  triggerRect: DOMRect;
  popupWidth: number;
  popupHeight: number;
  side?: 'bottom' | 'top';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number; // 默认 6px
  edgePadding?: number; // 默认 8px
  viewport?: ViewportRect;
}

export function computeFloatingPlacement(options: FloatingComputeOptions): FloatingPlacementResult {
  const { triggerRect, popupWidth, popupHeight, sideOffset = 6, edgePadding = 8 } = options;
  const vp = getEffectiveViewport(options.viewport);

  const spaceBelow = vp.height - triggerRect.bottom - sideOffset - edgePadding;
  const spaceAbove = triggerRect.top - vp.offsetTop - sideOffset - edgePadding;

  let actualSide: 'bottom' | 'top' = options.side ?? 'bottom';
  let y = 0;

  // 垂直翻折决策：下方空间不足且上方空间更充裕时向上翻折
  if (actualSide === 'bottom') {
    if (popupHeight > spaceBelow && spaceAbove > spaceBelow) {
      actualSide = 'top';
      y = triggerRect.top - popupHeight - sideOffset;
    } else {
      y = triggerRect.bottom + sideOffset;
    }
  } else {
    if (popupHeight > spaceAbove && spaceBelow > spaceAbove) {
      actualSide = 'bottom';
      y = triggerRect.bottom + sideOffset;
    } else {
      y = triggerRect.top - popupHeight - sideOffset;
    }
  }

  // 水平对齐与避让决策
  let x = triggerRect.left;
  let actualAlign = options.align ?? 'start';
  if (actualAlign === 'end') {
    x = triggerRect.right - popupWidth;
  } else if (actualAlign === 'center') {
    x = triggerRect.left + (triggerRect.width - popupWidth) / 2;
  }

  // 刚性双向数学钳位（Two-Way Clamping）
  const minX = vp.offsetLeft + edgePadding;
  const maxX = vp.offsetLeft + vp.width - popupWidth - edgePadding;
  const clampedX = Math.min(Math.max(minX, x), Math.max(minX, maxX));

  const minY = vp.offsetTop + edgePadding;
  const maxY = vp.offsetTop + vp.height - popupHeight - edgePadding;
  const clampedY = Math.min(Math.max(minY, y), Math.max(minY, maxY));

  const originY = actualSide === 'top' ? 'bottom' : 'top';
  const originX = actualAlign === 'end' ? 'right' : 'left';

  return {
    x: clampedX,
    y: clampedY,
    side: actualSide,
    align: actualAlign,
    transformOrigin: `${originY} ${originX}`,
  };
}
```

## 4.3 平滑弹性缩放进场动画与 Transform Origin 联动

结合解算出的 `transformOrigin`，CSS 进场动画实现如丝顺滑的微回弹质感：

```css
.popupContent {
  transform-origin: var(--transform-origin, top left);
  animation: popupEnter 180ms cubic-bezier(0.175, 0.885, 0.32, 1.25) forwards;
}

.popupContentClosing {
  animation: popupExit 100ms cubic-bezier(0.4, 0, 1, 1) forwards;
}

@keyframes popupEnter {
  0% {
    opacity: 0;
    transform: scale(0.95);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes popupExit {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(0.96);
  }
}

@media (prefers-reduced-motion: reduce) {
  .popupContent,
  .popupContentClosing {
    animation: none;
    transition: opacity 100ms ease;
  }
}
```

## 4.4 LayerStack 浮层中枢装配与防脱节调度

浮层展开时自动向 `LayerStackManager` 注册（`type: 'dropdown-menu'`）：
- **外点关闭**：点击应用其他区域时触发 `dismiss('outside-pointer')`；
- **Esc 键互斥**：按下 Esc 时关闭当前浮层并将焦点自动还给 Trigger / Input；
- **排他互斥（Exclusive Peer）**：同一时刻展开新下拉菜单会自动驱逐同级已打开的菜单，保证界面纯净。

---

# 五、Raycast 级全键盘无障碍漫游与 IME 状态机

## 5.1 WAI-ARIA 1.2 语义拓扑与属性矩阵

| DOM 节点 | ARIA Role | 核心无障碍属性映射 | 交互状态 |
|---|---|---|---|
| **SelectTrigger** | `button` / `combobox` | `aria-haspopup="listbox"`, `aria-expanded={open}`, `aria-controls={listboxId}` | 承载主焦点 |
| **ComboboxInput** | `combobox` | `aria-autocomplete="list"`, `aria-expanded={open}`, `aria-activedescendant={activeId}` | 原生文本输入焦点 |
| **Popup Listbox** | `listbox` | `role="listbox"`, `aria-multiselectable={multiple}`, `tabIndex={-1}` | 选项语义容器 |
| **Popup Grid** | `grid` | `role="grid"` (当 `grid={true}` 时开启双维漫游) | 网格语义容器 |
| **Option Item** | `option` | `role="option"`, `aria-selected={isSelected}`, `aria-disabled={disabled}` | 选项行 |
| **Chip Remove** | `button` | `aria-label="Remove ${label}"` | 多选胶囊内微按钮 |

## 5.2 全键盘漫游状态机与行为规范

针对键盘交互建立严格的状态转移机：

1. **`ArrowDown`（向下漫游）**：
   - 浮层未打开时：打开浮层并聚焦首个非 disabled 项；
   - 浮层已打开时：移动至下一个有效项；若到达末尾则循环至首项（或钳位在末项）；
2. **`ArrowUp`（向上漫游）**：
   - 移动至上一个有效项；若在首项则循环至末尾项；
3. **`Home` / `End`**：
   - 在 Select 模式下直接跳至第一项 / 最后一项；
4. **`Enter` / `Space`**：
   - 单选模式：选中当前高亮项，触发 `onValueChange` 并关闭浮层，焦点保留在 Trigger；
   - 多选模式：反转当前项选中状态（选中/取消），保持浮层展开，光标留在 Input 内；
5. **`Escape`**：
   - 关闭浮层，停止事件冒泡（`e.stopPropagation()`），防止意外关闭外层 Dialog；
6. **`Tab`**：
   - 自动收起浮层，自然放行焦点切换至下一个 DOM 表单控件。

## 5.3 IME 输入法合成锁状态机（Composition Guard）

在中文（拼音）、日文输入法环境下，用户在选词阶段敲击 `Enter` 或 `Space` 属于输入法确认，**严禁**误判为表单提交或选项选中：

```typescript
const isComposingRef = useRef(false);

const handleCompositionStart = () => {
  isComposingRef.current = true;
};

const handleCompositionEnd = () => {
  isComposingRef.current = false;
};

const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (
    isComposingRef.current ||
    e.nativeEvent.isComposing ||
    e.keyCode === 229 ||
    e.key === 'Process'
  ) {
    return; // 严格拦截 IME 选词回车
  }

  if (e.key === 'Enter') {
    // 正常执行选项选中
  }
};
```

## 5.4 快捷键删除与一键清空机制（Clearable Flow）

1. **内嵌 ClearButton**：
   - 当 `clearable={true}` 且当前存在选值时渲染；
   - 点击时执行 `event.stopPropagation()` 阻止下拉面板意外展开/关闭，重置 value 为 `null` / `[]`；
2. **键盘 `Backspace` / `Delete` 响应**：
   - 在 `SelectTrigger` 上按下 `Backspace` 或 `Delete` 时，直接清空选值并上报 `onValueChange(null)`，无需展开面板再操作；
   - 在 `ComboboxChips` 输入框中，若当前输入内容为空，按下 `Backspace` 会自动高亮最后一个 Chip，再次按下 `Backspace` 即可删除该 Chip。

---

# 六、Chips 多选排版与内嵌搜索过滤系统

## 6.1 ComboboxChips 原地自适应排版引擎

在多选场景下，`ComboboxChips` 实现了输入框内部自适应换行排版：

```css
.chipsWrapper {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: var(--control-height, 32px);
  padding: 3px 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg, 8px);
  background: var(--bg-card);
  box-sizing: border-box;
  cursor: text;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.chipsWrapper:focus-within {
  border-color: var(--border-color);
  box-shadow: var(--focus-ring);
}

.chipsInput {
  flex: 1 1 60px;
  min-width: 60px;
  height: 24px;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  color: var(--text-primary);
  padding: 0 4px;
}
```

## 6.2 选值胶囊（ComboboxChip）与微型删除交互

选值胶囊基于 `buttonVariants({ variant: 'soft' })` 风格打造：
- 高度 `22px`，圆角 `6px`，背景为柔和底色 `var(--tint-hover)`；
- 包含文字与微型 `ClearIcon`（12px）；
- 点击微型叉号或按下 Delete 键直接移除当前项，触发 `onValueChange(remainingValues)`。

## 6.3 原生搜索匹配与关键词高亮渲染器

为消除外部库依赖并提供最佳性能，内置轻量级纯文本与高亮渲染器：

```typescript
export function highlightMatches(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  return parts.map((part, i) =>
    regex.test(part) ? (
      <span key={i} className={styles.highlightText}>
        {part}
      </span>
    ) : (
      part
    )
  );
}
```

---

# 七、完整 TypeScript 契约与 API 规范

## 7.1 Select 家族 TypeScript 类型契约

```typescript
export type SelectSize = 'sm' | 'md' | 'lg';
export type SelectVariant = 'outline' | 'soft';

export interface SelectRootProps {
  value?: string | string[] | null;
  defaultValue?: string | string[] | null;
  onValueChange?: (value: any) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: SelectSize;
  variant?: SelectVariant;
  multiple?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

export interface SelectTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  startSlot?: React.ReactNode;
  endSlot?: React.ReactNode;
  clearable?: boolean;
  children?: React.ReactNode;
}

export interface SelectValueProps {
  placeholder?: string;
  className?: string;
}

export interface SelectContentProps {
  className?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'bottom' | 'top';
  sideOffset?: number;
  children: React.ReactNode;
}

export interface SelectItemProps {
  value: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  shortcut?: string;
  className?: string;
  children: React.ReactNode;
}
```

## 7.2 Combobox 家族 TypeScript 类型契约

```typescript
export interface ComboboxRootProps<T = any> {
  items?: T[];
  value?: string | string[] | null;
  defaultValue?: string | string[] | null;
  onValueChange?: (value: any) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  filter?: (item: T, query: string) => boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: SelectSize;
  variant?: SelectVariant;
  multiple?: boolean;
  clearable?: boolean;
  grid?: boolean;
  cols?: number;
  disabled?: boolean;
  children: React.ReactNode;
}

export interface ComboboxInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  startSlot?: React.ReactNode;
  endSlot?: React.ReactNode;
  clearable?: boolean;
  icon?: boolean;
}

export interface ComboboxChipsProps extends React.HTMLAttributes<HTMLDivElement> {
  placeholder?: string;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
  children?: React.ReactNode;
}

export interface ComboboxListProps<T = any> {
  cols?: number;
  className?: string;
  children?: React.ReactNode | ((item: T, index: number) => React.ReactNode);
}
```

## 7.3 兼容适配器（SelectLegacyAdapter）实现

为确保全仓已有业务代码（如调用 `Select options={OPTIONS} value={val} onChange={fn}`）100% 零破坏平滑过渡，在 `ui/Select/Select.tsx` 顶层保留旧版签名包装层：

```typescript
export interface LegacySelectOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}

export interface LegacySelectProps {
  value?: string | null;
  onChange?: (value: string) => void;
  options: LegacySelectOption[];
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  label?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  id?: string;
  className?: string;
  clearable?: boolean;
}

export function SelectLegacyAdapter({
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled,
  error,
  label,
  size = 'md',
  id,
  className,
  clearable,
}: LegacySelectProps) {
  return (
    <div className={styles.selectWrap}>
      {label && <label className={styles.selectLabel} htmlFor={id}>{label}</label>}
      <Select
        value={value}
        onValueChange={(val) => onChange?.(val as string)}
        size={size}
        disabled={disabled}
        clearable={clearable}
      >
        <SelectTrigger
          id={id}
          className={`${error ? styles.triggerError : ''} ${className ?? ''}`}
          aria-invalid={error ? true : undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem
              key={opt.id}
              value={opt.id}
              disabled={opt.disabled}
              icon={opt.icon}
              hint={opt.hint}
            >
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className={styles.selectError}>{error}</p>}
    </div>
  );
}
```

---

# 八、CSS Modules 视觉规范与发丝边框设计

## 8.1 `Select.module.css` 完整规范

```css
/* Select.module.css — Zero-Blue 墨阶纯净视觉与数学同心圆角 */

.selectWrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
  width: 100%;
}

.selectLabel {
  font-size: var(--font-size-xs, 11px);
  font-weight: var(--font-weight-normal, 400);
  color: var(--text-secondary);
  user-select: none;
}

.trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: var(--control-height, 32px);
  min-height: 0;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg, 8px);
  font-size: var(--font-size-sm, 13px);
  font-family: var(--font-sans);
  background: var(--bg-card, #ffffff);
  color: var(--text-primary);
  outline: none;
  box-sizing: border-box;
  cursor: pointer;
  user-select: none;
  transition:
    border-color var(--transition-micro, 120ms) ease,
    background-color var(--transition-micro, 120ms) ease,
    box-shadow var(--transition-micro, 120ms) ease;
}

.trigger:hover:not(:disabled) {
  background: var(--tint-hover);
  border-color: var(--border-color);
}

.trigger:focus-visible,
.trigger[data-popup-open] {
  border-color: var(--border-color);
  background: var(--bg-card);
  outline: none;
  box-shadow: var(--focus-ring);
}

.triggerSm {
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  border-radius: var(--radius-md, 6px);
}

.triggerLg {
  height: 40px;
  padding: 0 14px;
  font-size: 14px;
  border-radius: var(--radius-xl, 10px);
}

.triggerError {
  border-color: var(--color-error-border) !important;
}

.triggerDisabled {
  cursor: not-allowed;
  opacity: var(--opacity-disabled, 0.5);
  background: var(--bg-secondary);
}

.triggerValue {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.placeholder {
  color: var(--text-tertiary);
}

.triggerIcon {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
}

.triggerIconOpen {
  transform: rotate(180deg);
  color: var(--text-primary);
}

.clearButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: 4px;
  transition: color 120ms ease;
}

.clearButton:hover {
  color: var(--text-primary);
}

/* 浮层 Content 规范：同心几何圆角 14px，Padding 6px */
.content {
  position: fixed;
  z-index: 1000;
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  box-shadow: var(--shadow-dropdown);
  padding: 6px;
  box-sizing: border-box;
  min-width: 160px;
  max-height: min(70vh, 320px);
  overflow-y: auto;
  outline: none;
  overscroll-behavior: contain;
}

.contentSm {
  border-radius: 12px;
  padding: 4px;
}

.contentLg {
  border-radius: 16px;
  padding: 8px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Item 选项行：同心圆角 8px (14 - 6 = 8) */
.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 30px;
  min-height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  user-select: none;
  outline: none;
  transition: background-color 100ms ease, color 100ms ease;
}

.item:hover,
.item[data-highlighted] {
  background: var(--tint-hover);
  color: var(--text-primary);
}

.itemSelected {
  background: var(--tint-active);
  font-weight: 500;
}

.itemDisabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
  opacity: var(--opacity-disabled, 0.5);
  pointer-events: none;
}

.itemCheck {
  flex-shrink: 0;
  color: var(--accent-color, hsl(160 84% 36%));
}

.separator {
  height: 1px;
  background: var(--border-subtle, rgba(0, 0, 0, 0.06));
  margin: 4px -6px;
}
```

## 8.2 `Combobox.module.css` 完整规范

```css
/* Combobox.module.css — 搜索输入与 Chips 标签排版 */

.inputFrame {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: var(--control-height, 32px);
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg, 8px);
  background: var(--bg-card);
  box-sizing: border-box;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.inputFrame:focus-within {
  border-color: var(--border-color);
  box-shadow: var(--focus-ring);
}

.nativeInput {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  outline: none;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
  font-family: inherit;
}

.nativeInput::placeholder {
  color: var(--text-tertiary);
}

.emptyState {
  padding: 16px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}

.highlightText {
  color: var(--accent-color, hsl(160 84% 36%));
  font-weight: 600;
  background: color-mix(in srgb, var(--accent-color) 10%, transparent);
  border-radius: 2px;
  padding: 0 2px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px 0 8px;
  border-radius: 6px;
  background: var(--tint-hover);
  color: var(--text-primary);
  font-size: 12px;
  user-select: none;
}

.chipRemove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  padding: 1px;
  cursor: pointer;
  color: var(--text-tertiary);
  border-radius: 3px;
}

.chipRemove:hover {
  color: var(--text-primary);
  background: var(--tint-active);
}
```

---

# 九、单元测试与反回归验证设计

## 9.1 Select 自动化测试用例集

覆盖于 `apps/crish-desktop/src/components/ui/Select/Select.test.tsx`：

1. **语义与槽位断言**：
   - 验证 `data-slot="select-trigger"`, `data-slot="select-content"`, `data-slot="select-item"` 结构标记；
   - 验证 `startSlot`、`endSlot` 正确内嵌并不阻断点击事件；
2. **同心圆角类名矩阵**：
   - 验证 `size="sm"` 下 Trigger 渲染 `triggerSm` (6px)，Popup 渲染 `contentSm` (12px)；
   - 验证 `size="md"` 下 Trigger 8px 与 Popup 14px 精准对应；
3. **受控与非受控双模**：
   - 验证外部 `value` 驱动与 `onChange` 确定性上报；
4. **一键清空与快捷键**：
   - 验证 `clearable` 在有值时出现，点击或按 `Backspace/Delete` 清空选值并不失去焦点；
5. **WAI-ARIA 与键盘漫游**：
   - 验证 `ArrowDown / ArrowUp / Enter / Esc` 完整漫游闭环。

## 9.2 Combobox 自动化测试用例集

新建 `apps/crish-desktop/src/components/ui/Select/Combobox.test.tsx`：

1. **原生过滤与关键词匹配**：
   - 键入 "gpt" 正确过滤出 "GPT-4" 并高亮匹配子串，展示 `<ComboboxEmpty>` 当无匹配项时；
2. **IME 状态机防御**：
   - 模拟 `compositionstart`，在输入法拼音选词回车时不触发选项提交；
3. **多选 Chips 操作流**：
   - 验证多次选中追加 Chips；
   - 验证点击 Chip 移除按钮或按 Backspace 删除末尾 Chip；
4. **视口边界翻折**：
   - 模拟底部视口空间受限，验证自动计算出 `side: 'top'` 并向上展开。

---

# 十、实施路线图与验收门禁

## 10.1 5 步精细化实施路线图

```
Step 1: 基础设施沉淀 (Layer & Floating Engine)
  ├── 提炼 useFloatingPosition (继承 position.ts 单源解算)
  └── 装配 LayerStackManager ('dropdown-menu' 优先级 40)
       ⬇
Step 2: Select 复合组件全新实现
  ├── Select, SelectTrigger, SelectValue, SelectContent, SelectItem
  └── Select.module.css (严格同心圆角 8px / 14px / 6px)
       ⬇
Step 3: Combobox 复合组件与 Chips 体系实现
  ├── Combobox, ComboboxInput, ComboboxChips, ComboboxChip, ComboboxList
  └── 原生搜索过滤算法与高亮渲染器
       ⬇
Step 4: 兼容适配器与测试覆盖
  ├── SelectLegacyAdapter 零破坏适配存量代码
  └── Select.test.tsx + Combobox.test.tsx 100% 覆盖
       ⬇
Step 5: 全仓业务组件渐进式现代化升级
  ├── 模型选择器 (ModelPicker) 迁移至 Combobox
  └── 标签/工具选择器迁移至 ComboboxChips
```

## 10.2 质量门禁清单

- [ ] **零外部依赖**：`package.json` 不新增任何外部组件库依赖；
- [ ] **数学同心圆角**：Trigger 8px ↔ Popup 14px ↔ Item 8px（Padding 6px）绝对对齐；
- [ ] **发丝边框与无重叠**：单层发丝边框 `var(--border-color)`，严禁双重投影与厚重黑边；
- [ ] **Raycast 键盘流**：Arrow/Enter/Esc/Backspace/IME 全场景丝滑漫游；
- [ ] **CI 门禁全绿**：`npm run typecheck` + `npm run test`（全量单元测试与无障碍 axe 校验 100% 通过）。
