# 05 · 全案 Design Tokens 合规与反过度设计红线严苛审查报告

> **审查标识**：`docs/ui-component-modernization/plan-reviews/05-全案DesignTokens与工程红线严苛审查.md`  
> **审查对象**：全部 6 份最新现代化详案（`01` ~ `06`）  
> **审查基准**：  
> - `ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计 13 项硬性红线）  
> - `AGENTS.md`（§8 反过度设计、§11 CI 门禁与 RL-03 行数限制、§13 柔和焦点环规范、§14 现代色彩空间）  
> - `apps/crish-desktop/src/styles/tokens.css`（权威 Design Tokens 单一真源）  
>  
> **审查结论**：**【阻断拦截 · 必须整改】**。6 份详案在整体架构上有显著演进，但仍存在 **38 处硬编码 HEX 残留**、**21 处旧式 `rgba()` 散落**、**多处违反 AGENTS.md §13 的 20% 边框对比度超标**、**在声称 0 依赖的前提下仍偷渡 `@radix-ui/react-popover` 与 `lucide-react` 外部 npm 依赖**、以及 **`Menu.tsx` 达 454 行逼近 500 行门禁** 等硬伤，必须就地彻底清剿！

---

## 审查缺陷总览看板

| 编号 | 缺陷分类 | 严重级别 | 涉及详案 | 缺陷摘要 |
| :--- | :--- | :---: | :--- | :--- |
| **REV-01** | **外部 npm 依赖违规** | **致命 (Blocker)** | 详案 `03` | 声称 0 外部依赖，但 `Menu.tsx` 源码仍明文 `import * as Popover from '@radix-ui/react-popover'` |
| **REV-02** | **外部 npm 依赖违规** | **严重 (Critical)** | 详案 `03`, `05`, `06` | 多处直接引入外部库 `import * as Lucide from 'lucide-react'`，破坏纯净自研与包体积防线 |
| **REV-03** | **裸写硬编码 HEX** | **致命 (Blocker)** | 详案 `03` (L1311) | `ComposePlusMenu.module.css` 出现裸写硬编码 `color: #c25e2e;`，脱离任何 Token 变量 |
| **REV-04** | **焦点环/边框对比度超标** | **严重 (Critical)** | 详案 `06` (L342, 394, 821) | 边框使用 `color-mix(..., text-primary 20%)`，直接击穿 AGENTS.md §13 规定的 10% 对比度上限 |
| **REV-05** | **焦点环/边框对比度超标** | **严重 (Critical)** | 详案 `02` (L2360, 2669) | 触发器与输入框 `:focus-visible` 边框混入 15% `text-primary`，突破 10% 柔和上限 |
| **REV-06** | **大面积 HEX Fallback 残留** | **严重 (Critical)** | 详案 `05` | 15 处散落 `--font-text-*: var(..., #111111 / #555555 / #696969)` 旧色阶硬编码备用值 |
| **REV-07** | **深色模式硬编码 HEX 残留** | **严重 (Critical)** | 详案 `06` (L202-204) | 深色模式下直接硬编码 `#242424`, `#dddddd`, `#333333`，未消费系统暗色语义 Token |
| **REV-08** | **品牌绿与投影 HEX 残留** | **一般 (Major)** | 详案 `01`, `02`, `06` | 散落 `var(--brand, #10b981)`、`var(--text-primary, #000)`、`var(--text-tertiary, #888888)` |
| **REV-09** | **旧式 `rgba(...)` 大面积散落** | **一般 (Major)** | 详案 `02`, `03`, `06` | 在声称淘汰 `rgba()` 后，终态 CSS 中仍散落 21 处 `rgba(29, 28, 26, ...)` / `rgba(0, 0, 0, ...)` |
| **REV-10** | **单文件行数逼近门禁红线** | **一般 (Major)** | 详案 `03` | `Menu.tsx` 单文件达 454 行，未做复合组件原子拆分，逼近 500 行硬阻断门禁 |
| **REV-11** | **CI 门禁与覆盖率断言缺失** | **一般 (Major)** | 全案 `01` ~ `06` | 各方案仅规划常规交互断言，缺少对 `check-line-counts` 行数门禁与 Vitest 快层覆盖率的防御性断言 |

---

## 维度一：Design Tokens 绝对纯净化与色彩空间死磕审查

### 1.1 裸写硬编码 HEX 违规（零容忍红线）

- **[严重级别: 致命]**
- **文件路径**: `docs/ui-component-modernization/plan-improvements/03-多行Select文字重叠根治与Menu弹性自适应详案.md:1311`
- **缺陷剖析**:
  在 `ComposePlusMenu.module.css` 的代码规划中，`.matrixTag[data-category="read"]` 的样式声明直接硬编码了十六进制颜色值：
  ```css
  /* 违规代码 */
  .matrixTag[data-category='read'] {
    background: var(--accent-orange-subtle);
    color: #c25e2e; /* 💥 致命：裸写硬编码 HEX，完全脱离任何 CSS 变量 */
  }
  ```
  该行没有任何 CSS 变量包裹，在深色模式或主题切换时无法自适应，直接击穿 Design Tokens 单一真源铁律！
- **极致修复方案**:
  ```css
  /* 极致修复：全面收敛至语义 Token */
  .matrixTag[data-category='read'] {
    background: var(--accent-orange-subtle, color-mix(in srgb, var(--accent-orange, hsl(28 80% 52%)) 12%, transparent));
    color: var(--accent-orange-strong, color-mix(in srgb, var(--accent-orange, hsl(28 80% 52%)) 85%, var(--text-primary)));
  }
  ```

---

### 1.2 大面积旧墨阶 HEX Fallback 残留（`#111111`, `#555555`, `#696969`）

- **[严重级别: 严重]**
- **文件路径**: `docs/ui-component-modernization/plan-improvements/05-字体选择器全量系统字体读取与优雅内嵌搜索详案.md:439-441, 1591, 1619, 1662, 1674, 1680, 1693, 1701, 1762, 1782, 1817, 1823, 1848`
- **缺陷剖析**:
  详案 `05` 在第 17 行明文承诺“严格遵循 tokens.css 纯净中性 Warm-Gray 底板”，但在后续样式规划与 CSS 变量定义中，散落了 **15 处** 旧式的硬编码 HEX 回退值：
  ```css
  /* 违规代码片段示例 */
  --font-text-primary: var(--text-primary, #111111);
  --font-text-secondary: var(--text-secondary, #555555);
  --font-text-tertiary: var(--text-tertiary, #696969);
  color: var(--text-primary, #111111);
  color: var(--text-secondary, #555555);
  color: var(--text-tertiary, #696969);
  ```
  `#111111`、`#555555`、`#696969` 是早期未收敛时的冷黑死灰硬编码。在现有 `tokens.css` 中，文本语义色已具备完整的多级 fallback 与 HSL 规范。硬编码 HEX fallback 会在变量未命中时污染 Warm-Gray 色彩体系。
- **极致修复方案**:
  彻底剔除硬编码 HEX fallback，直接消费标准语义 Token 或使用现代 HSL：
  ```css
  /* 极致修复：彻底纯净化 */
  --font-text-primary: var(--text-primary);
  --font-text-secondary: var(--text-secondary);
  --font-text-tertiary: var(--text-tertiary);
  color: var(--text-primary);
  color: var(--text-secondary);
  color: var(--text-tertiary);
  ```

---

### 1.3 深色模式硬编码 HEX 残留（`#242424`, `#dddddd`, `#333333`）

- **[严重级别: 严重]**
- **文件路径**: `docs/ui-component-modernization/plan-improvements/06-全仓次级按钮实体白卡重塑与受管浏览器现代化详案.md:202-204`
- **缺陷剖析**:
  在 `Button.module.css` 的深色模式契约章节中，规划了如下代码：
  ```css
  /* 违规代码 */
  :global(html[data-theme='dark']) .buttonSecondary,
  :global(html[data-theme='dark']) .button[data-variant='secondary'] {
    --btn-bg: var(--bg-elevated, #242424);
    --btn-fg: var(--text-primary, #dddddd);
    --btn-border: var(--border-subtle, #333333);
    --btn-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }
  ```
  深色模式的底色、文字色与边框色应当完全由 `tokens.css` 在 `html[data-theme='dark']` 下派生的 CSS 变量动态驱动，组件内部绝对不应出现私有硬编码 `#242424` / `#dddddd` / `#333333`。
- **极致修复方案**:
  ```css
  /* 极致修复：统一由 tokens.css 单一真源驱动 */
  :global(html[data-theme='dark']) .buttonSecondary,
  :global(html[data-theme='dark']) .button[data-variant='secondary'] {
    --btn-bg: var(--bg-elevated);
    --btn-fg: var(--text-primary);
    --btn-border: var(--border-subtle);
    --btn-shadow: 0 1px 3px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 25%, transparent);
  }
  ```

---

### 1.4 品牌翡翠绿与辅助色 HEX 备用值残留（`#10b981`, `#46724c`, `#d97706`, `#000`）

- **[严重级别: 一般]**
- **文件路径**:
  - `01-Switch纯粹流体果冻与中轴几何对称改进详案.md:96, 216, 487, 834, 895`
  - `02-Select与Combobox大圆角同心架构与解耦拆分详案.md:126, 208, 2013, 2604`
  - `03-多行Select文字重叠根治与Menu弹性自适应详案.md:1307`
  - `06-全仓次级按钮实体白卡重塑与受管浏览器现代化详案.md:192, 520, 663, 670, 1189`
- **缺陷剖析**:
  上述文件中大量存在 `var(--brand, #10b981)`、`var(--text-primary, #000)`、`var(--text-tertiary, #888888)`、`var(--text-success-strong, #46724c)`、`var(--accent-orange, #d97706)`。  
  虽然置于 `var()` 的第二个参数，但硬编码十六进制值违反了全仓 Design Tokens 绝对纯净化原则，且 `#000`、`#888888` 属于非标准的生硬死黑与冷灰。
- **极致修复方案**:
  统一将所有 fallback 替换为 `tokens.css` 对应的 HSL 现代声明或纯变量引用：
  - `var(--brand, #10b981)` $\to$ `var(--brand, hsl(160 84% 39%))`
  - `var(--text-primary, #000)` $\to$ `var(--text-primary, hsl(0 0% 7%))`
  - `var(--text-tertiary, #888888)` $\to$ `var(--text-tertiary)`
  - `var(--text-success-strong, #46724c)` $\to$ `var(--text-success-strong, hsl(132 23% 36%))`
  - `var(--accent-orange, #d97706)` $\to$ `var(--accent-orange, hsl(37 91% 44%))`

---

### 1.5 旧式 `rgba(...)` 散落与现代 CSS 规范违反（AGENTS.md §14）

- **[严重级别: 一般]**
- **文件路径**:
  - `02-Select与Combobox大圆角同心架构与解耦拆分详案.md:122, 204, 2453, 2758`
  - `03-多行Select文字重叠根治与Menu弹性自适应详案.md:515, 1336, 1655`
  - `06-全仓次级按钮实体白卡重塑与受管浏览器现代化详案.md:142, 147, 168, 194, 205, 296, 328, 343, 388, 395, 672, 808, 822, 930`
- **缺陷剖析**:
  `AGENTS.md` §14 明确规定：“优先 HSLA / 斜杠透明度：避免散落旧式 `rgba(r,g,b,a)`；UI 与 Design Token 优先 `hsl(h s l / a)` 或 `hsla(...)`，用斜杠 `/` 分隔不透明度，或使用 `color-mix(in srgb, ...)`”。  
  然而在详案 `02`、`03`、`06` 中，阴影属性反复出现 `rgba(29, 28, 26, 0.12)`、`rgba(0, 0, 0, 0.04)`、`rgba(0, 0, 0, 0.02)`，详案 `06` 甚至在 2091 行声称“淘汰旧式 rgba”却在正文中散落 14 处 `rgba(...)`。
- **极致修复方案**:
  统一重构为 `color-mix(in srgb, ...)` 语法：
  ```css
  /* 极致修复：彻底淘汰 rgba() */
  /* 详案 02 修复 */
  box-shadow:
    0 12px 32px -4px color-mix(in srgb, var(--shadow-color, hsl(35 5% 11%)) 12%, transparent),
    0 4px 12px -2px color-mix(in srgb, var(--shadow-color, hsl(35 5% 11%)) 4%, transparent);

  /* 详案 06 修复 */
  --btn-shadow:
    0 1px 2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 4%, transparent),
    0 1px 1px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 2%, transparent);
  ```

---

## 维度二：AGENTS.md §13 焦点环与边框对比度红线死磕审查

### 2.1 边框混入 20% `text-primary` 严重超标（AGENTS.md §13 阻断项）

- **[严重级别: 严重]**
- **文件路径**: `docs/ui-component-modernization/plan-improvements/06-全仓次级按钮实体白卡重塑与受管浏览器现代化详案.md:342, 394, 821`
- **缺陷剖析**:
  在快捷键按键 `.shortcutKeyBtn` 与预设 Chip `.presetChip` 的悬停样式规划中：
  ```css
  /* 违规代码 */
  .shortcutKeyBtn:hover:not(:disabled) {
    background-color: var(--bg-card);
    border-color: color-mix(in srgb, var(--border-color) 80%, var(--text-primary) 20%); /* 💥 混入 20% 严重超标！ */
    box-shadow: 0 1px 3px color-mix(in srgb, var(--shadow-color) 6%, transparent);
  }
  ```
  `AGENTS.md` §13 明确设立了硬性红线：“**焦点对比度上限约 10%**：任何情况下焦点/激活态不得使用硬实线；相对基线，灰色加深混入文本色不超过约 **10%**（例如 `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)` 为上限量级）；常规元素优先约 **3%–6%** 混入以保持柔软。”  
  混入 20% `var(--text-primary)` 会在鼠标悬停时产生明显的生硬深灰/黑边，破坏长时间阅读的舒适度。
- **极致修复方案**:
  ```css
  /* 极致修复：严格收敛至 6%~8% 柔和混入量级 */
  .shortcutKeyBtn:hover:not(:disabled),
  .presetChip:hover:not(:disabled) {
    background-color: var(--bg-card);
    border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 4%, transparent);
  }
  ```

---

### 2.2 触发器与输入框焦点环边框混入 15% 超标

- **[严重级别: 严重]**
- **文件路径**: `docs/ui-component-modernization/plan-improvements/02-Select与Combobox大圆角同心架构与解耦拆分详案.md:2360, 2669`
- **缺陷剖析**:
  在 `SelectTrigger.module.css` 与 `Combobox.module.css` 的 `:focus-visible` 定义中：
  ```css
  /* 违规代码 */
  .trigger:focus-visible,
  .comboboxInput:focus-visible {
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
    border-color: color-mix(in srgb, var(--border-color) 85%, var(--text-primary) 15%); /* 💥 15% 突破 10% 上限 */
  }
  ```
  `border-color` 混入 15% 文本色同样违反了 §13 的 10% 顶格上限。
- **极致修复方案**:
  ```css
  /* 极致修复：统一压降至 10% 以内 */
  .trigger:focus-visible,
  .comboboxInput:focus-visible {
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
    border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }
  ```

---

## 维度三：反过度设计与 0 外部 npm 库依赖死磕审查

### 3.1 外部 npm 组件库偷渡违规（`@radix-ui/react-popover`）

- **[严重级别: 致命]**
- **文件路径**: `docs/ui-component-modernization/plan-improvements/03-多行Select文字重叠根治与Menu弹性自适应详案.md:762`
- **缺陷剖析**:
  详案 `03` 在文首“工程与架构铁律”中第一条明确写道：
  > “1. **零外部 npm 组件库依赖**：绝对禁止引入第三方组件库（如 `@base-ui`, `@radix-ui`, `framer-motion` 等），所有物理动效、手势、浮层几何与无障碍交互均采用纯原生 React 18+ 与 CSS Modules 100% 纯净自研”
  
  然而在第 5.3 节给出的重构代码 `apps/crish-desktop/src/components/ui/Menu/Menu.tsx:L762` 中，第一行导入即为：
  ```tsx
  /* 💥 致命违规：偷渡引入 @radix-ui */
  import * as Popover from '@radix-ui/react-popover';
  ```
  并且直接使用 `<Popover.Root>`, `<Popover.Trigger>`, `<Popover.Content>` 包裹菜单！这是对项目反过度设计红线与零外部依赖铁律的严重违背！
- **极致修复方案**:
  必须彻底清退 `@radix-ui/react-popover`，直接接入详案 `02` 中经过数学严密验证的纯原生浮层调度引擎 `useFloatingPosition` 与 `createPortal`，完全自主调度浮层：
  ```tsx
  /* 极致修复：100% 纯原生 Portal 与 useFloatingPosition 浮层 */
  import React, { useCallback, useEffect, useRef, useState, useId } from 'react';
  import { createPortal } from 'react-dom';
  import { useFloatingPosition } from '../Select/useFloatingPosition';
  import { layerStackService } from '../internal/layer-stack/LayerStackManager';
  // 彻底剔除 @radix-ui/react-popover
  ```

---

### 3.2 外部 npm 图标库直接依赖违规（`lucide-react`）

- **[严重级别: 严重]**
- **文件路径**:
  - `03-多行Select文字重叠根治与Menu弹性自适应详案.md:763, 1476`
  - `05-字体选择器全量系统字体读取与优雅内嵌搜索详案.md:983, 1177, 1188, 1215, 1234, 1250`
  - `06-全仓次级按钮实体白卡重塑与受管浏览器现代化详案.md:1328, 1496`
- **缺陷剖析**:
  详案 `03`、`05`、`06` 中多处直接从 `lucide-react` 导入图标。  
  在原子组件体系（`ui/`）的纯净性规范中，底层原子组件应尽可能具备自闭环的极简内联 SVG（如 `internal/SelectIcons.tsx` 中的 `ChevronUpDown`、`CheckIcon`、`ClearIcon`），避免底层原子组件因外部图标库版本升级或打包配置变异而导致编译失败。
- **极致修复方案**:
  1. 在 `Select/internal/SelectIcons.tsx` 中建立统一的轻量原子 SVG 集合；
  2. 业务级页面（设置页、受管浏览器）允许消费仓库已固化的通用图标适配层，底层原子组件库（`Menu`, `Select`, `Button`）内部严禁直接绑定特定第三方图标包。

---

## 维度四：RL-03 单文件行数门禁与模块拆解深度审查

### 4.1 `Menu.tsx` 单文件代码量逼近 500 行阻断门禁

- **[严重级别: 一般]**
- **文件路径**: `docs/ui-component-modernization/plan-improvements/03-多行Select文字重叠根治与Menu弹性自适应详案.md:752-1205`
- **缺陷剖析**:
  详案 `03` 中重构后的 `Menu.tsx` 规划代码量达到 **454 行**。  
  根据 `AGENTS.md` §11 与 `scripts/check-line-counts.mjs` 规范，UI 组件的行数告警门槛为 500 行（硬阻断 650 行）。454 行已处于黄色预警区间（裕量仅 9%），且包含了受控状态机、A11y 键盘导航、Portal 渲染、Option 渲染器等诸多逻辑，存在上帝组件重聚风险。
- **极致修复方案**:
  对标详案 `02` 的优雅拆分拓扑，将 `Menu` 彻底拆解为单职责子文件：
  ```
  apps/crish-desktop/src/components/ui/Menu/
  ├── MenuRoot.tsx        (根状态机与 Context Provider，≤ 100 行)
  ├── MenuTrigger.tsx     (触发器按钮与 Ref 挂载，≤ 80 行)
  ├── MenuContent.tsx     (Portal 浮层与 isPositioned 门闩，≤ 130 行)
  ├── MenuItem.tsx        (选项行弹性排版与 Checkmark，≤ 90 行)
  ├── MenuSeparator.tsx   (分割线，≤ 25 行)
  ├── types.ts            (接口契约，≤ 50 行)
  └── Menu.tsx            (聚合导出与 Legacy 配置式适配器，≤ 60 行)
  ```
  拆解后每个子文件代码量均 $\le 130$ 行，裕量高达 74% 以上！

---

## 维度五：防回归 Vitest 单元测试覆盖率与 CI 门禁断言死磕审查

### 5.1 缺少行数门禁与快层覆盖率的自动化静态断言

- **[严重级别: 一般]**
- **文件路径**: 全案 `01` ~ `06` 的测试章节
- **缺陷剖析**:
  所有 6 份详案在测试规划中均着重于交互逻辑（点击、键盘、ARIA 属性、样式类），但均未在测试套件中编写针对 **“反过度设计与 CI 门禁”** 的保护性静态断言：
  1. 未断言 CSS 源码中不得存在 `#` 开头的十六进制硬编码（除已登记白名单外）；
  2. 未断言 CSS 中不得包含 `1.51` 等过冲贝塞尔或非法选择器；
  3. 未断言各 TSX/CSS 文件的有效物理行数必须通过 `scripts/check-line-counts.mjs`（即 $\le 500$ 行）；
  4. 未断言组件严格具备 0 外部 npm 依赖（通过 AST 解析 import 路径）。
- **极致修复方案**:
  在各组件的 `.test.tsx` 静态断言套件中追加 CI 门禁守卫测试：
  ```tsx
  describe('CI 门禁与反过度设计静态守卫断言', () => {
    it('CSS 文件不得包含未经审批的硬编码 HEX 颜色', () => {
      const css = readFileSync(join(DIR, 'Menu.module.css'), 'utf8');
      // 允许 var() 内的合法 Token，严禁裸写 HEX
      const rawHexMatches = css.match(/(?<!var\([^)]*)#[0-9a-fA-F]{3,8}\b/g);
      expect(rawHexMatches).toBeNull();
    });

    it('单文件行数严格满足 RL-03 门禁 (有效代码 <= 500 行)', () => {
      const tsx = readFileSync(join(DIR, 'MenuRoot.tsx'), 'utf8');
      const validLines = tsx.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
      expect(validLines).toBeLessThanOrEqual(500);
    });

    it('不得引入 @radix-ui 或 @base-ui 等外部组件库', () => {
      const tsx = readFileSync(join(DIR, 'MenuRoot.tsx'), 'utf8');
      expect(tsx).not.toMatch(/from\s+['"]@radix-ui/);
      expect(tsx).not.toMatch(/from\s+['"]@base-ui/);
      expect(tsx).not.toMatch(/from\s+['"]framer-motion/);
    });
  });
  ```

---

### 5.2 字体选择器异步并发重入与异常分支漏测

- **[严重级别: 微小]**
- **文件路径**: `docs/ui-component-modernization/plan-improvements/05-字体选择器全量系统字体读取与优雅内嵌搜索详案.md:1880-2000`
- **缺陷剖析**:
  详案 `05` 的单元测试矩阵中，对 `window.queryLocalFonts()` 仅模拟了正常返回字体数组的成功路径，未测试以下真实桌面边缘场景：
  1. 用户在扫描进行中（`isScanning: true`）多次疯狂点击扫描按钮时的防抖与重入拦截；
  2. 底层 DirectWrite / CoreText 抛出 `AbortError` 或 `NotAllowedError` 时向 Canvas 引擎 B 的无缝降级；
  3. `localStorage.setItem` 超出配额（QuotaExceededError）时的静默容灾。
- **极致修复方案**:
  在 `fontStoreScan.test.ts` 中补齐异常与重入测试用例：
  ```typescript
  it('扫描进行中重复触发应直接复用当前 Promise，严禁并发重复扫描', async () => {
    let callCount = 0;
    vi.stubGlobal('queryLocalFonts', vi.fn(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return [];
    }));
    const [p1, p2] = [scanSystemFonts(true), scanSystemFonts(true)];
    await Promise.all([p1, p2]);
    expect(callCount).toBe(1);
  });
  ```

---

## 六、全案整改阻断清单与实施红线

在进入最终代码实现波（Implementation Wave）前，必须在详案及后续代码落地中无条件执行以下 **6 大必改项**：

1. **【强制剔除 @radix-ui】**：详案 `03` 必须彻底删除 `Menu.tsx` 中的 `@radix-ui/react-popover` 导入，全面切换至原生 `useFloatingPosition` 与 `createPortal`；
2. **【清除所有硬编码 HEX】**：
   - 立即清剿详案 `03` 中的裸写 `#c25e2e` 与 `#d97706`；
   - 立即清剿详案 `05` 中的 15 处 `#111111` / `#555555` / `#696969`；
   - 立即清剿详案 `06` 中的深色模式 `#242424` / `#dddddd` / `#333333`；
   - 规范化详案 `01`、`02`、`06` 中的 `#10b981` / `#000` / `#46724c`；
3. **【压降焦点环对比度至 10% 以内】**：
   - 详案 `06` 的 `.shortcutKeyBtn:hover` 与 `.presetChip:hover` 混入比例由 20% 压降至 8%；
   - 详案 `02` 的 `.trigger:focus-visible` 混入比例由 15% 压降至 10%；
4. **【全量淘汰旧式 `rgba(...)`】**：将详案 `02`、`03`、`06` 中的 21 处 `rgba(...)` 全部替换为 `color-mix(in srgb, ...)` 或 `hsl(... / a)`；
5. **【实施 `Menu.tsx` 复合原子拆解】**：将 454 行的单体 `Menu.tsx` 拆分为 `MenuRoot`, `MenuTrigger`, `MenuContent`, `MenuItem` 等独立子文件，确保单文件 $\le 130$ 行；
6. **【测试套件注入 CI 门禁与覆盖率断言】**：所有测试文件必须包含行数门禁、零外部组件库依赖、无裸写 HEX 的自动化静态断言。
