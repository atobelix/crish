# Conex / Crish — Select 与 Combobox 大圆角同心架构与解耦拆分详案

> **文档标识**：`docs/ui-component-modernization/plan-improvements/02-Select与Combobox大圆角同心架构与解耦拆分详案.md`
> **所属战役**：UI 组件现代化与原生原子库升级（`ui-component-modernization`）
> **方案版本**：v2.1.0 (Production Master Architecture Plan)
> **编制依据**：
> - 视觉形态与交互设计对标基准（**图 2 与图 3 现代大圆角设计资产** vs **图 4 遗留生硬小方框缺陷**）
> - `docs/ui-component-modernization/audits/02-Select与Combobox浮层解算及无障碍严苛审查.md`（12 项严苛缺陷剖析）
> - `docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md`（RL-03 行数门禁、Zero-Blue 墨阶与 Token 规范）
> - `docs/ui-component-modernization/audits/06-多行Select文字重叠与全局灰度偏暗按钮及受管浏览器排查.md`（多行选项排版与自适应高度）
> - `docs/ui-component-modernization/independent-plans/03-Select与Combobox同心圆角与原生搜索方案.md`
> - `apps/crish-desktop/src/styles/tokens.css`（权威 Design Tokens）
> - `apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts`（浮层调度中枢状态机契约）
>
> **工程红线与架构原则**：
> 1. **零外部 npm 组件库依赖**：100% 纯原生 React 18+ 与 CSS Modules，绝对严禁引入 `@base-ui`, `@radix-ui`, `framer-motion`, `floating-ui` 等第三方组件库；
> 2. **全仓形态 100% 对标图 2/3 大圆角同心美学**：彻底淘汰清退图 4 中 `id="ui-select-_r_dd_"` 等生硬小方框与错位弹窗；
> 3. **RL-03 单文件行数刚性治理**：将单体 `Select.tsx` (1081 行) 与 `Combobox.tsx` (1340 行) 彻底拆解为单职责原子文件，确保每个拆分文件有效行数均 $\le 190$ 行；
> 4. **100% 存量向下兼容**：平滑保留既有 `options` / `items` 配置式 Props 签名及 `SelectLegacyAdapter`，全仓存量业务调用无感过渡；
> 5. **交互与算法缺陷彻底清零**：根除 `highlightMatches` 正则 `lastIndex` 状态变异、中文 IME 合成锁穿透、LayerStack `programmatic` 驱逐漏判、首帧 (0,0) 闪烁等所有隐患。

---

## 目录

- [一、视觉形态对标与设计资产解构（图 2 / 图 3 vs 图 4）](#一视觉形态对标与设计资产解构图-2--图-3-vs-图-4)
  - [1.1 用户视觉资产对标基准](#11-用户视觉资产对标基准)
  - [1.2 图 4 遗留缺陷剖析与彻底清退标准](#12-图-4-遗留缺陷剖析与彻底清退标准)
  - [1.3 数学同心几何体系与曲率方程](#13-数学同心几何体系与曲率方程)
  - [1.4 三档标准化尺寸矩阵与 Design Tokens 映射](#14-三档标准化尺寸矩阵与-design-tokens-映射)
- [二、RL-03 单文件行数治理与原子拆解拓扑](#二rl-03-单文件行数治理与原子拆解拓扑)
  - [2.1 物理拆分目录树全景拓扑](#21-物理拆分目录树全景拓扑)
  - [2.2 共享内部基础设施（`internal/`）设计](#22-共享内部基础设施internal设计)
  - [2.3 Select 复合组件族谱系与行数预算](#23-select-复合组件族谱系与行数预算)
  - [2.4 Combobox 复合组件族谱系与行数预算](#24-combobox-复合组件族谱系与行数预算)
  - [2.5 样式解耦与 Token 纯进化拆分](#25-样式解耦与-token-纯进化拆分)
- [三、核心交互缺陷与底层算法深度根治](#三核心交互缺陷与底层算法深度根治)
  - [3.1 `highlightMatches` 正则无状态化（消除 `lastIndex` 变异 Bug）](#31-highlightmatches-正则无状态化消除-lastindex-变异-bug)
  - [3.2 50ms 中文拼音 IME 合成锁门闩（Composition Guard）](#32-50ms-中文拼音-ime-合成锁门闩composition-guard)
  - [3.3 LayerStack 全量驱逐事件捕获（修复 `programmatic` 漏判）](#33-layerstack-全量驱逐事件捕获修复-programmatic-漏判)
  - [3.4 首帧 `(0, 0)` 瞬态裸露闪烁根治与 `isPositioned` 门闩状态机](#34-首帧-0-0-瞬态裸露闪烁根治与-ispositioned-门闩状态机)
  - [3.5 双向视口避让（Flip Y / Flip X）与 `transformOrigin` 联动数学模型](#35-双向视口避让flip-y--flip-x与-transformorigin-联动数学模型)
  - [3.6 全局滚动 RAF 节流与浮层内部滚动事件隔离](#36-全局滚动-raf-节流与浮层内部滚动事件隔离)
  - [3.7 触发器盒模型 `ResizeObserver` 动态锚点联动与纯 ID 规范](#37-触发器盒模型-resizeobserver-动态锚点联动与纯-id-规范)
  - [3.8 `ComboboxChips` 倒格删除异步闭包竞态修复与光标驻留](#38-comboboxchips-倒格删除异步闭包竞态修复与光标驻留)
  - [3.9 `<SelectTrigger>` HTML5 规范合规重构（清退嵌套交互元素）](#39-selecttrigger-html5-规范合规重构清退嵌套交互元素)
  - [3.10 单选模式 Display Label 与 Transient Search Query 状态解耦](#310-单选模式-display-label-与-transient-search-query-状态解耦)
  - [3.11 多行选项文字重叠根治与自适应高度弹性排版](#311-多行选项文字重叠根治与自适应高度弹性排版)
- [四、Select 复合组件族实现详案与源码规格](#四select-复合组件族实现详案与源码规格)
  - [4.1 `SelectRoot.tsx`（根状态机与 Provider）](#41-selectroottsx根状态机与-provider)
  - [4.2 `SelectTrigger.tsx`（大圆角触发器与 ChevronUpDown）](#42-selecttriggertsx大圆角触发器与-chevronupdown)
  - [4.3 `SelectValue.tsx`（选值/占位符渲染）](#43-selectvaluetsx选值占位符渲染)
  - [4.4 `SelectContent.tsx`（大圆角浮层与 isPositioned 门闩）](#44-selectcontenttsx大圆角浮层与-ispositioned-门闩)
  - [4.5 `SelectItem.tsx`（同心圆角、翡翠绿对勾与多行自适应）](#45-selectitemtsx同心圆角翡翠绿对勾与多行自适应)
  - [4.6 `SelectGroup.tsx`, `SelectSeparator.tsx`, `SelectClearButton.tsx`](#46-selectgrouptsx-selectseparatortsx-selectclearbuttontsx)
  - [4.7 `SelectLegacyAdapter.tsx` & `Select.tsx`（存量无缝分流入口）](#47-selectlegacyadaptertsx--selecttsx存量无缝分流入口)
- [五、Combobox 复合组件族实现详案与源码规格](#五combobox-复合组件族实现详案与源码规格)
  - [5.1 `ComboboxRoot.tsx`（搜索过滤与状态中枢）](#51-comboboxroottsx搜索过滤与状态中枢)
  - [5.2 `ComboboxInput.tsx`（带 IME 保护的单选搜索框）](#52-comboboxinputtsx带-ime-保护的单选搜索框)
  - [5.3 `ComboboxChips.tsx` & `ComboboxChip.tsx`（多选换行胶囊）](#53-comboboxchipstsx--comboboxchiptsx多选换行胶囊)
  - [5.4 `ComboboxContent.tsx`, `ComboboxList.tsx`, `ComboboxItem.tsx`](#54-comboboxcontenttsx-comboboxlisttsx-comboboxitemtsx)
  - [5.5 `ComboboxEmpty.tsx`, `ComboboxGroup.tsx`, `ComboboxSeparator.tsx`](#55-comboboxemptytsx-comboboxgrouptsx-comboboxseparatortsx)
  - [5.6 `ComboboxLegacyAdapter.tsx` & `Combobox.tsx`（存量分流入口）](#56-comboboxlegacyadaptertsx--comboboxtsx存量分流入口)
- [六、共享基础设施与 CSS Modules 样式规范](#六共享基础设施与-css-modules-样式规范)
  - [6.1 `internal/SelectIcons.tsx`（上下双箭头与翡翠绿对勾）](#61-internalselecticonstsx上下双箭头与翡翠绿对勾)
  - [6.2 `internal/comboboxHighlight.tsx`（无状态高亮算法）](#62-internalcomboboxhighlighttsx无状态高亮算法)
  - [6.3 `internal/positionGeometry.ts`（双向几何解算引擎）](#63-internalpositiongeometryts双向几何解算引擎)
  - [6.4 `useFloatingPosition.ts`（浮层调度与生命周期 Hook）](#64-usefloatingpositionts浮层调度与生命周期-hook)
  - [6.5 `SelectTrigger.module.css`（闭合态发丝边框与双箭头）](#65-selecttriggermodulecss闭合态发丝边框与双箭头)
  - [6.6 `SelectContent.module.css`（展开态大圆角与同心曲率）](#66-selectcontentmodulecss展开态大圆角与同心曲率)
  - [6.7 `Combobox.module.css`（输入框、Chips 胶囊与高亮文本）](#67-comboboxmodulecss输入框chips-胶囊与高亮文本)
- [七、全仓旧式 Select / 生硬小方框清退与迁移实施步骤](#七全仓旧式-select--生硬小方框清退与迁移实施步骤)
  - [7.1 全仓存量 Select / 原生 `<select>` 排查清单](#71-全仓存量-select--原生-select-排查清单)
  - [7.2 迁移改造模式与代码转换示例](#72-迁移改造模式与代码转换示例)
- [八、单元测试与反回归验证矩阵](#八单元测试与反回归验证矩阵)
  - [8.1 Select 单元测试用例规格 (`Select.test.tsx`)](#81-select-单元测试用例规格-selecttesttsx)
  - [8.2 Combobox 单元测试用例规格 (`Combobox.test.tsx`)](#82-combobox-单元测试用例规格-comboboxtesttsx)
- [九、实施路线图与验收质量门禁](#九实施路线图与验收质量门禁)
  - [9.1 4 步精细化落地路线图](#91-4-步精细化落地路线图)
  - [9.2 验收门禁检查清单（Checklist）](#92-验收门禁检查清单checklist)

---

## 一、视觉形态对标与设计资产解构（图 2 / 图 3 vs 图 4）

### 1.1 用户视觉资产对标基准

用户提供的标准视觉设计资产（图 2 与图 3）确立了顶级桌面级 UI 的几何比例、质感与层级规范：

```
========================================================================================
【图 2 / 图 3 标准形态】：现代化大圆角同心架构（Target Master Spec）
========================================================================================

1. 闭合触发器 (Trigger)
   ┌─────────────────────────────────────────────────────────────┐
   │  [Icon]  Claude 3.5 Sonnet (Latest)           [ ✕ ] [ ⇅ ]   │  -- R: 8px/10px, H: 32px/40px
   └─────────────────────────────────────────────────────────────┘  -- 纯白底板 + 发丝边框

2. 展开浮层 (Popup Shell)
   ┌─────────────────────────────────────────────────────────────┐  -- R_outer: 14px / 16px
   │  Padding: 6px (均等四周内边距)                              │  -- 漫反射深空双层阴影
   │  ┌───────────────────────────────────────────────────────┐  │  -- 发丝边框 1px solid var(--border-color)
   │  │ [Icon] GPT-4o Omni                        [ Kbd: ⌘1 ] │  │  -- R_item: 8px (同心圆角)
   │  ├───────────────────────────────────────────────────────┤  │
   │  │ [Icon] Claude 3.5 Sonnet (Latest)                 [ ✓ ]│  │  -- 选中行: var(--tint-active) + 翡翠绿对勾
   │  ├───────────────────────────────────────────────────────┤  │
   │  │ [Icon] DeepSeek-R1 (Reasoning)                        │  │  -- Hover行: var(--tint-hover) (3.5%)
   │  │        副文本说明：深度推理模型，耗时较长              │  │  -- 多行自适应高度 (Flex 列布局)
   │  └───────────────────────────────────────────────────────┘  │
   └─────────────────────────────────────────────────────────────┘
```

- **Trigger（闭合态触发器）**：
  - 8px（`md`）/ 10px（`lg`）柔和圆角；
  - 1px 发丝边框 `1px solid var(--border-color)`，浅色模式下为纯白底板 `var(--bg-card, hsl(0 0% 100%))`；
  - 右侧统一采用上下双箭头图标 `ChevronUpDown`（Appica 风格，小巧精致），非粗笨单箭头；
  - 内置 `clearable` 时呈现微型一键清空图标按钮。
- **Popup（展开态浮层卡片）**：
  - 14px（`md`）/ 16px（`lg`）舒适大圆角；
  - 6px（`md`）/ 8px（`lg`）均等四周内边距；
  - 单层精致发丝边框与深空双层漫反射阴影：`0 12px 32px -4px rgba(29, 28, 26, 0.12), 0 4px 12px -2px rgba(29, 28, 26, 0.04)`；
  - 纯白卡底 `var(--bg-card, hsl(0 0% 100%))`。
- **Item（选项行）**：
  - 8px 同心圆角，与外层浮层内壁完美贴合；
  - 选中态：右侧呈现优雅翡翠绿对勾 `✓`（`var(--brand, #10b981)`），背景为中性浅墨色 `var(--tint-active)`；
  - 悬停态：背景为极轻纯中性墨阶 `var(--tint-hover)`（3.5% 混入），无任何突兀蓝紫色；
  - 多行支持：选项行高度自适应，标题与副说明纵向 Flex 排版，行高 1.35，间距 2px，彻底杜绝文字穿透。

---

### 1.2 图 4 遗留缺陷剖析与彻底清退标准

在图 4 及存量代码中，部分界面仍然存在旧式生硬小方框与错位弹窗（如 `id="ui-select-_r_dd_"` 等 DOM 节点）：

| 遗留缺陷表现 | 根因剖析 | 治理与清退标准 |
|---|---|---|
| **生硬直角小方框（4px/6px）** | 使用了旧版原生 `<select>` 包装或未升级的旧样式类，圆角过小，呈生硬矩形方块 | 全仓强制收敛至统一原子组件，全面升级为 8px/10px 柔和圆角 |
| **浮层小而狭窄、文字挤压** | `SelectContent` 宽度未与 Trigger 绑定（缺失 `--anchor-width` 动态注入）且固定最小宽度过小（140px） | 引入 `--anchor-width` 动态注入，浮层宽度与 Trigger 物理对齐，支持多行自适应放宽 |
| **粗糙单一下箭头** | 图标使用了原生描边过粗的 `<polyline points="6 9 12 15 18 9" />` 单箭头 | 统一替换为 `ChevronUpDown` 双向微图标，线宽 1.4px，精致通透 |
| **多行选项文字重叠刺穿** | 选项容器硬编码 `height: 28px;`，副说明文本溢出刺穿到下一行选项 | 移除固定高度限制，改用 `min-height: 32px; height: auto; padding: 8px 10px;` Flex 弹性列排版 |
| **生硬死灰底色** | Hover / Active 使用了半透明冷蓝或死灰色块 | 全面收敛至 `tokens.css` 权威变量：`var(--tint-hover)` (3.5%) 与 `var(--tint-active)` (6.5%) |

---

### 1.3 数学同心几何体系与曲率方程

为了在视觉上达成极致的和谐美感，Popup 外壳与内部 Item、Trigger 必须严格遵守**同心曲率数学方程（Concentric Curvature Equation）**：

$$R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 4\text{px})$$

```
+-------------------------------------------------------------------+  -- Popup Shell (R_outer: 14px)
|  Padding: 6px                                                     |
|  +-------------------------------------------------------------+  |
|  |  +-------------------------------------------------------+  |  |  -- Item Row (R_item = 14 - 6 = 8px)
|  |  | [Icon]  Claude 3.5 Sonnet (Latest)             [ ✓ ]  |  |  |
|  |  +-------------------------------------------------------+  |  |
|  |  +-------------------------------------------------------+  |  |
|  |  | [Icon]  Hovered Option Line                           |  |  |
|  |  +-------------------------------------------------------+  |  |
|  +-------------------------------------------------------------+  |
+-------------------------------------------------------------------+

+-------------------------------------------------------------------+  -- Trigger (R_trigger: 8px)
| [Icon]  Claude 3.5 Sonnet (Latest)               [ ✕ ] [ ⇅ ]     |  -- Height: 32px (md)
+-------------------------------------------------------------------+
```

- **Trigger 外壳圆角**：$R_{\text{trigger}} = 8\text{px}$（`md`）/ $10\text{px}$（`lg`），与 Item 行圆角呼应；
- **Popup 浮层外壳圆角**：$R_{\text{popup}} = R_{\text{item}} + \text{Padding} = 8 + 6 = 14\text{px}$（`md`）/ $8 + 8 = 16\text{px}$（`lg`）；
- **Item 选项行圆角**：严格等于 $8\text{px}$，与 Popup 保持四周均等 $6\text{px}$ 间隙，消除边缘 Corner Pinching（圆角挤压畸变）。

---

### 1.4 三档标准化尺寸矩阵与 Design Tokens 映射

| 规格参数 | `sm`（紧凑/表格/小窗口） | `md`（标准默认/主表单） | `lg`（大号重点/首屏主控） |
|---|---|---|---|
| **Trigger 高度** | `28px` | `32px` | `40px` |
| **Trigger 圆角** | `6px` (`--radius-md`) | `8px` (`--radius-lg`) | `10px` (`--radius-xl`) |
| **Trigger 左右内边距** | `8px` | `10px` | `14px` |
| **Trigger 字号 / 行高** | `12px` / `1.3` | `13px` / `1.35` | `14px` / `1.4` |
| **Popup 浮层圆角** | `12px` | `14px` | `16px` |
| **Popup 均等内边距** | `4px` | `6px` | `8px` |
| **Popup 最小宽度** | `140px` | `160px` | `200px` |
| **Item 单行高度** | `26px` | `30px` | `36px` |
| **Item 多行最小高度** | `36px` (自适应) | `44px` (自适应) | `52px` (自适应) |
| **Item 选项圆角** | `8px` ($12-4=8$) | `8px` ($14-6=8$) | `8px` ($16-8=8$) |
| **Item 左右内边距** | `8px` | `10px` | `12px` |
| **Chip 标签高度 / 圆角** | `20px` / `4px` | `24px` / `6px` | `28px` / `8px` |
| **图标尺寸 (Icon Size)** | `12px` | `14px` | `16px` |

#### Design Tokens 权威绑定矩阵

```css
/* 设计令牌绑定（严格遵守 tokens.css，严禁硬编码颜色） */
--select-trigger-bg: var(--bg-card, hsl(0 0% 100%));
--select-trigger-border: var(--border-color, hsl(35 10% 86%));
--select-trigger-hover-bg: var(--tint-hover);

--select-popup-bg: var(--bg-card, hsl(0 0% 100%));
--select-popup-border: var(--border-color, hsl(35 10% 86%));
--select-popup-shadow: 0 12px 32px -4px rgba(29, 28, 26, 0.12), 0 4px 12px -2px rgba(29, 28, 26, 0.04);

--select-item-hover-bg: var(--tint-hover);
--select-item-active-bg: var(--tint-active);
--select-item-check-color: var(--brand, #10b981);

--select-focus-ring: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
```

---

## 二、RL-03 单文件行数治理与原子拆解拓扑

### 2.1 物理拆分目录树全景拓扑

为彻底消除 `Select.tsx` (1081 行) 与 `Combobox.tsx` (1340 行) 违反工程红线 RL-03（单文件上限 500 行，目标 $\le 190$ 行）的问题，建立如下清晰的分层原子解耦目录拓扑：

```
apps/crish-desktop/src/components/ui/Select/
├── index.ts                           (全量聚合导出入口，≤ 50 行)
├── types.ts                           (统一 TypeScript 接口契约，≤ 160 行)
├── useFloatingPosition.ts             (零依赖浮层几何定位与 LayerStack Hook，≤ 180 行)
│
├── internal/                          (跨组件共享内部基础设施)
│   ├── SelectIcons.tsx                (共享微图标 ChevronUpDown, CheckIcon, ClearIcon，≤ 75 行)
│   ├── extractChildrenItems.ts        (JSX AST 静态提取 Item 元数据，≤ 65 行)
│   ├── comboboxHighlight.tsx          (纯函数无状态关键词高亮渲染器，≤ 50 行)
│   └── positionGeometry.ts            (纯数学几何解算与 Flip X/Y 算法，≤ 120 行)
│
├── select/                            (Select 核心复合组件族)
│   ├── SelectRoot.tsx                 (根状态机与 Context Provider，≤ 150 行)
│   ├── SelectTrigger.tsx              (大圆角触发器按钮与 A11y 绑定，≤ 130 行)
│   ├── SelectValue.tsx                (当前选值与占位符展示，≤ 60 行)
│   ├── SelectContent.tsx              (大圆角浮层卡片与 isPositioned 门闩，≤ 160 行)
│   ├── SelectItem.tsx                 (同心圆角选项行与翡翠绿对勾，≤ 110 行)
│   ├── SelectGroup.tsx                (选项分组容器与 GroupLabel，≤ 60 行)
│   ├── SelectSeparator.tsx            (选项分割线，≤ 30 行)
│   ├── SelectClearButton.tsx          (无交互嵌套合规清空按钮，≤ 40 行)
│   ├── SelectLegacyAdapter.tsx        (存量 options 配置式 Props 兼容层，≤ 80 行)
│   ├── Select.tsx                     (Select 聚合入口与智能分流，≤ 55 行)
│   ├── SelectTrigger.module.css       (Trigger 专项发丝边框与尺寸样式，≤ 120 行)
│   └── SelectContent.module.css       (Content 专项同心圆角与动画样式，≤ 150 行)
│
└── combobox/                          (Combobox 核心复合组件族)
    ├── ComboboxRoot.tsx               (搜索过滤中枢与 Context Provider，≤ 175 行)
    ├── ComboboxInput.tsx              (单选搜索框与 50ms IME 合成锁门闩，≤ 155 行)
    ├── ComboboxChips.tsx              (多选 Chips 换行排版与 Backspace 纠偏，≤ 180 行)
    ├── ComboboxChip.tsx               (选值胶囊与微型删除按钮 tabIndex=-1，≤ 70 行)
    ├── ComboboxContent.tsx            (浮层卡片与 LayerStack 驱逐联动，≤ 160 行)
    ├── ComboboxList.tsx               (列表与网格排版容器，≤ 75 行)
    ├── ComboboxItem.tsx               (选项行与关键词高亮集成，≤ 115 行)
    ├── ComboboxEmpty.tsx              (搜索无结果时的优雅空态，≤ 40 行)
    ├── ComboboxGroup.tsx              (分组容器与 Label，≤ 60 行)
    ├── ComboboxSeparator.tsx          (分割线，≤ 30 行)
    ├── ComboboxLegacyAdapter.tsx      (存量 items 配置式兼容层，≤ 85 行)
    ├── Combobox.tsx                   (Combobox 聚合入口与智能分流，≤ 55 行)
    └── Combobox.module.css            (Combobox 专项样式，≤ 190 行)
```

---

### 2.2 共享内部基础设施（`internal/`）设计

1. **`internal/SelectIcons.tsx`**：
   - 包含 `ChevronUpDown`（图 2/3 标准上下双箭头）、`CheckIcon`（14px 翡翠绿勾）、`ClearIcon`（12px 柔和叉号）；
   - 完全消除原先在 `Select.tsx` 与 `Combobox.tsx` 中各拷贝一份导致的代码重复。
2. **`internal/extractChildrenItems.ts`**：
   - 提取 JSX 子节点中的 `SelectItem` / `ComboboxItem` 元数据（`value`, `label`, `disabled`），统一为单一纯函数。
3. **`internal/comboboxHighlight.tsx`**：
   - 纯函数无状态关键词高亮器，杜绝全局正则的 `lastIndex` 变异。
4. **`internal/positionGeometry.ts`**：
   - 纯数学几何解算，解耦 DOM 依赖，包含 Flip Y, Flip X, Two-Way Clamping 与 `transformOrigin` 对应关系。

---

### 2.3 Select 复合组件族谱系与行数预算

| 文件名称 | 职责边界 | 预估有效代码行 | RL-03 上限 (500行) 裕量 | 状态 |
|---|---|---|---|---|
| `select/SelectRoot.tsx` | 根状态机（受控/非受控 value、open、itemMap 注册表） | ~145 行 | **71% 裕量** | 🟢 极佳 |
| `select/SelectTrigger.tsx` | 原生 `<button>` 触发器、`ChevronUpDown` 双箭头、A11y 绑定 | ~125 行 | **75% 裕量** | 🟢 极佳 |
| `select/SelectValue.tsx` | 选值 Label 计算与 Placeholder 渲染 | ~55 行 | **89% 裕量** | 🟢 极佳 |
| `select/SelectContent.tsx` | Portal 浮层、`isPositioned` 隐藏门闩、LayerStack 调度 | ~155 行 | **69% 裕量** | 🟢 极佳 |
| `select/SelectItem.tsx` | 选项行交互、同心圆角、Hover 态与翡翠绿对勾 | ~105 行 | **79% 裕量** | 🟢 极佳 |
| `select/SelectGroup.tsx` | 分组容器与 GroupLabel | ~55 行 | **89% 裕量** | 🟢 极佳 |
| `select/SelectSeparator.tsx` | 分割线 | ~25 行 | **95% 裕量** | 🟢 极佳 |
| `select/SelectClearButton.tsx`| 合规 Presentation Span 清空按钮 | ~35 行 | **93% 裕量** | 🟢 极佳 |
| `select/SelectLegacyAdapter.tsx` | 存量 `options` 配置式 Props 兼容层 | ~75 行 | **85% 裕量** | 🟢 极佳 |
| `select/Select.tsx` | 聚合入口与分流路由 | ~50 行 | **90% 裕量** | 🟢 极佳 |

---

### 2.4 Combobox 复合组件族谱系与行数预算

| 文件名称 | 职责边界 | 预估有效代码行 | RL-03 上限 (500行) 裕量 | 状态 |
|---|---|---|---|---|
| `combobox/ComboboxRoot.tsx` | 搜索过滤引擎、Display Label 与 Transient Query 解耦 | ~170 行 | **66% 裕量** | 🟢 极佳 |
| `combobox/ComboboxInput.tsx` | 单选输入框、50ms IME 合成锁门闩与 A11y 键盘漫游 | ~150 行 | **70% 裕量** | 🟢 极佳 |
| `combobox/ComboboxChips.tsx` | 多选 Chips 自适应换行、左右横向漫游与 Backspace 竞态纠偏 | ~175 行 | **65% 裕量** | 🟢 极佳 |
| `combobox/ComboboxChip.tsx` | 选值胶囊与微型删除按钮（`tabIndex={-1}`） | ~65 行 | **87% 裕量** | 🟢 极佳 |
| `combobox/ComboboxContent.tsx` | Portal 浮层、`isPositioned` 门闩与 LayerStack 联动 | ~155 行 | **69% 裕量** | 🟢 极佳 |
| `combobox/ComboboxList.tsx` | 列表与网格容器 | ~70 行 | **86% 裕量** | 🟢 极佳 |
| `combobox/ComboboxItem.tsx` | 选项行与关键词高亮渲染集成 | ~110 行 | **78% 裕量** | 🟢 极佳 |
| `combobox/ComboboxEmpty.tsx` | 搜索无结果时的优雅空态 | ~35 行 | **93% 裕量** | 🟢 极佳 |
| `combobox/ComboboxGroup.tsx` | 分组容器与 Label | ~55 行 | **89% 裕量** | 🟢 极佳 |
| `combobox/ComboboxSeparator.tsx` | 分割线 | ~25 行 | **95% 裕量** | 🟢 极佳 |
| `combobox/ComboboxLegacyAdapter.tsx` | 存量 `items` 配置式兼容层 | ~80 行 | **84% 裕量** | 🟢 极佳 |
| `combobox/Combobox.tsx` | 聚合入口与分流路由 | ~50 行 | **90% 裕量** | 🟢 极佳 |

---

### 2.5 样式解耦与 Token 纯进化拆分

原 `Select.module.css` (519 行) 存在样式混杂与超长问题。拆分为：
1. `SelectTrigger.module.css`（~110 行）：专精于触发器的高宽、发丝边框、双箭头翻转、焦点环与 Disabled 态；
2. `SelectContent.module.css`（~145 行）：专精于大圆角浮层（14px/16px）、均等内边距（6px/8px）、同心 Item 行（8px）、翡翠绿 Checkmark 绘制、深空投影与进场动画；
3. `Combobox.module.css`（~185 行）：专精于 Chips 换行容器、胶囊样式、输入框与高亮 Span。

---

## 三、核心交互缺陷与底层算法深度根治

### 3.1 `highlightMatches` 正则无状态化（消除 `lastIndex` 变异 Bug）

#### 缺陷机制剖析
原实现：
```typescript
const regex = new RegExp(`(${escaped})`, 'gi');
const parts = text.split(regex);
return parts.map((part, i) =>
  regex.test(part) ? <span>{part}</span> : part // BUG: regex.test 推进了 lastIndex!
);
```
带有 `g` 标记的正则表达式对象是有状态的（Stateful），每次调用 `regex.test(part)` 会将内部指针 `regex.lastIndex` 向前推进。当 `parts.map` 循环迭代到下一段本应命中的子串时，`test()` 从非零偏移开始匹配导致返回 `false`，产生高亮偶发性丢失！

#### 纯函数无状态根治方案
```typescript
/**
 * apps/crish-desktop/src/components/ui/Select/internal/comboboxHighlight.tsx
 */
import React from 'react';
import styles from '../combobox/Combobox.module.css';

export function highlightMatches(text: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!trimmed || !text) return text;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 拆分使用带捕获括号的 gi 正则
  const splitRegex = new RegExp(`(${escaped})`, 'gi');
  // 单段判定使用无 g 标志的纯净单次正则，杜绝 lastIndex 变异
  const testRegex = new RegExp(`^${escaped}$`, 'i');

  const parts = text.split(splitRegex);
  if (parts.length <= 1) return text;

  return parts.map((part, i) =>
    testRegex.test(part) ? (
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

### 3.2 50ms 中文拼音 IME 合成锁门闩（Composition Guard）

#### 缺陷机制剖析
在 Chromium / WebView2 环境中，用户使用中文输入法键入拼音并按下 `Enter` 键确认上屏英文字符时，浏览器的事件触发顺序为：
1. `compositionend`（输入法合成结束）；
2. `keydown`（`key: 'Enter'`, `keyCode: 13`, `isComposing: false`）。

若在 `onCompositionEnd` 中直接同步将 `isComposingRef.current` 置为 `false`，紧随其后的 `keydown` 会误判为用户确认选项提交，导致意外选中下拉列表第一项并强行关闭弹窗。

#### 50ms 时间戳合成门闩
```typescript
const isComposingRef = useRef(false);
const compositionEndTimeRef = useRef(0);

const handleCompositionStart = () => {
  isComposingRef.current = true;
};

const handleCompositionEnd = () => {
  isComposingRef.current = false;
  compositionEndTimeRef.current = performance.now();
};

const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
  // 组合输入法安全拦截：合成中、keyCode 229、Process 键或刚刚结束合成 50ms 内一律阻断
  if (
    isComposingRef.current ||
    e.nativeEvent.isComposing ||
    e.keyCode === 229 ||
    e.key === 'Process' ||
    performance.now() - compositionEndTimeRef.current < 50
  ) {
    return;
  }

  // 正常回车提交逻辑...
};
```

---

### 3.3 LayerStack 全量驱逐事件捕获（修复 `programmatic` 漏判）

#### 缺陷机制剖析
在 `SelectContent` 与 `ComboboxContent` 中，原实现仅检查：
`if (reason === 'outside-pointer' || reason === 'escape' || reason === 'parent-dismissed') setOpen(false);`
当同级另一个互斥浮层（`exclusive-peer`）打开时，LayerStack 发出 `reason: 'programmatic'` 驱逐信号。由于被白名单漏判，已打开的 Select 拒绝关闭，脱离 LayerStack 栈管理后成为孤立驻留在 DOM 视口中的僵尸浮层。

#### 极致修复方案
```typescript
onDismiss: (reason: DismissReason) => {
  // 覆盖 outside-pointer, escape, parent-dismissed 以及同级互斥的 programmatic 驱逐信号
  if (reason !== 'item-select') {
    setOpen(false);
  }
}
```

---

### 3.4 首帧 `(0, 0)` 瞬态裸露闪烁根治与 `isPositioned` 门闩状态机

#### 缺陷机制剖析
`useFloatingPosition` 初始坐标为 `{ x: 0, y: 0, isPositioned: false }`。当 `open` 变为 `true` 时，Portal 立即在 DOM 挂载渲染 `<div style={{ left: '0px', top: '0px' }}>` 并触发 CSS 进场动画。虽然 `useLayoutEffect` 同步计算了真实坐标，但第一帧已在屏幕左上角绘制，产生肉眼可见的瞬态跳跃。

#### 门闩状态机方案
浮层在首帧测量完成前必须保持 `visibility: hidden; pointer-events: none`，仅当 `isPositioned === true` 时才展示并激活进场动画：

```tsx
<div
  ref={contentRef as React.RefObject<HTMLDivElement>}
  id={listboxId}
  role="listbox"
  tabIndex={-1}
  data-slot="select-content"
  className={contentClass}
  style={{
    left: `${position.x}px`,
    top: `${position.y}px`,
    transformOrigin: position.transformOrigin,
    visibility: position.isPositioned ? 'visible' : 'hidden',
    pointerEvents: position.isPositioned ? 'auto' : 'none',
  }}
  onKeyDown={handleKeyDown}
>
  <div className={contentStyles.list}>{children}</div>
</div>
```

---

### 3.5 双向视口避让（Flip Y / Flip X）与 `transformOrigin` 联动数学模型

纯数学几何解算引擎同时在垂直与水平两个维度进行可用空间评估与自动翻折，且保证 `transformOrigin` 严格与实际解算落位方位绑定：

```
                    ┌──────────────────────────────────────────────┐
                    │               Viewport Bounds                │
                    │                                              │
                    │             ┌──────────────────┐             │
                    │             │ actualSide = top │             │
                    │             └────────▲─────────┘             │
                    │                      │ (sideOffset)          │
  Flip X ◄──────────┼─────────────── Trigger ──────────────────────┼──────────► Flip X
 (Space Left)       │             ┌────────┴─────────┐             │ (Space Right)
                    │             │ actualSide=bottom│             │
                    │             └──────────────────┘             │
                    │                                              │
                    └──────────────────────────────────────────────┘
```

- 当 `side === 'bottom'` 且下方空间不足时，自动翻折至上方（`actualSide = 'top'`）；
- 当 `align === 'start'` 且右侧空间不足以容纳浮层宽度时，自动翻折至右对齐（`actualAlign = 'end'`）；
- 严格双向数学钳位（Two-Way Clamping）：
  - $x = \text{clamp}(\text{offsetLeft} + \text{edgePadding}, x, \text{offsetLeft} + \text{vp.width} - \text{popupWidth} - \text{edgePadding})$
  - $y = \text{clamp}(\text{offsetTop} + \text{edgePadding}, y, \text{offsetTop} + \text{vp.height} - \text{popupHeight} - \text{edgePadding})$
- 动态联动 `transformOrigin`：
  - $\text{originY} = \text{actualSide} === \text{'top'} ? \text{'bottom'} : \text{'top'}$
  - $\text{originX} = \text{actualAlign} === \text{'end'} ? \text{'right'} : \text{actualAlign} === \text{'center'} ? \text{'center'} : \text{'left'}$
  - 缩放动画原点完美贴合触发器相对锚点，杜绝斜向形变。

---

### 3.6 全局滚动 RAF 节流与浮层内部滚动事件隔离

1. **浮层内部滚动事件隔离**：当浮层内部出现垂直滚动条时，用户在浮层内滚动会触发捕获阶段的全局 `scroll` 事件。若事件源在 `contentRef.current` 内部，直接跳过定位更新，杜绝 Layout Thrashing。
2. **`requestAnimationFrame` 调度**：外部视口滚动与 resize 统一接入 RAF 节流。

```typescript
useEffect(() => {
  if (!open) return;

  let rafId: number | null = null;
  const throttledUpdate = (e?: Event) => {
    // 过滤浮层内部自身的滚动事件
    if (
      e &&
      e.type === 'scroll' &&
      contentRef.current &&
      contentRef.current.contains(e.target as Node)
    ) {
      return;
    }

    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      updatePosition();
      rafId = null;
    });
  };

  window.addEventListener('resize', throttledUpdate, { passive: true });
  window.addEventListener('scroll', throttledUpdate, { passive: true, capture: true });

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    window.removeEventListener('resize', throttledUpdate);
    window.removeEventListener('scroll', throttledUpdate, true);
  };
}, [open, updatePosition, contentRef]);
```

---

### 3.7 触发器盒模型 `ResizeObserver` 动态锚点联动与纯 ID 规范

1. **`ResizeObserver` 挂载在 `triggerRef.current`**：当侧边栏折叠/展开、窗口伸缩或 SplitPane 拖拽导致 Trigger 物理宽度改变时，自动重新解算 `--anchor-width`，使浮层宽度始终与输入框对齐。
2. **React 原生 `useId()`**：取代 `Math.random()`，保证 SSR 水合一致性与确定性 ID 引用。

---

### 3.8 `ComboboxChips` 倒格删除异步闭包竞态修复与光标驻留

1. **索引自动纠偏**：通过 `useEffect` 监听 `valuesArray.length` 与 `activeChipIndex`，在连续快速按 Backspace 导致数组缩短时，自动将索引纠偏至有效范围或重置为 `-1`。
2. **光标焦点驻留**：移除 Chip 后，立即调用 `inputRef.current?.focus()`，保证光标留在搜索输入框内，不掉落到 `document.body`。
3. **微型删除按钮 `tabIndex={-1}`**：防止多选 10 个胶囊时 Tab 键需要按 10 次的深坑。

---

### 3.9 `<SelectTrigger>` HTML5 规范合规重构（清退嵌套交互元素）

#### 规范违规剖析
HTML5 与 WAI-ARIA 规范严格禁止在 `<button>` 内部嵌套带有交互语义的子元素（如 `<button>` 或 `<span role="button">`）。
在重构中，`SelectClearButton` 渲染为无语义的 Presentation `<span data-slot="select-clear-button">`，通过 `e.stopPropagation()` 与 `e.preventDefault()` 阻止冒泡，同时 Trigger 支持键盘 `Backspace / Delete` 直接清空，完全符合无障碍规范。

---

### 3.10 单选模式 Display Label 与 Transient Search Query 状态解耦

在单选 Combobox 中，用户选中国际象棋模型 `"DeepSeek-R1"` 后，组件应维护：
- `displayLabel`：用于在输入框中展示当前已选模型全名；
- `transientQuery`：用户实际在输入框中敲入的新搜索词。
当用户再次点击获得焦点时，自动调用 `input.select()` 全选当前文本。仅当用户真正键入新字符时才启动选项过滤；若直接展开，完整选项列表全部可用，杜绝二次展开被自身 Label 过滤为 1 项的严重交互缺陷。

---

### 3.11 多行选项文字重叠根治与自适应高度弹性排版

#### 缺陷根治
根据审查报告 `06`，多行选项（标题 + 副文本说明）文字重叠的根因在于旧 CSS 硬编码了 `height: 28px;`。
在 `SelectItem` 与 `SelectContent.module.css` 中：
- 选项容器使用 `min-height: 32px; height: auto; padding: 8px 10px;`；
- 内容列使用 `display: flex; flex-direction: column; gap: 2px; line-height: 1.35;`；
- 浮层支持通过 CSS 变量或 Prop 自适应放宽至 `min-width: 260px; max-width: 360px;`，单行容纳完整描述，彻底消除挤压折行与文字刺穿。

---

## 四、Select 复合组件族实现详案与源码规格

### 4.1 `SelectRoot.tsx`（根状态机与 Provider）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectRoot.tsx
 * Select 根组件与 Provider 状态编排 (RL-03 目标: ≤ 150 行)
 */
import React, { createContext, useContext, useState, useRef, useCallback, useId } from 'react';
import type { SelectSize, SelectVariant, SelectContextValue } from '../types';

export const SelectContext = createContext<SelectContextValue | null>(null);

export function useSelectContext(): SelectContextValue {
  const ctx = useContext(SelectContext);
  if (!ctx) {
    throw new Error('[Select] Compound components must be rendered inside <Select>');
  }
  return ctx;
}

export interface SelectRootProps {
  value?: string | string[] | null;
  defaultValue?: string | string[] | null;
  onValueChange?: (value: string | string[] | null) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: SelectSize;
  variant?: SelectVariant;
  multiple?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  children: React.ReactNode;
}

export function SelectRoot({
  value: externalValue,
  defaultValue = null,
  onValueChange,
  open: externalOpen,
  defaultOpen = false,
  onOpenChange,
  size = 'md',
  variant = 'outline',
  multiple = false,
  clearable = false,
  disabled = false,
  id: externalId,
  children,
}: SelectRootProps) {
  const autoId = useId();
  const selectId = externalId ?? `conex-select-${autoId}`;

  // 1. 选值状态管理
  const isControlledValue = externalValue !== undefined;
  const [internalValue, setInternalValue] = useState<string | string[] | null>(defaultValue);
  const value = isControlledValue ? externalValue : internalValue;

  const handleValueChange = useCallback(
    (nextVal: string | string[] | null) => {
      if (!isControlledValue) setInternalValue(nextVal);
      onValueChange?.(nextVal);
    },
    [isControlledValue, onValueChange]
  );

  // 2. 展开状态管理
  const isControlledOpen = externalOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = isControlledOpen ? Boolean(externalOpen) : internalOpen;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (disabled) return;
      if (!isControlledOpen) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [disabled, isControlledOpen, onOpenChange]
  );

  // 3. 键盘漫游索引与 Item 注册表
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const itemMapRef = useRef<Map<string, { id: string; value: string; disabled?: boolean; label: string; index: number }>>(
    new Map()
  );

  const registerItem = useCallback(
    (id: string, itemValue: string, disabledItem?: boolean, label = '') => {
      const currentMap = itemMapRef.current;
      const index = currentMap.size;
      currentMap.set(itemValue, { id, value: itemValue, disabled: disabledItem, label, index });
      return () => {
        currentMap.delete(itemValue);
      };
    },
    []
  );

  // 4. 清空处理
  const clear = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      if (disabled) return;
      const emptyVal = multiple ? [] : null;
      handleValueChange(emptyVal);
    },
    [disabled, multiple, handleValueChange]
  );

  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);

  const contextValue: SelectContextValue = {
    value,
    defaultValue,
    onValueChange: handleValueChange,
    open,
    setOpen: handleOpenChange,
    size,
    variant,
    multiple,
    clearable,
    disabled,
    selectId,
    highlightedIndex,
    setHighlightedIndex,
    triggerRef,
    contentRef,
    registerItem,
    itemMap: itemMapRef.current,
    clear,
  };

  return <SelectContext.Provider value={contextValue}>{children}</SelectContext.Provider>;
}
```

---

### 4.2 `SelectTrigger.tsx`（大圆角触发器与 ChevronUpDown）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectTrigger.tsx
 * 大圆角触发器与 ChevronUpDown 上下双箭头 (RL-03 目标: ≤ 130 行)
 */
import React, { forwardRef, useCallback } from 'react';
import { useSelectContext } from './SelectRoot';
import { ChevronUpDownIcon } from '../internal/SelectIcons';
import { SelectClearButton } from './SelectClearButton';
import styles from './SelectTrigger.module.css';

export interface SelectTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  startSlot?: React.ReactNode;
  endSlot?: React.ReactNode;
  clearable?: boolean;
  children?: React.ReactNode;
}

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(function SelectTrigger(
  { startSlot, endSlot, clearable: propClearable, className, children, onKeyDown, onClick, ...restProps },
  forwardedRef
) {
  const ctx = useSelectContext();
  const isClearable = propClearable ?? ctx.clearable;
  const hasValue = ctx.multiple
    ? Array.isArray(ctx.value) && ctx.value.length > 0
    : ctx.value != null && ctx.value !== '';

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (ctx.disabled) return;
      onClick?.(e);
      if (!e.defaultPrevented) {
        ctx.setOpen(!ctx.open);
      }
    },
    [ctx, onClick]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || ctx.disabled) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        ctx.setOpen(true);
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && isClearable && hasValue) {
        e.preventDefault();
        ctx.clear(e);
      }
    },
    [ctx, isClearable, hasValue, onKeyDown]
  );

  const listboxId = `${ctx.selectId}-listbox`;

  const triggerClass = [
    styles.trigger,
    styles[`size-${ctx.size}`],
    styles[`variant-${ctx.variant}`],
    ctx.open ? styles.open : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={(el) => {
        (ctx.triggerRef as React.MutableRefObject<HTMLElement | null>).current = el;
        if (typeof forwardedRef === 'function') forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
      id={ctx.selectId}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={ctx.open}
      aria-controls={ctx.open ? listboxId : undefined}
      aria-disabled={ctx.disabled || undefined}
      disabled={ctx.disabled}
      className={triggerClass}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-state={ctx.open ? 'open' : 'closed'}
      data-size={ctx.size}
      {...restProps}
    >
      <div className={styles.triggerLeft}>
        {startSlot && <span className={styles.startSlot}>{startSlot}</span>}
        {children}
      </div>

      <div className={styles.triggerRight}>
        {endSlot && <span className={styles.endSlot}>{endSlot}</span>}
        {isClearable && hasValue && !ctx.disabled && (
          <SelectClearButton onClick={ctx.clear} size={ctx.size} />
        )}
        <span className={styles.chevron} aria-hidden="true">
          <ChevronUpDownIcon size={ctx.size === 'sm' ? 12 : ctx.size === 'lg' ? 16 : 14} />
        </span>
      </div>
    </button>
  );
});

SelectTrigger.displayName = 'SelectTrigger';
```

---

### 4.3 `SelectValue.tsx`（选值/占位符渲染）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectValue.tsx
 * 当前选值与占位符展示 (RL-03 目标: ≤ 60 行)
 */
import React from 'react';
import { useSelectContext } from './SelectRoot';
import styles from './SelectTrigger.module.css';

export interface SelectValueProps {
  placeholder?: string;
  className?: string;
  children?: React.ReactNode | ((value: string | string[] | null) => React.ReactNode);
}

export function SelectValue({ placeholder = '请选择...', className, children }: SelectValueProps) {
  const ctx = useSelectContext();
  const { value, multiple, itemMap } = ctx;

  let displayNode: React.ReactNode = null;

  if (typeof children === 'function') {
    displayNode = children(value);
  } else if (children != null) {
    displayNode = children;
  } else if (multiple && Array.isArray(value)) {
    if (value.length === 0) {
      displayNode = <span className={styles.placeholder}>{placeholder}</span>;
    } else {
      const labels = value.map((v) => itemMap.get(v)?.label || v);
      displayNode = <span className={styles.valueText}>{labels.join(', ')}</span>;
    }
  } else if (value != null && value !== '') {
    const singleLabel = itemMap.get(value as string)?.label || (value as string);
    displayNode = <span className={styles.valueText}>{singleLabel}</span>;
  } else {
    displayNode = <span className={styles.placeholder}>{placeholder}</span>;
  }

  return <span className={`${styles.valueContainer} ${className ?? ''}`}>{displayNode}</span>;
}
```

---

### 4.4 `SelectContent.tsx`（大圆角浮层与 isPositioned 门闩）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectContent.tsx
 * 大圆角浮层卡片与 isPositioned 隐藏门闩 (RL-03 目标: ≤ 160 行)
 */
import React, { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSelectContext } from './SelectRoot';
import { useFloatingPosition } from '../useFloatingPosition';
import type { DismissReason } from '../../internal/layer-stack/layerStackTypes';
import styles from './SelectContent.module.css';

export interface SelectContentProps {
  align?: 'start' | 'center' | 'end';
  side?: 'bottom' | 'top';
  sideOffset?: number;
  edgePadding?: number;
  className?: string;
  children: React.ReactNode;
}

export function SelectContent({
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  edgePadding = 8,
  className,
  children,
}: SelectContentProps) {
  const ctx = useSelectContext();
  const { open, setOpen, triggerRef, contentRef, selectId, multiple } = ctx;

  const position = useFloatingPosition({
    open,
    triggerRef,
    contentRef,
    side,
    align,
    sideOffset,
    edgePadding,
    onDismiss: (reason: DismissReason) => {
      // 捕获所有合法解散信号（包括 programmatic 驱逐与 outside-pointer）
      if (reason !== 'item-select') {
        setOpen(false);
      }
    },
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        (triggerRef.current as HTMLElement | null)?.focus();
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    },
    [setOpen, triggerRef]
  );

  useEffect(() => {
    if (open && position.isPositioned) {
      contentRef.current?.focus();
    }
  }, [open, position.isPositioned, contentRef]);

  if (!open) return null;

  const contentClass = [
    styles.content,
    styles[`size-${ctx.size}`],
    position.isPositioned ? styles.positioned : styles.unpositioned,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const popupElement = (
    <div
      ref={contentRef as React.RefObject<HTMLDivElement>}
      id={`${selectId}-listbox`}
      role="listbox"
      tabIndex={-1}
      aria-multiselectable={multiple || undefined}
      data-slot="select-content"
      className={contentClass}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        visibility: position.isPositioned ? 'visible' : 'hidden',
        pointerEvents: position.isPositioned ? 'auto' : 'none',
      }}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.scrollViewport}>{children}</div>
    </div>
  );

  return createPortal(popupElement, document.body);
}
```

---

### 4.5 `SelectItem.tsx`（同心圆角、翡翠绿对勾与多行自适应）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectItem.tsx
 * 同心圆角选项行、翡翠绿对勾与自适应多行 (RL-03 目标: ≤ 110 行)
 */
import React, { useEffect, useId, useCallback } from 'react';
import { useSelectContext } from './SelectRoot';
import { CheckIcon } from '../internal/SelectIcons';
import styles from './SelectContent.module.css';

export interface SelectItemProps {
  value: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  shortcut?: string;
  className?: string;
  children: React.ReactNode;
}

export function SelectItem({
  value: itemValue,
  disabled = false,
  icon,
  hint,
  shortcut,
  className,
  children,
}: SelectItemProps) {
  const ctx = useSelectContext();
  const autoId = useId();
  const itemId = `${ctx.selectId}-item-${autoId}`;

  const isSelected = ctx.multiple
    ? Array.isArray(ctx.value) && ctx.value.includes(itemValue)
    : ctx.value === itemValue;

  const labelText = typeof children === 'string' ? children : itemValue;

  useEffect(() => {
    return ctx.registerItem(itemId, itemValue, disabled, labelText);
  }, [ctx, itemId, itemValue, disabled, labelText]);

  const handleSelect = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (disabled || ctx.disabled) return;

      if (ctx.multiple) {
        const currentVals = Array.isArray(ctx.value) ? [...ctx.value] : [];
        const nextVals = isSelected
          ? currentVals.filter((v) => v !== itemValue)
          : [...currentVals, itemValue];
        ctx.onValueChange(nextVals);
      } else {
        ctx.onValueChange(itemValue);
        ctx.setOpen(false);
        (ctx.triggerRef.current as HTMLElement | null)?.focus();
      }
    },
    [disabled, ctx, isSelected, itemValue]
  );

  const itemClass = [
    styles.item,
    styles[`itemSize-${ctx.size}`],
    isSelected ? styles.selected : null,
    disabled ? styles.disabled : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      id={itemId}
      role="option"
      aria-selected={isSelected}
      aria-disabled={disabled || undefined}
      data-slot="select-item"
      data-value={itemValue}
      className={itemClass}
      onClick={handleSelect}
    >
      <div className={styles.itemMain}>
        {icon && <span className={styles.itemIcon}>{icon}</span>}
        <div className={styles.itemTextCol}>
          <span className={styles.itemLabel}>{children}</span>
          {hint && <span className={styles.itemHint}>{hint}</span>}
        </div>
      </div>

      <div className={styles.itemRight}>
        {shortcut && <span className={styles.itemShortcut}>{shortcut}</span>}
        <span className={`${styles.checkWrap} ${isSelected ? styles.checked : ''}`}>
          {isSelected && <CheckIcon size={ctx.size === 'sm' ? 12 : 14} />}
        </span>
      </div>
    </div>
  );
}
```

---

### 4.6 `SelectGroup.tsx`, `SelectSeparator.tsx`, `SelectClearButton.tsx`

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectGroup.tsx
 */
import React from 'react';
import styles from './SelectContent.module.css';

export interface SelectGroupProps {
  label?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function SelectGroup({ label, children, className }: SelectGroupProps) {
  return (
    <div role="group" className={`${styles.group} ${className ?? ''}`}>
      {label && <div className={styles.groupLabel}>{label}</div>}
      {children}
    </div>
  );
}
```

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectSeparator.tsx
 */
import React from 'react';
import styles from './SelectContent.module.css';

export function SelectSeparator({ className }: { className?: string }) {
  return <div role="separator" aria-orientation="horizontal" className={`${styles.separator} ${className ?? ''}`} />;
}
```

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectClearButton.tsx
 * Presentation Span 结构（无交互嵌套违规）
 */
import React from 'react';
import { ClearIcon } from '../internal/SelectIcons';
import styles from './SelectTrigger.module.css';

export function SelectClearButton({
  onClick,
  size = 'md',
}: {
  onClick?: (e: React.MouseEvent) => void;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span
      data-slot="select-clear-button"
      className={styles.clearBtn}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick?.(e);
      }}
      aria-hidden="true"
    >
      <ClearIcon size={size === 'sm' ? 10 : 12} />
    </span>
  );
}
```

---

### 4.7 `SelectLegacyAdapter.tsx` & `Select.tsx`（存量无缝分流入口）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/SelectLegacyAdapter.tsx
 * 存量 options 配置式 Props 兼容层 (RL-03 目标: ≤ 80 行)
 */
import React from 'react';
import { SelectRoot } from './SelectRoot';
import { SelectTrigger } from './SelectTrigger';
import { SelectValue } from './SelectValue';
import { SelectContent } from './SelectContent';
import { SelectItem } from './SelectItem';
import type { LegacySelectProps } from '../types';
import styles from './SelectTrigger.module.css';

export function SelectLegacyAdapter({
  value,
  onChange,
  options = [],
  placeholder = '请选择...',
  disabled = false,
  error,
  label,
  size = 'md',
  id,
  className,
  clearable = false,
}: LegacySelectProps) {
  return (
    <div className={styles.legacyWrapper}>
      {label && (
        <label className={styles.legacyLabel} htmlFor={id}>
          {label}
        </label>
      )}
      <SelectRoot
        value={value}
        onValueChange={(v) => onChange?.(v as string)}
        size={size}
        disabled={disabled}
        clearable={clearable}
        id={id}
      >
        <SelectTrigger className={`${error ? styles.triggerError : ''} ${className ?? ''}`}>
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
      </SelectRoot>
      {error && <p className={styles.legacyErrorText}>{error}</p>}
    </div>
  );
}
```

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/select/Select.tsx
 * 智能分流主入口 (RL-03 目标: ≤ 50 行)
 */
import React from 'react';
import { SelectRoot, type SelectRootProps } from './SelectRoot';
import { SelectLegacyAdapter } from './SelectLegacyAdapter';
import type { LegacySelectProps } from '../types';

export type UnifiedSelectProps = SelectRootProps | LegacySelectProps;

export function Select(props: UnifiedSelectProps) {
  if ('options' in props && Array.isArray(props.options)) {
    return <SelectLegacyAdapter {...(props as LegacySelectProps)} />;
  }
  return <SelectRoot {...(props as SelectRootProps)} />;
}
```

---

## 五、Combobox 复合组件族实现详案与源码规格

### 5.1 `ComboboxRoot.tsx`（搜索过滤与状态中枢）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxRoot.tsx
 * Combobox 根状态机与搜索解耦中枢 (RL-03 目标: ≤ 175 行)
 */
import React, { createContext, useContext, useState, useRef, useCallback, useId } from 'react';
import type { ComboboxContextValue, SelectSize, SelectVariant } from '../types';

export const ComboboxContext = createContext<ComboboxContextValue | null>(null);

export function useComboboxContext(): ComboboxContextValue {
  const ctx = useContext(ComboboxContext);
  if (!ctx) {
    throw new Error('[Combobox] Compound components must be rendered inside <Combobox>');
  }
  return ctx;
}

export interface ComboboxRootProps<T = any> {
  items?: T[];
  value?: string | string[] | null;
  defaultValue?: string | string[] | null;
  onValueChange?: (value: string | string[] | null) => void;
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
  id?: string;
  children: React.ReactNode;
}

export function ComboboxRoot<T = any>({
  items = [],
  value: externalValue,
  defaultValue = null,
  onValueChange,
  query: externalQuery,
  onQueryChange,
  filter,
  open: externalOpen,
  defaultOpen = false,
  onOpenChange,
  size = 'md',
  variant = 'outline',
  multiple = false,
  clearable = false,
  grid = false,
  cols = 1,
  disabled = false,
  id: externalId,
  children,
}: ComboboxRootProps<T>) {
  const autoId = useId();
  const comboboxId = externalId ?? `conex-combobox-${autoId}`;

  // 1. 选值状态
  const isControlledValue = externalValue !== undefined;
  const [internalValue, setInternalValue] = useState<string | string[] | null>(defaultValue);
  const value = isControlledValue ? externalValue : internalValue;

  const handleValueChange = useCallback(
    (nextVal: string | string[] | null) => {
      if (!isControlledValue) setInternalValue(nextVal);
      onValueChange?.(nextVal);
    },
    [isControlledValue, onValueChange]
  );

  // 2. 搜索词状态（瞬态 Query 与选中 Display 解耦）
  const isControlledQuery = externalQuery !== undefined;
  const [internalQuery, setInternalQuery] = useState('');
  const query = isControlledQuery ? (externalQuery as string) : internalQuery;

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      if (!isControlledQuery) setInternalQuery(nextQuery);
      onQueryChange?.(nextQuery);
    },
    [isControlledQuery, onQueryChange]
  );

  // 3. 展开状态
  const isControlledOpen = externalOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = isControlledOpen ? Boolean(externalOpen) : internalOpen;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (disabled) return;
      if (!isControlledOpen) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [disabled, isControlledOpen, onOpenChange]
  );

  // 4. 内部过滤与项目映射
  const defaultFilter = useCallback((item: any, q: string) => {
    if (!q.trim()) return true;
    const label = item?.label ?? String(item);
    return label.toLowerCase().includes(q.trim().toLowerCase());
  }, []);

  const effectiveFilter = filter ?? defaultFilter;
  const filteredItems = items.filter((item) => effectiveFilter(item, query));

  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const clear = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      if (disabled) return;
      handleValueChange(multiple ? [] : null);
      handleQueryChange('');
    },
    [disabled, multiple, handleValueChange, handleQueryChange]
  );

  const contextValue: ComboboxContextValue = {
    value,
    defaultValue,
    onValueChange: handleValueChange,
    query,
    setQuery: handleQueryChange,
    open,
    setOpen: handleOpenChange,
    size,
    variant,
    multiple,
    clearable,
    grid,
    cols,
    disabled,
    selectId: comboboxId,
    highlightedIndex,
    setHighlightedIndex,
    triggerRef,
    contentRef,
    inputRef,
    filteredItems,
    clear,
  };

  return <ComboboxContext.Provider value={contextValue}>{children}</ComboboxContext.Provider>;
}
```

---

### 5.2 `ComboboxInput.tsx`（带 IME 保护的单选搜索框）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxInput.tsx
 * 50ms IME 合成锁门闩与 A11y 单选搜索框 (RL-03 目标: ≤ 155 行)
 */
import React, { forwardRef, useCallback, useRef } from 'react';
import { useComboboxContext } from './ComboboxRoot';
import { ChevronUpDownIcon, ClearIcon } from '../internal/SelectIcons';
import styles from './Combobox.module.css';

export interface ComboboxInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  startSlot?: React.ReactNode;
  endSlot?: React.ReactNode;
}

export const ComboboxInput = forwardRef<HTMLInputElement, ComboboxInputProps>(function ComboboxInput(
  { startSlot, endSlot, placeholder = '搜索或选择...', className, onKeyDown, onFocus, onChange, ...restProps },
  forwardedRef
) {
  const ctx = useComboboxContext();
  const isComposingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    compositionEndTimeRef.current = performance.now();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (
        isComposingRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229 ||
        e.key === 'Process' ||
        performance.now() - compositionEndTimeRef.current < 50
      ) {
        return; // 严格拦截中文输入法回车穿透
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        ctx.setOpen(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        ctx.setOpen(false);
      }
    },
    [ctx, onKeyDown]
  );

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      onFocus?.(e);
      ctx.setOpen(true);
      e.target.select();
    },
    [ctx, onFocus]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange?.(e);
      ctx.setQuery(e.target.value);
      if (!ctx.open) ctx.setOpen(true);
    },
    [ctx, onChange]
  );

  const inputWrapClass = [
    styles.inputWrap,
    styles[`size-${ctx.size}`],
    ctx.open ? styles.open : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={(el) => {
        (ctx.triggerRef as React.MutableRefObject<HTMLElement | null>).current = el;
      }}
      className={inputWrapClass}
    >
      {startSlot && <span className={styles.slotStart}>{startSlot}</span>}
      <input
        ref={(el) => {
          (ctx.inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
          if (typeof forwardedRef === 'function') forwardedRef(el);
          else if (forwardedRef) forwardedRef.current = el;
        }}
        id={ctx.selectId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={ctx.open}
        aria-controls={`${ctx.selectId}-listbox`}
        aria-disabled={ctx.disabled || undefined}
        disabled={ctx.disabled}
        className={styles.nativeInput}
        placeholder={placeholder}
        value={ctx.query}
        onFocus={handleFocus}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        {...restProps}
      />
      <div className={styles.slotEnd}>
        {ctx.clearable && ctx.query && !ctx.disabled && (
          <span className={styles.clearBtn} onClick={ctx.clear} aria-hidden="true">
            <ClearIcon size={12} />
          </span>
        )}
        {endSlot}
        <span className={styles.chevron} onClick={() => ctx.setOpen(!ctx.open)} aria-hidden="true">
          <ChevronUpDownIcon size={14} />
        </span>
      </div>
    </div>
  );
});

ComboboxInput.displayName = 'ComboboxInput';
```

---

### 5.3 `ComboboxChips.tsx` & `ComboboxChip.tsx`（多选换行胶囊）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxChips.tsx
 * 多选 Chips 自适应换行与 Backspace 竞态纠偏 (RL-03 目标: ≤ 180 行)
 */
import React, { forwardRef, useState, useEffect, useCallback } from 'react';
import { useComboboxContext } from './ComboboxRoot';
import styles from './Combobox.module.css';

export interface ComboboxChipsProps extends React.HTMLAttributes<HTMLDivElement> {
  placeholder?: string;
}

export const ComboboxChips = forwardRef<HTMLDivElement, ComboboxChipsProps>(function ComboboxChips(
  { placeholder = '输入标签...', className, children, ...restProps },
  forwardedRef
) {
  const ctx = useComboboxContext();
  const valuesArray = Array.isArray(ctx.value) ? ctx.value : [];
  const [activeChipIndex, setActiveChipIndex] = useState<number>(-1);

  // 1. 自动纠偏越界 activeChipIndex（防闭包竞态越界）
  useEffect(() => {
    if (activeChipIndex >= valuesArray.length) {
      setActiveChipIndex(valuesArray.length > 0 ? valuesArray.length - 1 : -1);
    }
  }, [valuesArray.length, activeChipIndex]);

  const handleContainerClick = () => {
    ctx.inputRef?.current?.focus();
    ctx.setOpen(true);
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Backspace' && ctx.query === '' && valuesArray.length > 0) {
        if (activeChipIndex === -1) {
          setActiveChipIndex(valuesArray.length - 1);
        } else {
          const toRemove = valuesArray[activeChipIndex];
          if (toRemove) {
            const nextVals = valuesArray.filter((v) => v !== toRemove);
            ctx.onValueChange(nextVals);
            setActiveChipIndex(activeChipIndex > 0 ? activeChipIndex - 1 : -1);
            ctx.inputRef?.current?.focus();
          }
        }
      } else if (e.key === 'ArrowLeft' && ctx.query === '' && valuesArray.length > 0) {
        if (activeChipIndex === -1) setActiveChipIndex(valuesArray.length - 1);
        else if (activeChipIndex > 0) setActiveChipIndex(activeChipIndex - 1);
      } else if (e.key === 'ArrowRight' && activeChipIndex !== -1) {
        if (activeChipIndex < valuesArray.length - 1) setActiveChipIndex(activeChipIndex + 1);
        else setActiveChipIndex(-1);
      } else {
        if (activeChipIndex !== -1) setActiveChipIndex(-1);
      }
    },
    [ctx, valuesArray, activeChipIndex]
  );

  return (
    <div
      ref={(el) => {
        (ctx.triggerRef as React.MutableRefObject<HTMLElement | null>).current = el;
        if (typeof forwardedRef === 'function') forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
      className={`${styles.chipsContainer} ${ctx.open ? styles.open : ''} ${className ?? ''}`}
      onClick={handleContainerClick}
      {...restProps}
    >
      {children}
      <input
        ref={ctx.inputRef as React.RefObject<HTMLInputElement>}
        className={styles.chipsInput}
        placeholder={valuesArray.length === 0 ? placeholder : ''}
        value={ctx.query}
        onChange={(e) => {
          ctx.setQuery(e.target.value);
          if (!ctx.open) ctx.setOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
});

ComboboxChips.displayName = 'ComboboxChips';
```

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxChip.tsx
 * 选值胶囊与微型删除按钮 (tabIndex=-1) (RL-03 目标: ≤ 70 行)
 */
import React from 'react';
import { useComboboxContext } from './ComboboxRoot';
import { ClearIcon } from '../internal/SelectIcons';
import styles from './Combobox.module.css';

export interface ComboboxChipProps {
  value: string;
  onRemove?: () => void;
  children: React.ReactNode;
}

export function ComboboxChip({ value, onRemove, children }: ComboboxChipProps) {
  const ctx = useComboboxContext();

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRemove) {
      onRemove();
    } else {
      const current = Array.isArray(ctx.value) ? ctx.value : [];
      ctx.onValueChange(current.filter((v) => v !== value));
    }
    ctx.inputRef?.current?.focus();
  };

  return (
    <span className={styles.chip}>
      <span className={styles.chipText}>{children}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Remove ${typeof children === 'string' ? children : value}`}
        className={styles.chipRemoveBtn}
        onClick={handleRemove}
      >
        <ClearIcon size={10} />
      </button>
    </span>
  );
}
```

---

### 5.4 `ComboboxContent.tsx`, `ComboboxList.tsx`, `ComboboxItem.tsx`

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxContent.tsx
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useComboboxContext } from './ComboboxRoot';
import { useFloatingPosition } from '../useFloatingPosition';
import type { DismissReason } from '../../internal/layer-stack/layerStackTypes';
import styles from './Combobox.module.css';

export function ComboboxContent({
  sideOffset = 6,
  edgePadding = 8,
  className,
  children,
}: {
  sideOffset?: number;
  edgePadding?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = useComboboxContext();

  const position = useFloatingPosition({
    open: ctx.open,
    triggerRef: ctx.triggerRef,
    contentRef: ctx.contentRef,
    sideOffset,
    edgePadding,
    onDismiss: (reason: DismissReason) => {
      if (reason !== 'item-select') {
        ctx.setOpen(false);
      }
    },
  });

  if (!ctx.open) return null;

  return createPortal(
    <div
      ref={ctx.contentRef as React.RefObject<HTMLDivElement>}
      id={`${ctx.selectId}-listbox`}
      role="listbox"
      tabIndex={-1}
      className={`${styles.comboboxPopup} ${position.isPositioned ? styles.positioned : styles.unpositioned} ${className ?? ''}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        visibility: position.isPositioned ? 'visible' : 'hidden',
        pointerEvents: position.isPositioned ? 'auto' : 'none',
      }}
    >
      <div className={styles.scrollViewport}>{children}</div>
    </div>,
    document.body
  );
}
```

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxList.tsx
 */
import React from 'react';
import { useComboboxContext } from './ComboboxRoot';
import styles from './Combobox.module.css';

export function ComboboxList<T = any>({
  cols,
  className,
  children,
}: {
  cols?: number;
  className?: string;
  children?: React.ReactNode | ((item: T, index: number) => React.ReactNode);
}) {
  const ctx = useComboboxContext();
  const effectiveCols = cols ?? ctx.cols ?? 1;

  if (typeof children === 'function') {
    return (
      <div className={`${styles.list} ${effectiveCols > 1 ? styles.grid : ''} ${className ?? ''}`}>
        {ctx.filteredItems.map((item, idx) => children(item as T, idx))}
      </div>
    );
  }

  return (
    <div className={`${styles.list} ${effectiveCols > 1 ? styles.grid : ''} ${className ?? ''}`}>
      {children}
    </div>
  );
}
```

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxItem.tsx
 */
import React, { useCallback } from 'react';
import { useComboboxContext } from './ComboboxRoot';
import { highlightMatches } from '../internal/comboboxHighlight';
import { CheckIcon } from '../internal/SelectIcons';
import styles from './Combobox.module.css';

export function ComboboxItem({
  value: itemValue,
  disabled = false,
  icon,
  hint,
  className,
  children,
}: {
  value: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = useComboboxContext();
  const isSelected = ctx.multiple
    ? Array.isArray(ctx.value) && ctx.value.includes(itemValue)
    : ctx.value === itemValue;

  const handleSelect = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (disabled || ctx.disabled) return;

      if (ctx.multiple) {
        const current = Array.isArray(ctx.value) ? ctx.value : [];
        ctx.onValueChange(
          isSelected ? current.filter((v) => v !== itemValue) : [...current, itemValue]
        );
      } else {
        ctx.onValueChange(itemValue);
        ctx.setOpen(false);
      }
      ctx.setQuery('');
      ctx.inputRef?.current?.focus();
    },
    [disabled, ctx, isSelected, itemValue]
  );

  const labelText = typeof children === 'string' ? children : itemValue;

  return (
    <div
      role="option"
      aria-selected={isSelected}
      aria-disabled={disabled || undefined}
      className={`${styles.item} ${isSelected ? styles.selected : ''} ${disabled ? styles.disabled : ''} ${className ?? ''}`}
      onClick={handleSelect}
    >
      <div className={styles.itemMain}>
        {icon && <span className={styles.itemIcon}>{icon}</span>}
        <div className={styles.itemTextCol}>
          <span className={styles.itemLabel}>{highlightMatches(labelText, ctx.query)}</span>
          {hint && <span className={styles.itemHint}>{hint}</span>}
        </div>
      </div>
      {isSelected && (
        <span className={styles.checkWrap}>
          <CheckIcon size={14} />
        </span>
      )}
    </div>
  );
}
```

---

### 5.5 `ComboboxEmpty.tsx`, `ComboboxGroup.tsx`, `ComboboxSeparator.tsx`

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxEmpty.tsx
 */
import React from 'react';
import { useComboboxContext } from './ComboboxRoot';
import styles from './Combobox.module.css';

export function ComboboxEmpty({ children = '未找到匹配结果' }: { children?: React.ReactNode }) {
  const ctx = useComboboxContext();
  if (ctx.filteredItems.length > 0) return null;
  return <div className={styles.empty}>{children}</div>;
}
```

---

### 5.6 `ComboboxLegacyAdapter.tsx` & `Combobox.tsx`（存量分流入口）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/ComboboxLegacyAdapter.tsx
 */
import React from 'react';
import { ComboboxRoot } from './ComboboxRoot';
import { ComboboxInput } from './ComboboxInput';
import { ComboboxContent } from './ComboboxContent';
import { ComboboxList } from './ComboboxList';
import { ComboboxItem } from './ComboboxItem';
import { ComboboxEmpty } from './ComboboxEmpty';
import type { LegacyComboboxProps } from '../types';

export function ComboboxLegacyAdapter({
  items = [],
  value,
  onChange,
  placeholder = '搜索或选择...',
  disabled = false,
  size = 'md',
  clearable = false,
}: LegacyComboboxProps) {
  return (
    <ComboboxRoot
      items={items}
      value={value}
      onValueChange={(v) => onChange?.(v as string)}
      size={size}
      disabled={disabled}
      clearable={clearable}
    >
      <ComboboxInput placeholder={placeholder} />
      <ComboboxContent>
        <ComboboxEmpty />
        <ComboboxList>
          {items.map((item) => (
            <ComboboxItem key={item.id} value={item.id} disabled={item.disabled} icon={item.icon}>
              {item.label}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxRoot>
  );
}
```

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/combobox/Combobox.tsx
 */
import React from 'react';
import { ComboboxRoot, type ComboboxRootProps } from './ComboboxRoot';
import { ComboboxLegacyAdapter } from './ComboboxLegacyAdapter';
import type { LegacyComboboxProps } from '../types';

export function Combobox(props: ComboboxRootProps | LegacyComboboxProps) {
  if ('items' in props && Array.isArray(props.items) && !('children' in props && props.children)) {
    return <ComboboxLegacyAdapter {...(props as LegacyComboboxProps)} />;
  }
  return <ComboboxRoot {...(props as ComboboxRootProps)} />;
}
```

---

## 六、共享基础设施与 CSS Modules 样式规范

### 6.1 `internal/SelectIcons.tsx`（上下双箭头与翡翠绿对勾）

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/internal/SelectIcons.tsx
 * 集中管理的微图标库 (RL-03 目标: ≤ 75 行)
 */
import React from 'react';

export function ChevronUpDownIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d="M5.5 6.5L8 4L10.5 6.5M10.5 9.5L8 12L5.5 9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d="M3.5 8.5L6.5 11.5L12.5 4.5"
        stroke="var(--brand, #10b981)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ClearIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

---

### 6.2 `internal/comboboxHighlight.tsx`（无状态高亮算法）

（已在第 3.1 节全量给出，行数 ~40 行）

---

### 6.3 `internal/positionGeometry.ts`（双向几何解算引擎）

```typescript
/**
 * apps/crish-desktop/src/components/ui/Select/internal/positionGeometry.ts
 * 纯数学双向视口避让与 Clamp 引擎 (RL-03 目标: ≤ 120 行)
 */
import { getEffectiveViewport, type ViewportRect } from '../../Menu/position';

export interface PositionComputeOptions {
  triggerRect: DOMRect;
  popupWidth: number;
  popupHeight: number;
  side?: 'bottom' | 'top';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  edgePadding?: number;
  viewport?: ViewportRect;
}

export function computeFloatingPosition(options: PositionComputeOptions): {
  x: number;
  y: number;
  side: 'bottom' | 'top';
  align: 'start' | 'center' | 'end';
  transformOrigin: string;
} {
  const {
    triggerRect,
    popupWidth,
    popupHeight,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    edgePadding = 8,
  } = options;

  const vp = getEffectiveViewport(options.viewport);
  const offsetTop = vp.offsetTop ?? 0;
  const offsetLeft = vp.offsetLeft ?? 0;

  // 1. 垂直空间评估与 Flip Y
  const spaceBelow = vp.height - (triggerRect.bottom - offsetTop) - sideOffset - edgePadding;
  const spaceAbove = triggerRect.top - offsetTop - sideOffset - edgePadding;

  let actualSide: 'bottom' | 'top' = side;
  let targetY = 0;

  if (side === 'bottom') {
    if (popupHeight > spaceBelow && spaceAbove > spaceBelow) {
      actualSide = 'top';
      targetY = triggerRect.top - popupHeight - sideOffset;
    } else {
      targetY = triggerRect.bottom + sideOffset;
    }
  } else {
    if (popupHeight > spaceAbove && spaceBelow > spaceAbove) {
      actualSide = 'bottom';
      targetY = triggerRect.bottom + sideOffset;
    } else {
      targetY = triggerRect.top - popupHeight - sideOffset;
    }
  }

  // 2. 水平空间评估与 Flip X
  const spaceRight = vp.width - (triggerRect.left - offsetLeft) - edgePadding;
  const spaceLeft = triggerRect.right - offsetLeft - edgePadding;

  let actualAlign = align;
  if (align === 'start' && popupWidth > spaceRight && spaceLeft > spaceRight) {
    actualAlign = 'end';
  } else if (align === 'end' && popupWidth > spaceLeft && spaceRight > spaceLeft) {
    actualAlign = 'start';
  }

  let targetX = triggerRect.left;
  if (actualAlign === 'end') {
    targetX = triggerRect.right - popupWidth;
  } else if (actualAlign === 'center') {
    targetX = triggerRect.left + (triggerRect.width - popupWidth) / 2;
  }

  // 3. 刚性双向数学钳位
  const minX = offsetLeft + edgePadding;
  const maxX = offsetLeft + vp.width - popupWidth - edgePadding;
  const clampedX = Math.min(Math.max(minX, targetX), Math.max(minX, maxX));

  const minY = offsetTop + edgePadding;
  const maxY = offsetTop + vp.height - popupHeight - edgePadding;
  const clampedY = Math.min(Math.max(minY, targetY), Math.max(minY, maxY));

  // 4. transformOrigin 联动
  const originY = actualSide === 'top' ? 'bottom' : 'top';
  const originX = actualAlign === 'end' ? 'right' : actualAlign === 'center' ? 'center' : 'left';

  return {
    x: clampedX,
    y: clampedY,
    side: actualSide,
    align: actualAlign,
    transformOrigin: `${originY} ${originX}`,
  };
}
```

---

### 6.4 `useFloatingPosition.ts`（浮层调度与生命周期 Hook）

```typescript
/**
 * apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts
 * 浮层调度与生命周期 Hook (RL-03 目标: ≤ 180 行)
 */
import { useState, useLayoutEffect, useEffect, useCallback, useRef, useId } from 'react';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import type { LayerType, DismissReason } from '../internal/layer-stack/layerStackTypes';
import { computeFloatingPosition } from './internal/positionGeometry';

export interface UseFloatingPositionOptions {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  side?: 'bottom' | 'top';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  edgePadding?: number;
  onDismiss?: (reason: DismissReason) => void;
  layerId?: string;
  layerType?: LayerType;
}

export function useFloatingPosition(options: UseFloatingPositionOptions) {
  const {
    open,
    triggerRef,
    contentRef,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    edgePadding = 8,
    onDismiss,
    layerId,
    layerType = 'dropdown-menu',
  } = options;

  const autoId = useId();
  const resolvedLayerId = layerId ?? `floating-layer-${autoId}`;

  const [position, setPosition] = useState({
    x: 0,
    y: 0,
    side,
    align,
    transformOrigin: 'top left',
    anchorWidth: 0,
    isPositioned: false,
  });

  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const contentEl = contentRef.current;
    if (!triggerEl || !contentEl) return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const anchorWidth = triggerRect.width;

    contentEl.style.setProperty('--anchor-width', `${anchorWidth}px`);

    const measuredWidth = contentEl.offsetWidth > 0 ? contentEl.offsetWidth : Math.max(anchorWidth, 160);
    const measuredHeight = contentEl.offsetHeight > 0 ? contentEl.offsetHeight : 200;

    const placement = computeFloatingPosition({
      triggerRect,
      popupWidth: measuredWidth,
      popupHeight: measuredHeight,
      side,
      align,
      sideOffset,
      edgePadding,
    });

    setPosition({
      ...placement,
      anchorWidth,
      isPositioned: true,
    });
  }, [triggerRef, contentRef, side, align, sideOffset, edgePadding]);

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
    } else {
      setPosition((prev) => (prev.isPositioned ? { ...prev, isPositioned: false } : prev));
    }
  }, [open, updatePosition]);

  // 全局滚动 RAF 节流 + 浮层内部滚动隔离
  useEffect(() => {
    if (!open) return;

    let rafId: number | null = null;
    const throttledUpdate = (e?: Event) => {
      if (
        e &&
        e.type === 'scroll' &&
        contentRef.current &&
        contentRef.current.contains(e.target as Node)
      ) {
        return;
      }
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        updatePosition();
        rafId = null;
      });
    };

    window.addEventListener('resize', throttledUpdate, { passive: true });
    window.addEventListener('scroll', throttledUpdate, { passive: true, capture: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && triggerRef.current) {
      resizeObserver = new ResizeObserver(throttledUpdate);
      resizeObserver.observe(triggerRef.current);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', throttledUpdate);
      window.removeEventListener('scroll', throttledUpdate, true);
      resizeObserver?.disconnect();
    };
  }, [open, updatePosition, triggerRef, contentRef]);

  // LayerStack 注册联动
  useLayerRegistration({
    id: resolvedLayerId,
    type: layerType,
    isOpen: open,
    containerRef: contentRef,
    triggerRef,
    onDismiss: (reason) => onDismissRef.current?.(reason),
  });

  return position;
}
```

---

### 6.5 `SelectTrigger.module.css`（闭合态发丝边框与双箭头）

```css
/* apps/crish-desktop/src/components/ui/Select/select/SelectTrigger.module.css */

.trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  color: var(--text-primary);
  font-family: var(--font-sans);
  cursor: pointer;
  user-select: none;
  outline: none;
  transition:
    border-color var(--duration-fast, 120ms) ease,
    background-color var(--duration-fast, 120ms) ease,
    box-shadow var(--duration-fast, 120ms) ease;
}

.size-sm {
  height: 28px;
  padding: 0 8px;
  font-size: var(--font-size-xs, 12px);
  border-radius: var(--radius-md, 6px);
}

.size-md {
  height: 32px;
  padding: 0 10px;
  font-size: var(--font-size-sm, 13px);
  border-radius: var(--radius-lg, 8px);
}

.size-lg {
  height: 40px;
  padding: 0 14px;
  font-size: var(--font-size-base, 14px);
  border-radius: var(--radius-xl, 10px);
}

.trigger:hover:not(:disabled) {
  background: var(--tint-hover);
  border-color: var(--border-color);
}

.trigger:focus-visible,
.trigger.open {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  border-color: color-mix(in srgb, var(--border-color) 85%, var(--text-primary) 15%);
}

.trigger:disabled {
  opacity: var(--opacity-disabled, 0.45);
  cursor: not-allowed;
}

.triggerLeft {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.triggerRight {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1, 4px);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.placeholder {
  color: var(--text-tertiary);
}

.valueText {
  color: var(--text-primary);
  font-weight: 450;
}

.clearBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full, 9999px);
  color: var(--text-tertiary);
  transition: background-color 100ms ease, color 100ms ease;
}

.clearBtn:hover {
  background: var(--tint-hover);
  color: var(--text-primary);
}

.chevron {
  display: inline-flex;
  align-items: center;
  color: var(--text-tertiary);
}

.legacyWrapper {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
  width: 100%;
}

.legacyLabel {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
  user-select: none;
}

.triggerError {
  border-color: var(--color-error-border, hsl(0 84% 60%)) !important;
}

.legacyErrorText {
  font-size: var(--font-size-xs, 11px);
  color: var(--color-error, hsl(0 84% 60%));
  margin: 0;
}
```

---

### 6.6 `SelectContent.module.css`（展开态大圆角与同心曲率）

```css
/* apps/crish-desktop/src/components/ui/Select/select/SelectContent.module.css */

.content {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  box-shadow: 0 12px 32px -4px rgba(29, 28, 26, 0.12), 0 4px 12px -2px rgba(29, 28, 26, 0.04);
  width: var(--anchor-width, auto);
  min-width: 160px;
  outline: none;
  overflow: hidden;
}

.size-sm {
  border-radius: 12px;
  padding: 4px;
}

.size-md {
  border-radius: 14px;
  padding: 6px;
}

.size-lg {
  border-radius: 16px;
  padding: 8px;
}

.positioned {
  animation: popupEnter 180ms cubic-bezier(0.175, 0.885, 0.32, 1.25) forwards;
}

.unpositioned {
  opacity: 0;
  pointer-events: none;
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

.scrollViewport {
  max-height: 280px;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 同心圆角选项行 */
.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  box-sizing: border-box;
  border-radius: 8px; /* 数学同心方程解: 14px - 6px = 8px */
  cursor: pointer;
  user-select: none;
  color: var(--text-primary);
  transition: background-color 80ms ease, color 80ms ease;
}

.itemSize-sm {
  min-height: 26px;
  padding: 4px 8px;
  font-size: 12px;
}

.itemSize-md {
  min-height: 30px;
  padding: 6px 10px;
  font-size: 13px;
}

.itemSize-lg {
  min-height: 36px;
  padding: 8px 12px;
  font-size: 14px;
}

.item:hover:not(.disabled) {
  background: var(--tint-hover);
}

.item.selected {
  background: var(--tint-active);
  font-weight: 500;
}

.item.disabled {
  opacity: var(--opacity-disabled, 0.45);
  cursor: not-allowed;
}

.itemMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.itemIcon {
  display: inline-flex;
  align-items: center;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.itemTextCol {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.35;
  min-width: 0;
}

.itemLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.itemHint {
  font-size: var(--font-size-xs, 11px);
  color: var(--text-tertiary);
  line-height: 1.2;
}

.itemRight {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.itemShortcut {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.checkWrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--brand, #10b981);
}

.groupLabel {
  padding: 6px 10px 2px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
  user-select: none;
}

.separator {
  height: 1px;
  background: var(--border-subtle, hsl(35 8% 91%));
  margin: 4px 0;
}

@media (prefers-reduced-motion: reduce) {
  .content {
    animation: none !important;
  }
}
```

---

### 6.7 `Combobox.module.css`（输入框、Chips 胶囊与高亮文本）

```css
/* apps/crish-desktop/src/components/ui/Select/combobox/Combobox.module.css */

.inputWrap {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.size-sm {
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-md, 6px);
}

.size-md {
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-lg, 8px);
}

.size-lg {
  height: 40px;
  padding: 0 14px;
  border-radius: var(--radius-xl, 10px);
}

.inputWrap:focus-within,
.inputWrap.open {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  border-color: color-mix(in srgb, var(--border-color) 85%, var(--text-primary) 15%);
}

.nativeInput {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--text-primary);
}

.chipsContainer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 3px 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg, 8px);
  background: var(--bg-card);
  box-sizing: border-box;
  cursor: text;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.chipsContainer:focus-within,
.chipsContainer.open {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--tint-hover);
  color: var(--text-primary);
  font-size: 12px;
  user-select: none;
}

.chipRemoveBtn {
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  color: var(--text-tertiary);
}

.chipRemoveBtn:hover {
  color: var(--text-primary);
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

.highlightText {
  color: var(--brand-deep, hsl(160 84% 30%));
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.comboboxPopup {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  border-radius: 14px;
  padding: 6px;
  box-shadow: 0 12px 32px -4px rgba(29, 28, 26, 0.12), 0 4px 12px -2px rgba(29, 28, 26, 0.04);
  width: var(--anchor-width, auto);
  min-width: 160px;
  outline: none;
  overflow: hidden;
}

.empty {
  padding: 16px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}
```

---

## 七、全仓旧式 Select / 生硬小方框清退与迁移实施步骤

### 7.1 全仓存量 Select / 原生 `<select>` 排查清单

通过在全仓扫描，梳理出如下需重点验收与迁移的页面模块：

1. **设置面板（Settings Tabs）**：
   - `SettingsGeneralTab.tsx`（语言选择、主题选择、密度选择）；
   - `SettingsRulesTab.tsx`（规则类别与触发条件选择）；
   - `SettingsBrowserTab.tsx`（浏览器配置文件选择、导入源切换）；
   - `SettingsShortcutsTab.tsx`（快捷键动作绑定选择）；
2. **状态与诊断面板（Status / Diagnostics）**：
   - `StatusDiagnosticsPanel.tsx`（日志级别、过滤源下拉）；
   - `ScheduledTasksPanel.tsx`（定时周期选择）；
3. **主工作台与会话栏（Workspace / Session）**：
   - 权限切换菜单（`PermissionModeMenu.tsx`）；
   - 模型选择器（`ModelSelector.tsx`）；
   - 工具与技能选择器（`SkillPicker.tsx`）。

---

### 7.2 迁移改造模式与代码转换示例

#### 模式 A：配置式 Props 用法（无感平滑迁移）
```tsx
// 改造前与改造后 API 签名 100% 一致：
<Select
  value={selectedModel}
  onChange={setSelectedModel}
  options={MODEL_OPTIONS}
  size="md"
  clearable
/>
```

#### 模式 B：复合组件升级模式（支持分组与多行富文本）
```tsx
<Select value={permMode} onValueChange={setPermMode} size="md">
  <SelectTrigger>
    <SelectValue placeholder="选择权限级别" />
  </SelectTrigger>
  <SelectContent>
    <SelectGroup label="预置模式">
      <SelectItem
        value="full"
        icon={<ShieldCheck size={14} />}
        hint="自动放行所有终端命令与文件改动"
      >
        完全访问
      </SelectItem>
      <SelectItem
        value="ask"
        icon={<ShieldAlert size={14} />}
        hint="改文件、推送前弹出确认弹窗"
      >
        需确认
      </SelectItem>
    </SelectGroup>
  </SelectContent>
</Select>
```

---

## 八、单元测试与反回归验证矩阵

### 8.1 Select 单元测试用例规格 (`Select.test.tsx`)

| 用例 ID | 测试目标 | 验证逻辑与断言 |
|---|---|---|
| `SELECT-01` | **LegacyAdapter 渲染** | 传入 `options` 数组，断言正确渲染 `<button role="combobox">` 与子选项 |
| `SELECT-02` | **开闭状态机** | 点击 Trigger，断言浮层挂载并带有 `role="listbox"`；再次点击关闭 |
| `SELECT-03` | **单选选值与关闭** | 点击某一选项，断言 `onValueChange` 被触发且浮层自动解散，焦点归还 Trigger |
| `SELECT-04` | **Programmatic 驱逐** | 模拟 LayerStack 触发 `dismissLayer(id, 'programmatic')`，断言 Select 立即响应关闭 |
| `SELECT-05` | **isPositioned 首帧门闩** | 断言挂载瞬间浮层具备 `visibility: hidden`，测量完毕后变为 `visible` |
| `SELECT-06` | **A11y 规范合规** | 验证 Trigger `<button>` 内无嵌套 `<button>` 或 `<span role="button">` |
| `SELECT-07` | **键盘清空** | 在聚焦 Trigger 且有值时按 `Backspace`，断言 `onValueChange(null)` 被触发 |

---

### 8.2 Combobox 单元测试用例规格 (`Combobox.test.tsx`)

| 用例 ID | 测试目标 | 验证逻辑与断言 |
|---|---|---|
| `COMBO-01` | **关键词搜索过滤** | 在输入框中输入 `"sonnet"`，断言列表中仅展示匹配项，且高亮 Span 正确包裹 `"sonnet"` |
| `COMBO-02` | **正则 lastIndex 无状态** | 针对包含多个重复子串的文本进行高亮渲染，断言所有匹配段均被赋予高亮类名 |
| `COMBO-03` | **50ms IME 合成锁** | 模拟拼音输入法的 `compositionstart` -> `compositionend` -> `keydown(Enter)`，断言回车未误选选项 |
| `COMBO-04` | **多选 Chips 倒格删除** | 多选选中 2 项，在输入框为空时按 `Backspace`，断言高亮最后一项，再次按删除并焦点驻留 |
| `COMBO-05` | **删除按钮 tabIndex=-1** | 检查 `ComboboxChip` 内微型删除按钮，断言 `tabIndex === -1` |

---

## 九、实施路线图与验收质量门禁

### 9.1 4 步精细化落地路线图

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ 步骤 1：基础设施与内部纯函数构建 (internal/)                                      │
│ - 编写 SelectIcons.tsx (ChevronUpDown, CheckIcon, ClearIcon)                  │
│ - 编写 comboboxHighlight.tsx (无状态单次正则高亮算法)                             │
│ - 编写 positionGeometry.ts (双向 Flip X/Y + Clamp 算法)                         │
│ - 升级 useFloatingPosition.ts (接入 programmatic 驱逐与 isPositioned 门闩)       │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ 步骤 2：Select 原子复合组件群拆解 (select/)                                      │
│ - 编写 SelectRoot, SelectTrigger, SelectValue, SelectContent, SelectItem 等   │
│ - 编写 SelectTrigger.module.css 与 SelectContent.module.css                   │
│ - 编写 SelectLegacyAdapter 存量兼容层                                          │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ 步骤 3：Combobox 原子复合组件群拆解 (combobox/)                                  │
│ - 编写 ComboboxRoot, ComboboxInput, ComboboxChips, ComboboxContent 等          │
│ - 编写 Combobox.module.css                                                     │
│ - 接入 50ms IME 合成锁与 Backspace 闭包纠偏                                      │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ 步骤 4：全仓回归测试与门禁验证                                                  │
│ - 运行 vitest run apps/crish-desktop/src/components/ui/Select/                  │
│ - 运行 npm run typecheck 确保 0 类型错误                                        │
│ - 逐一核验 RL-03 单文件代码行数（全部 ≤ 190 行）                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

### 9.2 验收门禁检查清单（Checklist）

- [ ] **视觉质感 100% 对标图 2/3**：Trigger（8px/10px 柔和圆角 + 发丝边框 + `ChevronUpDown` 双箭头）；Popup（14px/16px 大圆角 + 6px 均等 Padding + 深空阴影）；Item（8px 同心圆角 + 翡翠绿对勾 + 3.5% 中性 Hover）。
- [ ] **彻底清退生硬小方框**：全仓旧式原生 `<select>` 与生硬直角方框全部替换为现代 Select / Combobox。
- [ ] **RL-03 行数红线 100% 达标**：原 1081 行与 1340 行大文件彻底解耦，每个拆分后的子文件有效行数均 $\le 190$ 行。
- [ ] **零外部 npm 组件库引入**：保持纯原生 React 18+ 与 CSS Modules。
- [ ] **全量 Bug 根治**：
  - [ ] `highlightMatches` 无 `g` 正则副作用；
  - [ ] 50ms 中文输入法合成锁无误触；
  - [ ] LayerStack `programmatic` 驱逐无遗漏；
  - [ ] 首帧 (0,0) 闪烁门闩无跳跃；
  - [ ] `<button>` 内无违规嵌套交互元素；
  - [ ] 单选模式 Display Label 与 Transient Query 彻底解耦；
  - [ ] 多行选项高度自适应，文字重叠破裂彻底根除。
- [ ] **自动化测试全绿**：`Select.test.tsx` 与 `Combobox.test.tsx` 100% 绿灯通过。
