# Conex / Crish — 全仓 Design Tokens 墨阶合规与 RL-03 单文件行数治理方案

> **方案版本**：v1.0 (Production Master Engineering & Architecture Plan)  
> **产出文件**：`docs/ui-component-modernization/plan-improvements/05-全仓DesignTokens合规与RL-03单文件行数治理方案.md`  
> **前置输入**：
> - `docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md`
> - `docs/ui-component-modernization/audits/01-Switch与Tabs物理动效及同心几何严苛审查.md`
> - `docs/ui-component-modernization/audits/02-Select与Combobox浮层解算及无障碍严苛审查.md`
> - `docs/ui-component-modernization/audits/03-PreviewCard贝塞尔小三角与SafeAim严苛审查.md`
> - `docs/ui-component-modernization/audits/04-Toast3D层叠展开与手势状态机严苛审查.md`
>
> **权威基准**：`AGENTS.md` §11 (CI治理/RL-03 行数红线)、§13 (输入框与焦点态)、§14 (现代CSS色彩空间)、`apps/crish-desktop/src/styles/tokens.css`、`ANTI_OVERENGINEERING_GUARDRAILS.md`  
> **核心使命**：
> 1. **Design Tokens 与 Zero-Blue 墨阶清零**：全面清剿全仓 5 大现代化原子组件（Switch, Tabs/SegmentedControl, Select/Combobox, PreviewCard/Tooltip, ToastStack）中散落的 26+ 处硬编码 HEX、内联 HEX fallback、旧式 `rgba(...)`，统一收敛至项目权威 Design Tokens；
> 2. **焦点环与交互态标准化**：严格落地 AGENTS.md §13（3%~10% 柔和混色焦点环，全量清退粗黑硬线）与 Hover/Active 统一收敛至 `var(--tint-hover)` / `var(--tint-active)`；
> 3. **RL-03 单文件行数治理与原子解耦**：彻底终结 `Select.tsx` (1081行)、`Combobox.tsx` (1340行)、`PreviewCard.tsx` (767行) 等上帝组件，建立模块化拓扑结构，确保拆分后**每个子文件有效代码行严格控制在 200 行以内**；
> 4. **CI 门禁与工程防护闭环**：确立行数预算自动化断言指令、反过度设计准则与零外部依赖（Zero-Dependency）铁律。

---

## 目录

- [一、总体治理目标与架构基线](#一总体治理目标与架构基线)
  - [1.1 治理背景与核心痛点](#11-治理背景与核心痛点)
  - [1.2 权威基准与工程铁律](#12-权威基准与工程铁律)
  - [1.3 核心指标与治理成效预期对照](#13-核心指标与治理成效预期对照)
- [二、全仓 Design Tokens 与 Zero-Blue 墨阶清剿方案](#二全仓-design-tokens-与-zero-blue-墨阶清剿方案)
  - [2.1 全仓 5 大组件硬编码颜色清零清单](#21-全仓-5-大组件硬编码颜色清零清单)
  - [2.2 Zero-Blue 暖灰墨阶与纯白卡底规范](#22-zero-blue-暖灰墨阶与纯白卡底规范)
  - [2.3 AGENTS.md §13 焦点环规范落地方案](#23-agentsmd-13-焦点环规范落地方案)
  - [2.4 Hover / Active 交互态灰度归一化规范](#24-hover--active-交互态灰度归一化规范)
  - [2.5 现代色彩空间与旧式 `rgba()` 清理方案](#25-现代色彩空间与旧式-rgba-清理方案)
- [三、RL-03 单文件行数治理与原子化拆分蓝图](#三rl-03-单文件行数治理与原子化拆分蓝图)
  - [3.1 `ui/Select/` 模块化拓扑拆解方案](#31-uiselect-模块化拓扑拆解方案)
  - [3.2 `ui/Select/Combobox` 模块化拓扑拆解方案](#32-uiselectcombobox-模块化拓扑拆解方案)
  - [3.3 `ui/PreviewCard/` 模块化拓扑拆解方案](#33-uipreviewcard-模块化拓扑拆解方案)
  - [3.4 CSS Modules 样式单文件拆解与边界解耦](#34-css-modules-样式单文件拆解与边界解耦)
  - [3.5 拆分后全组件行数预算表与物理分布](#35-拆分后全组件行数预算表与物理分布)
- [四、核心模块重构代码实现蓝图](#四核心模块重构代码实现蓝图)
  - [4.1 Select 拆分后各子模块架构与核心代码](#41-select-拆分后各子模块架构与核心代码)
  - [4.2 Combobox 拆分后各子模块架构与核心代码](#42-combobox-拆分后各子模块架构与核心代码)
  - [4.3 PreviewCard 拆分后各子模块架构与核心代码](#43-previewcard-拆分后各子模块架构与核心代码)
  - [4.4 Toast 样式清洗与 Token 标准化对照代码](#44-toast-样式清洗与-token-标准化对照代码)
- [五、CI 门禁断言与反过度设计审查规范](#五ci-门禁断言与反过度设计审查规范)
  - [5.1 RL-03 行数自动化断言机制与基线更新指令](#51-rl-03-行数自动化断言机制与基线更新指令)
  - [5.2 状态爆炸与单一职责门禁（no-multi-comp & useState ≤ 12）](#52-状态爆炸与单一职责门禁no-multi-comp--usestate--12)
  - [5.3 反过度设计防御准则与负面清单](#53-反过度设计防御准则与负面清单)
  - [5.4 Zero-Dependency 外部依赖零引入红线审查](#54-zero-dependency-外部依赖零引入红线审查)
- [六、分步实施计划与验证路径](#六分步实施计划与验证路径)
  - [6.1 4 阶段精细化实施路线图](#61-4-阶段精细化实施路线图)
  - [6.2 质量验收门禁清单](#62-质量验收门禁清单)

---

# 一、总体治理目标与架构基线

## 1.1 治理背景与核心痛点

在 01~04 轮的现代化原子组件重构中，项目成功实现了纯原生 100% 自研的高水准物理动效、手势状态机与几何解算中枢。然而，在 05 轮全仓严苛审查中，暴露出了两类阻碍长期维护与工程标准化的严重结构性断层：

1. **Design Tokens 穿透与色彩硬编码漂移**：
   - `ToastStackModern.module.css` 散落 26 处硬编码 HEX 颜色（如 `#111111`, `#000`, `#dc2626`, `#86efac`, `#059669`, `#c2410c`, `#10b981`, `#555555`, `#ffffff`, `#696969`）；
   - `ToastCard.tsx` 内联 `style={{ color: 'var(--text-success-strong, #059669)' }}` 硬编码 fallback；
   - `Switch`, `Tabs`, `SegmentedControl`, `Select`, `PreviewCard` 等组件样式散落 16 处 `#ffffff` / `#111111` 回退值以及旧式 `rgba(...)` 语法；
   - 部分组件焦点环与 Hover 混色违背了 `AGENTS.md` §13 与 `var(--tint-hover)` 归一化铁律。
2. **RL-03 单文件行数红线严重击穿（上帝组件）**：
   - `Combobox.tsx` 单文件达 **1340 行**（超标 168%），塞入 15 个子组件与高亮算法；
   - `Select.tsx` 单文件达 **1081 行**（超标 116%），11 个复合子组件堆叠；
   - `PreviewCard.tsx` 单文件达 **767 行**（超标 53%），几何算法与视图混放；
   - `Select.module.css` 单文件达 **519 行**，未按复合组件边界拆解。

## 1.2 权威基准与工程铁律

本方案严格遵守以下工程规范：

- **AGENTS.md §11**：按类型分级行数门禁（UI Components ≤ 500 行，单文件多组件拦截）；
- **本方案特设极致门禁（RL-03 深度治理）**：拆分后所有单一子文件有效代码行严格控制在 **≤ 200 行**（单组件单职责）；
- **AGENTS.md §13**：克制柔和的输入框与焦点环（3%~10% 混入，严禁粗黑实线）；
- **AGENTS.md §14**：现代色彩空间（优先 HSLA / `hsl(h s l / a)` 与 `color-mix`，清退 `rgba(r, g, b, a)`）；
- **Zero-Blue 墨阶**：纯白卡底 `hsl(0 0% 100%)` / `var(--bg-card)`，次级底板 3.5%~5.5% 暖灰 `hsl(35 8% 94.5%)` / `var(--bg-primary)`，侧边栏 `hsl(35 8% 92.1%)` / `var(--bg-secondary)`，严禁冷蓝偏色；
- **Zero-Dependency 纯净自研**：绝对禁止引入第三方组件库。

## 1.3 核心指标与治理成效预期对照

| 治理维度 | 治理前现状 | 治理后权威标准 | 改善效果 |
| :--- | :--- | :--- | :--- |
| **硬编码 HEX / Fallback** | 42+ 处硬编码 HEX（ToastStack 26 处、内联 5 处等） | **0 处硬编码 HEX**，100% 收敛至权威 Tokens | 主题变体与深色模式 100% 无缝自适应 |
| **旧式 `rgba(...)`** | 10+ 处散落 | 全量清洗为 `hsl(... / a)` 与 `color-mix(in srgb, ...)` | 严格满足 AGENTS.md §14 现代 CSS 标准 |
| **焦点环规范** | 部分组件粗黑框或缺乏柔和混色 | 严格采用 §13 标准：`0 0 0 2px var(--focus-ring-color)`（3%~10% 柔和混色） | 长时间阅读无视觉刺眼感 |
| **Hover / Active 灰度** | 存在自定义 8% 混色与不一致灰度 | 统一收敛至 `var(--tint-hover)` (3.5%) 与 `var(--tint-active)` (6.5%) | 全仓视觉交互反馈 100% 连贯 |
| **Select 架构行数** | 1 个文件，1081 行（超标 116%） | 6 个子文件，**每个子文件 ≤ 200 行** | 彻底解耦，单一职责，单测精准覆盖 |
| **Combobox 架构行数** | 1 个文件，1340 行（超标 168%） | 7 个子文件，**每个子文件 ≤ 200 行** | 搜索、Chips、IME 状态机物理隔离 |
| **PreviewCard 架构行数** | 1 个文件，767 行（超标 53%） | 5 个子文件，**每个子文件 ≤ 200 行** | 几何计算引擎与 React 视图层完全解耦 |
| **CSS Modules 行数** | `Select.module.css` 519 行 | 按组件边界拆解为 Trigger / Content 独立模块（均 ≤ 220 行） | 样式作用域精准隔离 |

---

# 二、全仓 Design Tokens 与 Zero-Blue 墨阶清剿方案

## 2.1 全仓 5 大组件硬编码颜色清零清单

全仓 5 大现代化组件必须坚决清除所有硬编码颜色，严格执行以下映射规则：

### 1. `ToastStackModern.module.css` 26 处硬编码 HEX 清剿表

| 现存代码行号 | 现存硬编码内容 | 语义角色 | 权威 Design Token 替换标准 |
| :--- | :--- | :--- | :--- |
| **77, 312, 318, 364, 375, 386, 405** | `#111111` | 主文本/操作文字 | `var(--text-primary)` |
| **86, 87, 123, 140, 141, 150** | `#000` | 阴影基底色 | `var(--shadow-color, hsl(0 0% 0%))` |
| **253, 257, 380** | `#dc2626` | 错误边框/进度条/按钮 | `var(--color-error-border)`, `var(--text-danger)` |
| **262** | `#86efac` | 成功状态边框 | `var(--color-success-border, var(--accent-green-muted))` |
| **266, 344** | `#059669` | 成功进度条/撤销链接 | `var(--text-success-strong)`, `var(--brand-deep)` |
| **271, 275** | `#c2410c` | 警告边框/进度条 | `var(--color-warning-border)`, `var(--text-warning-strong)` |
| **280** | `#10b981` | Loading 进度条 | `var(--brand)` |
| **325** | `#555555` | 次级描述文字 | `var(--text-secondary)` |
| **365, 381** | `#ffffff` | 卡片底色/按钮文字 | `var(--bg-card, hsl(0 0% 100%))` / `var(--text-on-danger, hsl(0 0% 100%))` |
| **397** | `#696969` | 关闭按钮弱化图标 | `var(--text-tertiary)` |

### 2. `ToastCard.tsx` 内联样式 HEX Fallback 清剿表

| 现存代码行号 | 现存内联代码 | 缺陷 | 治理方案 |
| :--- | :--- | :--- | :--- |
| **120** | `style={{ color: 'var(--text-success-strong, #059669)' }}` | 内联硬编码 HEX | 移除内联 style，改用 CSS 类 `.icon[data-type="success"]` |
| **129** | `style={{ color: 'var(--text-danger, #dc2626)' }}` | 内联硬编码 HEX | 移除内联 style，改用 CSS 类 `.icon[data-type="error"]` |
| **138** | `style={{ color: 'var(--text-warning-strong, #c2410c)' }}` | 内联硬编码 HEX | 移除内联 style，改用 CSS 类 `.icon[data-type="warning"]` |
| **148** | `style={{ color: 'var(--brand, #10b981)' }}` | 内联硬编码 HEX | 移除内联 style，改用 CSS 类 `.icon[data-type="loading"]` |
| **157** | `style={{ color: 'var(--text-secondary, #555555)' }}` | 内联硬编码 HEX | 移除内联 style，改用 CSS 类 `.icon[data-type="info"]` |

### 3. 多组件 CSS Modules 中的硬编码回退值清单

| 组件与文件 | 缺陷位置 | 现存代码 | 标准清洗代码 |
| :--- | :--- | :--- | :--- |
| **Switch** | `Switch.module.css:136` | `background: var(--bg-elevated, #ffffff);` | `background: var(--bg-elevated, hsl(0 0% 100%));` |
| **Switch** | `Switch.module.css:226` | `color: var(--text-tertiary, #888888);` | `color: var(--text-tertiary);` |
| **Tabs** | `Tabs.module.css:132` | `background-color: var(--bg-card, #ffffff);` | `background-color: var(--bg-card, hsl(0 0% 100%));` |
| **SegmentedControl** | `SegmentedControl.module.css:84` | `background-color: var(--bg-card, #ffffff);` | `background-color: var(--bg-card, hsl(0 0% 100%));` |
| **Combobox** | `Combobox.module.css:22, 40, 102` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card, hsl(0 0% 100%));` |
| **Select** | `Select.module.css:32, 52, 70, 192, 236` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card, hsl(0 0% 100%));` |
| **PreviewCard** | `PreviewCard.module.css:17, 126, 133` | `#111111`, `#555555` | `var(--text-primary)`, `var(--text-secondary)` |

---

## 2.2 Zero-Blue 暖灰墨阶与纯白卡底规范

为彻底杜绝冷蓝、偏紫等杂色污染，全仓组件背景底板与卡片层级严格遵守以下墨阶梯队：

```
[外层大底板 Shell]   var(--bg-primary)   -> hsl(35 8% 94.5%)  (5.5% 暖灰底板)
        ↓
[侧边栏/容器槽底]   var(--bg-secondary) -> hsl(35 8% 92.1%)  (7.9% 暖灰底板)
        ↓
[悬浮层/二级深槽]   var(--bg-tertiary)  -> hsl(35 8% 89.7%)  (10.3% 暖灰底板)
        ↓
[交互叶子卡片/浮层] var(--bg-card)      -> hsl(0 0% 100%)    (100% 纯白卡底)
[浮起弹窗/Toast]    var(--bg-elevated)  -> hsl(0 0% 100%)    (100% 纯白卡底)
```

**铁律断言**：
1. `Select` 浮层、`Combobox` 浮层、`PreviewCard` 浮层、`ToastCard` 卡片本体背景必须统一声明为 `background-color: var(--bg-card, hsl(0 0% 100%))` 或 `var(--bg-elevated, hsl(0 0% 100%))`；
2. 严禁在 Light 主题下使用带蓝相的灰色（如 `hsl(210 ...)` 或 `#f1f5f9` 等 Tailwind 冷灰）。

---

## 2.3 AGENTS.md §13 焦点环规范落地方案

根据 `AGENTS.md` §13，焦点态禁止使用粗、深、实心黑线，必须采用基于文本色与边框色 3%~10% 的柔和混色。

### 1. 标准焦点环 CSS 规范

```css
/* 标准全局焦点环 (Focus Visible) */
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

/* 权威 Token 映射 (tokens.css) */
--focus-ring-color: color-mix(in srgb, var(--control-mix-color, var(--text-primary)) 8%, transparent);
--focus-ring: 0 0 0 2px var(--focus-ring-color);

/* 微调档位：输入框聚焦激活态 */
.inputContainer:focus-within,
.trigger[data-state='open'],
.trigger:focus-visible {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-primary) 6%, transparent);
}
```

### 2. 负面清单（绝对禁止）
- ❌ `outline: 2px solid black;`
- ❌ `box-shadow: 0 0 0 2px #000000;`
- ❌ `box-shadow: 0 0 0 2px var(--text-primary);`（未经 `color-mix` 稀释的纯黑实线）

---

## 2.4 Hover / Active 交互态灰度归一化规范

全仓所有组件的鼠标悬停（Hover）与按压（Active）必须严格统一收敛至项目权威半透明蒙层 Tokens，杜绝各组件私自发明混色：

```css
/* 统一悬停态规范 */
.element:hover:not(:disabled) {
  background-color: var(--tint-hover); /* color-mix(in srgb, var(--text-primary) 3.5%, transparent) */
}

/* 统一按压激活态规范 */
.element:active:not(:disabled) {
  background-color: var(--tint-active); /* color-mix(in srgb, var(--text-primary) 6.5%, transparent) */
}
```

**整改项**：
- 清理 `Switch.module.css:99` 的 `.track:hover:not(:disabled)`，将其自创的 `8%` 文本混色彻底清洗为标准的 `var(--tint-hover)` 叠加。

---

## 2.5 现代色彩空间与旧式 `rgba()` 清理方案

根据 `AGENTS.md` §14，严禁散落旧式 `rgba(r, g, b, a)` 语法，全量重构为现代 CSS 规范：

```css
/* ❌ 旧式语法（违规） */
box-shadow: 0 16px 36px -4px rgba(0, 0, 0, 0.2);
background: var(--border-subtle, rgba(0, 0, 0, 0.06));
box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);

/* 🟢 现代规范语法（合规） */
box-shadow: var(--shadow-2xl, 0 16px 36px -4px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 20%, transparent));
background: var(--border-subtle, hsl(0 0% 0% / 0.06));
box-shadow: 0 1px 2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 5%, transparent);
```

---

# 三、RL-03 单文件行数治理与原子化拆分蓝图

## 3.1 `ui/Select/` 模块化拓扑拆解方案

现存 `Select.tsx` (1081行) 拆解为原子化目录拓扑，每个子文件职责专一，行数严格 ≤ 200 行：

```
apps/crish-desktop/src/components/ui/Select/
├── types.ts                   (契约定义：Props, Context, Option 接口, ≤ 120 行)
├── SelectContext.ts           (状态中枢：Context 实例与 useSelectContext Hook, ≤ 60 行)
├── selectUtils.ts             (静态分析：extractItemsFromChildren 辅助函数, ≤ 60 行)
├── SelectRoot.tsx             (根控制器：状态编排、受控同步、Legacy 分发, ≤ 160 行)
├── SelectTrigger.tsx          (触发器族：SelectTrigger, SelectValue, SelectIcon, ClearButton, ≤ 180 行)
├── SelectContent.tsx          (浮层容器：SelectContent, Portal, LayerStack 接入, ≤ 190 行)
├── SelectItem.tsx             (选项组合：SelectItem, SelectGroup, SelectGroupLabel, SelectSeparator, ≤ 180 行)
├── SelectLegacyAdapter.tsx    (历史兼容：options 属性配置式旧版适配器, ≤ 90 行)
├── useFloatingPosition.ts     (几何计算：现存浮层几何定位引擎, ≤ 260 行)
├── SelectTrigger.module.css   (样式解耦：触发器与值渲染样式, ≤ 180 行)
├── SelectContent.module.css   (样式解耦：浮层与列表项样式, ≤ 220 行)
├── Select.test.tsx            (单元测试集)
└── index.ts                   (统一聚合重导出, ≤ 50 行)
```

---

## 3.2 `ui/Select/Combobox` 模块化拓扑拆解方案

现存 `Combobox.tsx` (1340行) 拆解为 7 个原子文件，行数严格 ≤ 200 行：

```
apps/crish-desktop/src/components/ui/Select/
├── ComboboxContext.ts         (状态中枢：ComboboxContext 实例与 Hook, ≤ 70 行)
├── comboboxHighlight.tsx      (算法工具：highlightMatches 关键词高亮渲染器, ≤ 50 行)
├── ComboboxRoot.tsx           (根控制器：搜索状态机、多选/单选值编排、Legacy 适配分发, ≤ 170 行)
├── ComboboxInput.tsx          (单选搜索：原生 Input、IME 合成锁状态机、清空流, ≤ 160 行)
├── ComboboxChips.tsx          (多选胶囊：ComboboxChips 换行排版、ComboboxChip 倒格删除与左右漫游, ≤ 190 行)
├── ComboboxContent.tsx        (浮层容器：ComboboxContent, ComboboxList, ComboboxEmpty, ≤ 170 行)
├── ComboboxItem.tsx           (列表项族：ComboboxItem, ComboboxGroup, ComboboxLabel, ComboboxSeparator, ≤ 160 行)
├── ComboboxLegacyAdapter.tsx  (历史兼容：旧版 options 配置式适配器, ≤ 85 行)
├── Combobox.module.css        (Chips 与搜索专用样式, ≤ 220 行)
└── Combobox.test.tsx          (单元测试集)
```

---

## 3.3 `ui/PreviewCard/` 模块化拓扑拆解方案

现存 `PreviewCard.tsx` (767行) 拆解为 5 个原子文件，实现几何数学与 React 视图彻底解耦：

```
apps/crish-desktop/src/components/ui/PreviewCard/
├── types.ts                   (类型定义：Props, Context, PositionResult 接口, ≤ 90 行)
├── previewCardPositioning.ts  (纯几何数学：视口碰撞翻折、边缘钳位计算, ≤ 130 行)
├── PreviewCardContext.ts      (状态中枢：Context、定时器单真源调度接口, ≤ 80 行)
├── PreviewCard.tsx            (根控制器：延迟状态机、useAnimatedPresence 编排, ≤ 150 行)
├── PreviewCardTrigger.tsx     (触发器代理：Hover 拦截、Safe-Aim 锥区追踪器接入, ≤ 170 行)
├── PreviewCardContent.tsx     (浮层渲染：Portal 挂载、小三角联动、FocusTrap 选配, ≤ 180 行)
├── PreviewCardSubcomponents.tsx (排版原子：Title, Description, Header, Body, Footer, ≤ 90 行)
├── PreviewCardArrow.tsx       (现存贝塞尔小三角 SVG 组件, ≤ 65 行)
├── PreviewCard.module.css     (卡片与排版样式, ≤ 160 行)
├── PreviewCard.test.tsx       (单元测试集)
└── index.ts                   (统一聚合重导出, ≤ 40 行)
```

---

## 3.4 CSS Modules 样式单文件拆解与边界解耦

对于超过 500 行的 `Select.module.css` (519行)，按复合组件边界解耦为独立模块：

1. **`SelectTrigger.module.css`**（≤ 180 行）：
   - `.trigger`, `.trigger[data-size]`, `.trigger[data-variant]`, `.trigger[data-state='open']`
   - `.value`, `.placeholder`, `.icon`, `.clearButton`
2. **`SelectContent.module.css`**（≤ 220 行）：
   - `.content`, `.list`, `.item`, `.item[data-highlighted]`, `.item[data-selected]`
   - `.group`, `.groupLabel`, `.separator`, `.checkIcon`

---

## 3.5 拆分后全组件行数预算表与物理分布

| 组件拆分后文件路径 | 承担的核心职责 | 预期有效代码行 | 门禁上限 (RL-03) | 合规判定 |
| :--- | :--- | :---: | :---: | :---: |
| `Select/SelectContext.ts` | Context 与 useSelectContext | ~45 行 | ≤ 200 行 | ✅ PASS |
| `Select/selectUtils.ts` | extractItemsFromChildren | ~40 行 | ≤ 200 行 | ✅ PASS |
| `Select/SelectRoot.tsx` | Select 根组件与 Legacy 调度 | ~140 行 | ≤ 200 行 | ✅ PASS |
| `Select/SelectTrigger.tsx` | Trigger, Value, Icon, ClearBtn | ~160 行 | ≤ 200 行 | ✅ PASS |
| `Select/SelectContent.tsx` | Content 浮层容器与 LayerStack | ~150 行 | ≤ 200 行 | ✅ PASS |
| `Select/SelectItem.tsx` | Item, Group, Separator | ~155 行 | ≤ 200 行 | ✅ PASS |
| `Select/SelectLegacyAdapter.tsx` | Legacy 适配器 | ~75 行 | ≤ 200 行 | ✅ PASS |
| `Select/ComboboxContext.ts` | Context 与 useComboboxContext | ~55 行 | ≤ 200 行 | ✅ PASS |
| `Select/comboboxHighlight.tsx`| highlightMatches 高亮算法 | ~35 行 | ≤ 200 行 | ✅ PASS |
| `Select/ComboboxRoot.tsx` | Combobox 根状态编排 | ~150 行 | ≤ 200 行 | ✅ PASS |
| `Select/ComboboxInput.tsx` | 搜索框与 IME 状态机 | ~145 行 | ≤ 200 行 | ✅ PASS |
| `Select/ComboboxChips.tsx` | Chips 多选胶囊排版 | ~175 行 | ≤ 200 行 | ✅ PASS |
| `Select/ComboboxContent.tsx` | 浮层与列表容器 | ~135 行 | ≤ 200 行 | ✅ PASS |
| `Select/ComboboxItem.tsx` | 选项与高亮项渲染 | ~140 行 | ≤ 200 行 | ✅ PASS |
| `Select/ComboboxLegacyAdapter.tsx` | Combobox Legacy 适配器 | ~75 行 | ≤ 200 行 | ✅ PASS |
| `PreviewCard/previewCardPositioning.ts` | 纯几何碰撞与翻折算法 | ~120 行 | ≤ 200 行 | ✅ PASS |
| `PreviewCard/PreviewCardContext.ts` | PreviewCardContext 单真源 | ~60 行 | ≤ 200 行 | ✅ PASS |
| `PreviewCard/PreviewCard.tsx` | Root 状态机与 AnimatedPresence | ~135 行 | ≤ 200 行 | ✅ PASS |
| `PreviewCard/PreviewCardTrigger.tsx` | Trigger 与 Safe-Aim 追踪 | ~165 行 | ≤ 200 行 | ✅ PASS |
| `PreviewCard/PreviewCardContent.tsx` | Content 浮层与 Portal | ~160 行 | ≤ 200 行 | ✅ PASS |
| `PreviewCard/PreviewCardSubcomponents.tsx` | Title, Desc, Header, Footer | ~75 行 | ≤ 200 行 | ✅ PASS |

---

# 四、核心模块重构代码实现蓝图

## 4.1 Select 拆分后各子模块架构与核心代码

### 1. `apps/crish-desktop/src/components/ui/Select/SelectContext.ts`

```typescript
import { createContext, useContext } from 'react';
import type { SelectContextValue } from './types';

export const SelectContext = createContext<SelectContextValue | null>(null);

export function useSelectContext(componentName = 'Select compound component'): SelectContextValue {
  const ctx = useContext(SelectContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within a <Select> root component.`);
  }
  return ctx;
}
```

### 2. `apps/crish-desktop/src/components/ui/Select/selectUtils.ts`

```typescript
import React from 'react';

export function extractItemsFromChildren(
  children: React.ReactNode,
  result: Map<string, { value: string; label: string; disabled?: boolean }> = new Map()
): Map<string, { value: string; label: string; disabled?: boolean }> {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as any;
    if (props && typeof props.value === 'string') {
      const label =
        typeof props.children === 'string'
          ? props.children
          : typeof props.label === 'string'
          ? props.label
          : props.value;
      result.set(props.value, {
        value: props.value,
        label,
        disabled: Boolean(props.disabled),
      });
    }
    if (props && props.children && typeof props.children !== 'string') {
      extractItemsFromChildren(props.children, result);
    }
  });
  return result;
}
```

### 3. `apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx`

```tsx
import React, { forwardRef, useCallback } from 'react';
import { useSelectContext } from './SelectContext';
import type { SelectTriggerProps, SelectValueProps } from './types';
import styles from './SelectTrigger.module.css';

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(function SelectTrigger(
  {
    className,
    children,
    disabled = false,
    clearable = false,
    onClear,
    onClick,
    onKeyDown,
    'aria-label': ariaLabel,
    ...rest
  },
  forwardedRef
) {
  const {
    open,
    setOpen,
    triggerRef,
    triggerId,
    listboxId,
    size,
    variant,
    disabled: rootDisabled,
    currentValue,
    setValue,
  } = useSelectContext('SelectTrigger');

  const isDisabled = disabled || rootDisabled;

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    onClick?.(e);
    if (!e.defaultPrevented) {
      setOpen(!open);
    }
  };

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (isDisabled) return;
      onClear?.();
      setValue('');
    },
    [isDisabled, onClear, setValue]
  );

  return (
    <button
      ref={(node) => {
        (triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      type="button"
      id={triggerId}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-disabled={isDisabled}
      aria-label={ariaLabel}
      disabled={isDisabled}
      data-state={open ? 'open' : 'closed'}
      data-size={size}
      data-variant={variant}
      className={`${styles.trigger} ${className || ''}`}
      onClick={handleClick}
      onKeyDown={onKeyDown}
      {...rest}
    >
      <span className={styles.content}>{children}</span>
      {clearable && currentValue && !isDisabled && (
        <span
          role="button"
          tabIndex={-1}
          aria-label="Clear selection"
          className={styles.clearButton}
          onClick={handleClear}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L6 4.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L7.06 6l2.72 2.72a.75.75 0 1 1-1.06 1.06L6 7.06 3.28 9.78a.75.75 0 0 1-1.06-1.06L4.94 6 2.22 3.28a.75.75 0 0 1 0-1.06z" />
          </svg>
        </span>
      )}
      <span className={styles.icon} aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 4.5L6 7.5L9 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  );
});

export const SelectValue: React.FC<SelectValueProps> = ({ placeholder = 'Select an option...', className }) => {
  const { currentValue, multiple, selectedLabels, registeredItems } = useSelectContext('SelectValue');

  if (multiple && Array.isArray(currentValue)) {
    if (currentValue.length === 0) {
      return <span className={`${styles.placeholder} ${className || ''}`}>{placeholder}</span>;
    }
    return (
      <span className={`${styles.value} ${className || ''}`}>
        {currentValue.map((v) => registeredItems.get(v)?.label || v).join(', ')}
      </span>
    );
  }

  const singleValue = typeof currentValue === 'string' ? currentValue : '';
  const displayLabel = selectedLabels.get(singleValue) || registeredItems.get(singleValue)?.label || singleValue;

  if (!singleValue && singleValue !== '0') {
    return <span className={`${styles.placeholder} ${className || ''}`}>{placeholder}</span>;
  }

  return <span className={`${styles.value} ${className || ''}`}>{displayLabel}</span>;
};
```

### 4. `apps/crish-desktop/src/components/ui/Select/SelectContent.tsx`

```tsx
import React, { forwardRef, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSelectContext } from './SelectContext';
import { useFloatingPosition } from './useFloatingPosition';
import type { SelectContentProps } from './types';
import styles from './SelectContent.module.css';

export const SelectContent = forwardRef<HTMLDivElement, SelectContentProps>(function SelectContent(
  {
    className,
    children,
    side = 'bottom',
    align = 'start',
    sideOffset = 4,
    alignOffset = 0,
    matchTriggerWidth = true,
    ...rest
  },
  forwardedRef
) {
  const {
    open,
    setOpen,
    triggerRef,
    listboxId,
    multiple,
    size,
    highlightedIndex,
    setHighlightedIndex,
    registeredItems,
  } = useSelectContext('SelectContent');

  const contentRef = useRef<HTMLDivElement | null>(null);

  const { position, updatePosition } = useFloatingPosition({
    open,
    triggerRef,
    contentRef,
    side,
    align,
    sideOffset,
    alignOffset,
    matchTriggerWidth,
    layerId: `select-layer-${listboxId}`,
    layerType: 'exclusive-peer',
    onDismiss: (reason) => {
      if (reason !== 'item-select') {
        setOpen(false);
      }
    },
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(registeredItems.values()).filter((i) => !i.disabled);
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 + items.length) % items.length);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      ref={(node) => {
        contentRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      id={listboxId}
      role="listbox"
      tabIndex={-1}
      aria-multiselectable={multiple}
      data-size={size}
      data-slot="select-content"
      className={`${styles.content} ${className || ''}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        visibility: position.isPositioned ? 'visible' : 'hidden',
        pointerEvents: position.isPositioned ? 'auto' : 'none',
        width: matchTriggerWidth && position.anchorWidth ? `${position.anchorWidth}px` : undefined,
      }}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      <div className={styles.list}>{children}</div>
    </div>,
    document.body
  );
});
```

---

## 4.2 Combobox 拆分后各子模块架构与核心代码

### 1. `apps/crish-desktop/src/components/ui/Select/comboboxHighlight.tsx`

```tsx
import React from 'react';

export function highlightMatches(text: string, query: string): React.ReactNode {
  if (!query || !query.trim()) return text;
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  if (parts.length === 1) return text;

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} style={{ backgroundColor: 'transparent', fontWeight: 700, color: 'inherit' }}>
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}
```

### 2. `apps/crish-desktop/src/components/ui/Select/ComboboxInput.tsx`

```tsx
import React, { forwardRef, useRef, useCallback } from 'react';
import { useComboboxContext } from './ComboboxContext';
import type { ComboboxInputProps } from './types';
import styles from './Combobox.module.css';

export const ComboboxInput = forwardRef<HTMLInputElement, ComboboxInputProps>(function ComboboxInput(
  {
    className,
    placeholder = 'Search...',
    disabled = false,
    autoFocus = false,
    clearable = true,
    onKeyDown,
    onChange,
    onFocus,
    ...rest
  },
  forwardedRef
) {
  const {
    open,
    setOpen,
    searchQuery,
    setSearchQuery,
    triggerRef,
    triggerId,
    listboxId,
    size,
    variant,
    disabled: rootDisabled,
    currentValue,
    setValue,
  } = useComboboxContext('ComboboxInput');

  const isDisabled = disabled || rootDisabled;
  const isComposingRef = useRef(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || isComposingRef.current) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const handleCompositionEnd = () => {
    setTimeout(() => {
      isComposingRef.current = false;
    }, 30);
  };

  return (
    <div
      className={`${styles.inputContainer} ${className || ''}`}
      data-size={size}
      data-variant={variant}
      data-state={open ? 'open' : 'closed'}
      data-disabled={isDisabled}
    >
      <input
        ref={(node) => {
          (triggerRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        id={triggerId}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        disabled={isDisabled}
        autoFocus={autoFocus}
        value={searchQuery}
        placeholder={placeholder}
        className={styles.input}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={handleCompositionEnd}
        onChange={(e) => {
          setSearchQuery(e.target.value);
          if (!open) setOpen(true);
          onChange?.(e);
        }}
        onFocus={(e) => {
          if (!isDisabled) setOpen(true);
          onFocus?.(e);
        }}
        onKeyDown={handleKeyDown}
        {...rest}
      />
    </div>
  );
});
```

---

## 4.3 PreviewCard 拆分后各子模块架构与核心代码

### 1. `apps/crish-desktop/src/components/ui/PreviewCard/previewCardPositioning.ts`

```typescript
import type { PreviewCardSide, PreviewCardAlign, PreviewCardPositionResult } from './types';

export const PREVIEW_CARD_EDGE_PAD = 12;

export function computePreviewCardPosition(
  side: PreviewCardSide,
  align: PreviewCardAlign = 'center',
  sideOffset = 10,
  alignOffset = 0,
  rect: DOMRect,
  cardWidth: number,
  cardHeight: number
): PreviewCardPositionResult {
  const vw = typeof window !== 'undefined' ? window.visualViewport?.width || window.innerWidth || 1280 : 1280;
  const vh = typeof window !== 'undefined' ? window.visualViewport?.height || window.innerHeight || 800 : 800;

  let effectiveSide = side;

  if (side === 'top' && rect.top - cardHeight - sideOffset < PREVIEW_CARD_EDGE_PAD) {
    if (vh - rect.bottom - sideOffset - cardHeight >= PREVIEW_CARD_EDGE_PAD) {
      effectiveSide = 'bottom';
    }
  } else if (side === 'bottom' && rect.bottom + sideOffset + cardHeight > vh - PREVIEW_CARD_EDGE_PAD) {
    if (rect.top - sideOffset - cardHeight >= PREVIEW_CARD_EDGE_PAD) {
      effectiveSide = 'top';
    }
  }

  let top = 0;
  let left = 0;

  if (effectiveSide === 'top') {
    top = rect.top - cardHeight - sideOffset;
  } else if (effectiveSide === 'bottom') {
    top = rect.bottom + sideOffset;
  } else if (effectiveSide === 'left') {
    left = rect.left - cardWidth - sideOffset;
  } else if (effectiveSide === 'right') {
    left = rect.right + sideOffset;
  }

  if (effectiveSide === 'top' || effectiveSide === 'bottom') {
    if (align === 'center') {
      left = rect.left + rect.width / 2 - cardWidth / 2 + alignOffset;
    } else if (align === 'start') {
      left = rect.left + alignOffset;
    } else if (align === 'end') {
      left = rect.right - cardWidth + alignOffset;
    }
  }

  const clampedLeft = Math.max(PREVIEW_CARD_EDGE_PAD, Math.min(left, vw - cardWidth - PREVIEW_CARD_EDGE_PAD));
  const clampedTop = Math.max(PREVIEW_CARD_EDGE_PAD, Math.min(top, vh - cardHeight - PREVIEW_CARD_EDGE_PAD));

  const transformOrigin =
    effectiveSide === 'top' ? 'center bottom' : effectiveSide === 'bottom' ? 'center top' : 'center center';

  return {
    top: clampedTop,
    left: clampedLeft,
    side: effectiveSide,
    align,
    transformOrigin,
  };
}
```

---

## 4.4 Toast 样式清洗与 Token 标准化对照代码

### `apps/crish-desktop/src/components/overlay/ToastStackModern.module.css`（清洗后片段）

```css
/* ==========================================================================
   Toast 现代 3D 堆叠通知卡片 — 权威 Design Tokens 纯净化
   ========================================================================== */

.toastCard {
  position: absolute;
  box-sizing: border-box;
  user-select: none;
  pointer-events: auto;

  /* 背景与发丝边框 100% 纯净化 */
  background-color: var(--bg-card, hsl(0 0% 100%));
  color: var(--text-primary);
  border: 1px solid var(--hairline, var(--border-subtle));
  border-radius: var(--radius-lg, 8px);
  padding: 10px 14px;
  font-size: var(--font-size-sm, 13px);
  line-height: var(--line-height-base, 1.4);
  font-family: var(--font-sans);

  /* 物理阴影：杜绝 #000 硬编码，收敛至权威 var(--shadow-color) */
  box-shadow: 0 -4px 16px -2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 6%, transparent),
              0 2px 6px -1px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 4%, transparent);

  transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1),
              opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
              height 0.18s cubic-bezier(0.22, 1, 0.36, 1),
              box-shadow 0.3s ease,
              border-color 0.2s ease;
  will-change: transform, opacity, height;
}

/* 状态色边框与进度条完全标准化 */
.toastCard[data-type='error'] {
  border-color: var(--color-error-border);
}
.toastCard[data-type='error'] .progressBar {
  background: var(--text-danger);
}

.toastCard[data-type='success'] {
  border-color: var(--color-success-border);
}
.toastCard[data-type='success'] .progressBar {
  background: var(--text-success-strong);
}

.toastCard[data-type='warning'] {
  border-color: var(--color-warning-border);
}
.toastCard[data-type='warning'] .progressBar {
  background: var(--text-warning-strong);
}

.toastCard[data-type='loading'] .progressBar {
  background: var(--brand);
}

/* 文字与图标角色收敛 */
.title {
  font-weight: 600;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-primary);
}

.message {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
}

.description {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
}

.closeButton {
  color: var(--text-tertiary);
  transition: color 0.15s ease, background-color 0.15s ease;
}

.closeButton:hover {
  color: var(--text-primary);
  background-color: var(--tint-hover);
}

.closeButton:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
```

---

# 五、CI 门禁断言与反过度设计审查规范

## 5.1 RL-03 行数自动化断言机制与基线更新指令

### 1. 门禁脚本断言逻辑
项目通过 `scripts/check-line-counts.mjs` 执行全自动化行数扫描，门禁断言公式为：

$$\text{EffectiveLines} = \text{RawLines} - \text{CommentLines} - \text{BlankLines}$$

- **UI 组件分类上限**：$\le 500\text{ 行}$；
- **子文件极致标准**：本方案拆分出的单一子文件严格 $\le 200\text{ 行}$；
- **硬阻断线（Hard Block）**：$> 650\text{ 行}$ 直接阻断 CI。

### 2. 自动化验证指令

```powershell
# 1. 针对新拆分组件目录执行行数验证
node scripts/check-line-counts.mjs apps/crish-desktop/src/components/ui/Select apps/crish-desktop/src/components/ui/PreviewCard

# 2. 全仓行数基线全量校验
npm run check:line-counts

# 3. 拆分后刷新基线（自动清除回落文件）
node scripts/check-line-counts.mjs --update --all
```

---

## 5.2 状态爆炸与单一职责门禁（no-multi-comp & useState ≤ 12）

1. **单文件单组件铁律（Single Responsibility）**：每个 `.tsx` 文件原则上只声明并导出一个主要的 React 复合子组件，严禁在一个文件中声明超过 2 个视图级组件；
2. **状态数量约束**：单个组件内部的 `useState` 数量不得超过 **12 个**；若状态关联紧密，必须重构为 `useReducer` 或抽离为专属原子 Hook（如 `useComboboxInput` / `useSelectFloating`）。

---

## 5.3 反过度设计防御准则与负面清单

严格遵守仓库根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md`：

1. **禁止自创复杂观察者中枢**：浮层定位直接基于纯函数几何解算 + `useLayoutEffect` 同步测量，严禁引入复杂的虚拟物理引擎或多层 EventEmitter；
2. **禁止过度记忆（Memo Abuse）**：仅在存在明显渲染性能瓶颈的高频列表项（如 `SelectItem`, `ComboboxItem`）上合理使用 `React.memo`，普通原子包装层严禁无脑包裹；
3. **禁止深层层级嵌套（Wrapper Hell）**：DOM 结构严格扁平化，Trigger 与 Content 内部容器层级控制在 3 层以内。

---

## 5.4 Zero-Dependency 外部依赖零引入红线审查

- ❌ **严禁引入**：`@base-ui/*`, `@radix-ui/*`, `framer-motion`, `floating-ui`, `downshift`, `cmdk`, `react-select`, `sonner` 等任何第三方 UI/动效库；
- 🟢 **100% 纯净自研**：所有手势、物理贝塞尔缓动、Safe-Aim 锥区几何算法、IME 状态机均以纯原生 React 18 与 CSS Modules 实现。

---

# 六、分步实施计划与验证路径

## 6.1 4 阶段精细化实施路线图

```
┌─────────────────────────────────────────────────────────────┐
│ 阶段一：Design Tokens 与 Zero-Blue 墨阶全量清洗 (P0)         │
│ • ToastStackModern.module.css 26 处硬编码 HEX 清零          │
│ • ToastCard.tsx 内联样式清除，切换为 CSS 状态类             │
│ • Switch/Tabs/Select/PreviewCard 16 处 fallback 清洗        │
│ • SegmentedControl 同心圆角公式修正 (7px - 2px = 5px)        │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 阶段二：Select / Combobox / PreviewCard 物理拆解 (P0)       │
│ • Select.tsx (1081行) → 6 个原子子文件 (各 ≤ 200行)         │
│ • Combobox.tsx (1340行) → 7 个原子子文件 (各 ≤ 200行)       │
│ • PreviewCard.tsx (767行) → 5 个原子子文件 (各 ≤ 200行)     │
│ • Select.module.css (519行) → Trigger & Content 样式解耦    │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 阶段三：无障碍、IME 状态机与性能漏洞修复 (P1)                │
│ • useFloatingPosition.ts 浮层内部滚动事件过滤 (防 Thrashing) │
│ • ComboboxInput.tsx 30ms 延迟合成锁 (防选词回车打断)        │
│ • Tabs / SegmentedControl 首项 tabIndex={0} 兜底 (防不可达) │
│ • PreviewCard 全局监听器清理与 300ms Grace 定时器单源收敛   │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 阶段四：CI 自动化门禁与 Vitest 全量回归验证 (P0)            │
│ • 运行 node scripts/check-line-counts.mjs 验证行数 ≤ 200     │
│ • 运行全量 Vitest 单元测试集与 TypeScript 类型检查          │
│ • 工作区状态就绪，提交主控验收                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 6.2 质量验收门禁清单

| 检查项编号 | 门禁验收条件 | 验证命令/标准 | 责任要求 |
| :--- | :--- | :--- | :--- |
| **GATE-01** | **行数预算断言** | `node scripts/check-line-counts.mjs --all` 零 VIOLATION / 零 HARD BLOCK | 所有新拆分文件有效代码行严格 $\le 200$ 行 |
| **GATE-02** | **色彩 Token 合规** | 全仓搜索 `#111111`, `#000`, `#dc2626` 等，新组件内 0 处命中 | 100% 依赖 `tokens.css` |
| **GATE-03** | **类型检查** | `npm run typecheck` | 0 Error，TypeScript 严格模式通过 |
| **GATE-04** | **单元测试** | `npx vitest run apps/crish-desktop/src/components/ui` | 100% 绿灯，覆盖所有交互与边缘状态 |
| **GATE-05** | **零外部依赖** | `package.json` 检查 | 无任何新增 npm 组件库依赖 |
| **GATE-06** | **Git 纪律** | `git status` | 严禁自行 commit/reset，工作区清晰留痕 |
