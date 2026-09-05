# 全域 Hover 双重叠加根除与系统 Design Tokens 规范化方案 (PLAN-04)

> **文档位置**：`docs/diff-view-redesign/independent-plans/04-hover-tokens-standardization-plan.md`  
> **所属战役**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）  
> **方案编号**：PLAN-04（阶段二：独立方案设计）  
> **输入依赖**：[`docs/diff-view-redesign/analysis/04-hover-tokens-contrast-audit.md`](file:///c:/Software/conex/docs/diff-view-redesign/analysis/04-hover-tokens-contrast-audit.md) (AUDIT-04)  
> **方案职责**：彻底物理切断外层容器与包装层上的 `:hover` 背景规则，消除导致局部变暗 4.94%~6.88% 脏灰的 Porter-Duff 物理 Alpha 双重叠加缺陷；确立“单一真理 Hover 交互层级”（Single Layer of Hover Truth, SLoHT）；全量清剿 13 处裸写硬编码色值（`#ffffff`、`#ef4444`）与 6 处幽灵 Token（`--diff-bg-pane` 等），收敛违章旧蓝 `--accent-blue` 为 Conex Zero-Blue 规范的 `--md-link-color`；严格对齐 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13-14 视觉对比度与形态 ④ 极简输入框规范；并在样式测试层构建刚性 AST 正则防回归门禁。

---

## 目录

- [一、方案编制四段式总纲（To-Do / Not-To-Do / 旧路径 / 删除面）](#一方案编制四段式总纲to-do--not-to-do--旧路径--删除面)
  - [1.1 【做什么（To-Do）】](#11-做什么to-do)
  - [1.2 【不做什么（Not-To-Do）】](#12-不做什么not-to-do)
  - [1.3 【旧路径清单（Legacy Path Inventory）】](#13-旧路径清单legacy-path-inventory)
  - [1.4 【自检删除面（Self-Inspection Deletion Surface）】](#14-自检删除面self-inspection-deletion-surface)
- [二、方案目标与单层 Hover 交互架构（根除物理双重变灰）](#二方案目标与单层-hover-交互架构根除物理双重变灰)
  - [2.1 背景与用户核心痛点透视](#21-背景与用户核心痛点透视)
  - [2.2 物理 Alpha 叠加机理：Porter-Duff Over 算子数学还原](#22-物理-alpha-叠加机理porter-duff-over-算子数学还原)
  - [2.3 为什么“有的很灰”？——三种状态灰度分裂与跳闪分析](#23-为什么有的很灰三种状态灰度分裂与跳闪分析)
  - [2.4 单一真理 Hover 交互层级（SLoHT）架构契约](#24-单一真理-hover-交互层级sloht架构契约)
- [三、容器与行级样式重构规则（彻底切断父级 hover）](#三容器与行级样式重构规则彻底切断父级-hover)
  - [3.1 物理切断：彻底移除父级容器与包装层的 :hover 背景规则](#31-物理切断彻底移除父级容器与包装层的-hover-背景规则)
  - [3.2 容器与外包装层强制锁定透明背景](#32-容器与外包装层强制锁定透明背景)
  - [3.3 交互行独占单层 Hover / Active 样式真源](#33-交互行独占单层-hover--active-样式真源)
  - [3.4 行内操作按钮防闪烁与透明度继承规范](#34-行内操作按钮防闪烁与透明度继承规范)
- [四、13 处裸写色值与 6 处幽灵 Token 全量替换契约表](#四13-处裸写色值与-6-处幽灵-token-全量替换契约表)
  - [4.1 13 处硬编码 Hex 色值全量替换矩阵](#41-13-处硬编码-hex-色值全量替换矩阵)
  - [4.2 6 处幽灵 Token 清剿与收敛契约](#42-6-处幽灵-token-清剿与收敛契约)
  - [4.3 Zero-Blue 铁律与 Emerald Green 品牌超链接规范](#43-zero-blue-铁律与-emerald-green-品牌超链接规范)
  - [4.4 私有魔术混入比收敛（4% -> var(--control-soft-bg-hover)）](#44-私有魔术混入比收敛4---var--control-soft-bg-hover)
- [五、AGENTS.md §13-14 色彩与对比度科学验证断言](#五agentsmd-13-14-色彩与对比度科学验证断言)
  - [5.1 AGENTS.md §13 焦点与激活态刚性断言](#51-agentsmd-13-焦点与激活态刚性断言)
  - [5.2 形态 ④：Diff 搜索筛选框（纯光标极简型）刚性落地](#52-形态--diff-搜索筛选框纯光标极简型刚性落地)
  - [5.3 AGENTS.md §14 现代 CSS 与色彩空间断言](#53-agentsmd-14-现代-css-与色彩空间断言)
  - [5.4 视觉对比度金字塔与科学光学梯次（WCAG AAA/AA 刚性达标）](#54-视觉对比度金字塔与科学光学梯次wcag-aaaa-刚性达标)
- [六、样式层删除面清单与防回归自动化门禁设计](#六样式层删除面清单与防回归自动化门禁设计)
  - [6.1 拟物理删除与修改的样式代码清单（精确至行号）](#61-拟物理删除与修改的样式代码清单精确至行号)
  - [6.2 代码净收敛与重构指标评估表](#62-代码净收敛与重构指标评估表)
  - [6.3 style-contract 自动化防回归门禁测试设计](#63-style-contract-自动化防回归门禁测试设计)
  - [6.4 实施推进顺序与反退避守则](#64-实施推进顺序与反退避守则)

---

## 一、方案编制四段式总纲（To-Do / Not-To-Do / 旧路径 / 删除面）

### 1.1 【做什么（To-Do）】

1. **确立“单一真理 Hover 交互层级”（Single Layer of Hover Truth, SLoHT）**：
   - 彻底梳理差异面板（`DiffCard` 及其子组件）的 DOM 渲染树与 CSS 规则体系；
   - 容器与外包装层（`.fileList`、`.accordionItem`、`.accordionHeaderRow`、`.groupItemsContainer` 等）强制锁定 `background: transparent`；
   - 物理删除父级容器上声明的全部 `:hover` 背景色规则（尤其是 [`DiffCard.module.css:204-206`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L204-L206) 的 `.accordionItem:hover`），彻底切断双重透明度物理叠加路径。
2. **独占交互行 Hover 状态真源**：
   - 仅最内层实际承载点击交互的条目实体（`.fileItem` / `.flatFileRow`）享有唯一的 `var(--bg-hover)` 与 `var(--bg-active)`；
   - 悬停态严格遵循系统令牌：浅色模式为纯净 2.5%（`--tint-hover`），暗色模式为纯净 3.5%（`--tint-hover`）；
   - 激活态严格对齐系统令牌：浅色模式 5.0%（`--tint-active`），暗色模式 6.5%（`--tint-active`）。
3. **全量 Design Tokens 替换矩阵**：
   - 拔除 13 处裸写十六进制色值（主要是 `#ffffff` 纯白兜底与 `#ef4444` 红色错误色），统一收敛为系统权威令牌 `var(--bg-card)`、`var(--color-error-bg)`、`var(--color-error-border)` 与 `var(--color-error)`；
   - 彻底清退 6 处未在 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 声明的幽灵 Token（如 `--diff-bg-pane`），全面回归 `var(--bg-card)` 卡片背景底色；
   - 收敛违规旧蓝 `var(--accent-blue)`，严格对齐 Conex Zero-Blue 规范，采用品牌翡翠绿超链接令牌 `var(--md-link-color)`；
   - 收敛 Commit 触发栏的 4% 私有魔术混入比，统一采用系统控件轻悬停令牌 `var(--control-soft-bg-hover)`。
4. **严格落实 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13-14 视觉规范**：
   - 焦点对比度上限约 10%，常规交互保持 2.5%~5% 柔软质感，保护用户长时间阅读不疲劳；
   - 严格落地搜索框形态 ④（纯光标极简型），全态无边框、无描边、无聚焦阴影。

### 1.2 【不做什么（Not-To-Do）】

1. **严禁执行 Git 版本管理写操作**：
   - 严禁执行 `git commit`、`git reset`、`git checkout` 或 `git restore`；提交权与回滚权仅归主 Agent（严格遵循 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §3）。
2. **严禁使用补丁式与魔术补偿手段**：
   - 严禁使用 `!important`、高特异性覆盖（如 `div.accordionItem:hover > button.fileItem { ... }`）或透明度反向减法补偿去压制过灰；必须从根源上物理删除父级容器的 hover 规则（严格遵循 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §7）。
3. **严禁引入任何新的裸写色值**：
   - 严禁在 CSS、TSX 中引入任何新的裸写 `#hex`、`rgb()` 或旧式 `rgba()`；所有色彩声明必须从 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 权威真源导入。
4. **严禁在容器与包装层新增背景色悬停动画**：
   - 容器外壳必须保持无状态骨架，禁止在布局层自造动态色块。

### 1.3 【旧路径清单（Legacy Path Inventory）】

| 序号 | 现场文件与代码行号 | 现有规则代码片段 | 缺陷类型与病理分析 |
| :---: | :--- | :--- | :--- |
| **1** | [`DiffCard.module.css:204-206`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L204-L206) | `.accordionItem:hover { background-color: var(--bg-hover); }` | **父级非法 Hover**：外层容器捕获悬停，导致与子行双重叠加。 |
| **2** | [`DiffCard.module.css:214-221`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L214-L221) | `.accordionActive:hover { background: var(--bg-card); ... }` | **修补式盖底**：用卡片底压制父级 hover，引发展开与折叠条目灰度分裂。 |
| **3** | [`DiffCard.module.css:253-256`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L253-L256) | `.accordionItem .fileItem:hover { background-color: var(--bg-hover); }` | **子级复合选择器**：与父级规则叠加生效，合成 4.94% 脏灰。 |
| **4** | [`DiffCard.module.css:90-104`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L90-L104) | `.actionBtn { ... } .actionBtn:hover { ... }` | **存量死代码**：已被 `DiffHeaderControls` 中的原子按钮替代，留存死悬停规则。 |
| **5** | [`DiffCard.module.css:278-281`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L278-L281) | `.fileNameLink:hover { color: var(--accent-blue); }` | **违章旧蓝**：违背 Conex Zero-Blue 规范，超链接悬停使用了过时蓝色。 |
| **6** | [`DiffCard.module.css:657-660`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L657-L660) | `.commitTriggerBar:hover { background: color-mix(..., 4%, ...); }` | **私有魔术混入比**：4% 偏离系统 2.5%~3.5% 柔和焦点规范。 |

### 1.4 【自检删除面（Self-Inspection Deletion Surface）】

- **物理删除行数**：
  - [`DiffCard.module.css:204-206`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L204-L206)（`.accordionItem:hover` 规则，共 3 行）；
  - [`DiffCard.module.css:90-104`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L90-L104)（死代码 `.actionBtn` 及其 `:hover`，共 15 行）；
  - [`DiffCard.module.css:214-221`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L214-L221)（手风琴展开态修补盖底，共 8 行）；
  - **总计物理删除约 26 行**。
- **重写与收敛行数**：
  - 12 处 CSS 硬编码色值与幽灵 Token 替换；
  - 1 处 TSX（[`VirtualPlainCodeViewer.tsx:65`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx#L65)）幽灵 Token 替换；
  - **总计规范化重写约 20 行**。
- **自动化防回归门禁覆盖**：
  - 接入 [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts)；
  - 5 项刚性 AST/正则断言，硬性阻断容器级 hover、硬编码十六进制与幽灵 Token 的任何回潮。

---

## 二、方案目标与单层 Hover 交互架构（根除物理双重变灰）

### 2.1 背景与用户核心痛点透视

用户在深度体验 Conex 差异审查面板后提出确切反馈：
> “*这个界面的hover我看也是有问题的，有的很灰啊。而且现在的这个界面很多东西还有硬编码的呢，这个也统一使用我们的token体系。*”

经前置代码现场审计查明：
1. **“有的很灰”**：并非单一组件的对比度调优失误，而是**折叠条目（未展开）由于父子两层同时命中 `:hover`，经浏览器 Alpha 合成引擎叠加出了翻倍的深脏灰（浅色 4.94%、深色 6.88%），直接跃升至 Active 激活态水平**；
2. **“有的不灰”**：当文件项展开时，代码中存在 `.accordionActive:hover { background: var(--bg-card); }`，卡片的纯白底色强行把父级的 2.5% 遮盖住，导致展开条目只呈现子级的单层灰度；
3. **“划过闪烁”**：鼠标在条目上水平滑动进入右侧 Git 快捷操作按钮（`.hoverActBtn`）时，由于光标离开 `.fileItem`，子级 hover 熄灭，背景透明度瞬间从 4.94% 骤降至 2.5%，条目左侧突然变亮，产生强烈的频闪感。

因此，必须从根本上确立单层渲染架构，拔除一切父级 hover 规则。

---

### 2.2 物理 Alpha 叠加机理：Porter-Duff Over 算子数学还原

在图形合成管线中，当两个半透明层同处一个绘制视口坐标内时，浏览器 Compositor 采用经典的 **Porter-Duff "Over" 算子** 执行颜色混合：

$$\alpha_{composite} = \alpha_{foreground} + \alpha_{background} \times (1 - \alpha_{foreground})$$

在系统权威令牌 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中：
- 浅色模式 `--tint-hover`：`color-mix(in srgb, var(--text-primary) 2.5%, transparent)` $\to \alpha = 0.025$
- 暗色模式 `--tint-hover`：`color-mix(in srgb, var(--text-primary) 3.5%, transparent)` $\to \alpha = 0.035$

#### 浏览器合成计算过程：

```
光标悬停在文件条目上时，DOM 节点命中链：
[DOM Node] .accordionItem (:hover 命中!)    ===> Layer 1 (底层): α₁ = 2.5%
  └─ [DOM Node] .fileItem (:hover 命中!)  ===> Layer 2 (顶层): α₂ = 2.5%
```

1. **浅色主题环境（Light Theme）**：
   $$\alpha_{composite} = 0.025 + 0.025 \times (1 - 0.025) = 0.025 + 0.024375 = \mathbf{4.94\%}$$
   - 系统设计的单层悬停为 **2.50%**；
   - 系统设计的点击激活态 `--tint-active` 为 **5.00%**；
   - **合成结果 4.94% 几乎 100% 达到了激活态水平**！悬停直接呈现深暗的污浊脏灰块。
2. **暗色主题环境（Dark Theme）**：
   $$\alpha_{composite} = 0.035 + 0.035 \times (1 - 0.035) = 0.035 + 0.033775 = \mathbf{6.88\%}$$
   - 系统设计的单层悬停为 **3.50%**；
   - 系统设计的点击激活态 `--tint-active` 为 **6.50%**；
   - **合成结果 6.88% 已经超越了激活态！** 在暗色背景下形成极其扎眼的灰白光斑。

---

### 2.3 为什么“有的很灰”？——三种状态灰度分裂与跳闪分析

```
现场三种状态灰度割裂示意图：

1. 未展开折叠项悬停（双重叠加）
┌─────────────────────────────────────────────────────────────┐
│ .accordionItem:hover (2.5% 底灰)                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ .fileItem:hover (2.5% 顶灰)                           │  │ => 【合成 4.94% 脏深灰】
│  │  src/App.tsx                                  +12  -3 │  │    （用户感官：“太灰了！”）
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

2. 已展开激活项悬停（底板盖死）
┌─────────────────────────────────────────────────────────────┐
│ .accordionActive:hover (background: var(--bg-card) 纯白压死)│ => 强行遮蔽父级 2.5%
│  ┌───────────────────────────────────────────────────────┐  │
│  │ .fileItem.isActive (background: var(--bg-active))     │  │ => 【单层 5.0% 干净底色】
│  │  src/DiffCard.tsx                             +20  -4 │  │    （用户感官：“这里挺正常”）
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

3. 划向右侧快捷操作按钮（瞬态撕裂）
┌─────────────────────────────────────────────────────────────┐
│ .accordionItem:hover (2.5% 底灰依然保持)                    │ => 仅剩父级 2.5%
│  ┌────────────────────────┐  ┌───────────────────────────┐  │
│  │ .fileItem (光标移出灭) │  │ .hoverActBtn (无背景)      │  │ => 【骤降为 2.5% 微灰】
│  │  src/App.tsx           │  │  [Stage]  [Discard] [Diff]│  │    从 4.94% 突变到 2.5%，
│  └────────────────────────┘  └───────────────────────────┘  │    左侧文件名区域产生剧烈频闪！
└─────────────────────────────────────────────────────────────┘
```

根治方案：**彻底剥离外层容器的所有 hover 状态，使背景高亮完全且仅由交互行掌控**。

---

### 2.4 单一真理 Hover 交互层级（SLoHT）架构契约

为保证 UI 架构的净收敛与零歧义，本方案确立**单一真理 Hover 交互层级（Single Layer of Hover Truth, SLoHT）**：

| 层级名称 | 对应选择器 / DOM 实体 | 背景色契约 (SSOT) | 悬停态表现 | 激活/选中态表现 | 架构职责定义 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **容器/骨架层**<br>(Wrapper Layer) | `.fileList`<br>`.flatFileList`<br>`.accordionItem`<br>`.fileRowContainer`<br>`.accordionHeaderRow` | **强制锁定：**<br>`background: transparent;` | **严禁任何背景变化**<br>（物理删除 `:hover` 规则） | 展开内容区显示代码背景 `var(--bg-card)` | 仅负责 Flex/Grid 排版与几何布局，绝对不参与任何视觉状态绘制。 |
| **交互行实体**<br>(Interactive Row) | `.fileItem`<br>`.flatFileRow` | **默认：**<br>`background: transparent;` | **唯一真源：**<br>`background-color: var(--bg-hover);` | **唯一真源：**<br>`background-color: var(--bg-active);` | 唯一拥有光标焦点、悬停与按下激活权力的视觉单元，整行背景通栏响应。 |
| **行内操作元**<br>(Inline Actions) | `.hoverActions`<br>`.hoverActBtn`<br>`.groupActionBtn` | **强制锁定：**<br>`background: transparent;` | **背景保持透明**，仅改变文本色与细微边框 | 按下时微调透明度，无独立填充色块 | 寄居于交互行内部，完全透出交互行的单一背景色，杜绝局部色块。 |

---

## 三、容器与行级样式重构规则（彻底切断父级 hover）

### 3.1 物理切断：彻底移除父级容器与包装层的 :hover 背景规则

在 [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css) 中，物理删除导致双重叠加与修补盖底的规则段落：

#### 拟物理删除规则（Before vs After）：

```css
/* ==========================================================================
 * 🔴 物理删除：DiffCard.module.css:204-206（父级违章 Hover）
 * ========================================================================== */
/* BEFORE (删除前): */
.accordionItem:hover {
  background-color: var(--bg-hover);
}

/* AFTER (删除后):
 * 整段删除！父级外壳不再响应鼠标悬停，彻底消灭 Layer 1 复合层。
 */

/* ==========================================================================
 * 🔴 物理删除：DiffCard.module.css:214-221（修补式盖底代码）
 * ========================================================================== */
/* BEFORE (删除前): */
.accordionActive:hover {
  background: var(--bg-card);
  border-color: color-mix(
    in srgb,
    var(--border-color, var(--border-subtle)) 90%,
    var(--text-primary) 10%
  );
}

/* AFTER (删除后):
 * 整段删除！平直列表与展开卡片均无需再通过强行压底色来掩盖父级悬停。
 */
```

---

### 3.2 容器与外包装层强制锁定透明背景

重构容器类选择器，确保在全生命周期内保持 `background: transparent`：

```css
/* 容器与外壳骨架：保持绝对纯净 */
.accordionItem,
.flatFileItem,
.fileRowContainer {
  display: flex;
  flex-direction: column;
  width: 100%;
  background: transparent;
  border: none;
  border-radius: 0;
  box-sizing: border-box;
}

/* 头部包裹行：仅作定位锚点，无背景渲染 */
.accordionHeaderRow,
.flatFileHeaderRow {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  background: transparent;
}
```

---

### 3.3 交互行独占单层 Hover / Active 样式真源

将所有悬停交互完全收敛至交互行类名（`.fileItem` 与平直模式 `.flatFileRow`）：

```css
/* 交互行唯一真源规范 */
.accordionItem :global(.fileItem),
.accordionItem .fileItem,
.flatFileRow {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 8px 12px;
  margin: 0;
  text-align: left;
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
  box-sizing: border-box;
  transition: background-color var(--transition-fast);
}

/* 唯一的 Hover 真源（严格单层：Light 2.5% / Dark 3.5%） */
.accordionItem :global(.fileItem):hover,
.accordionItem .fileItem:hover,
.flatFileRow:hover {
  background-color: var(--bg-hover);
}

/* 唯一的 Active 真源（严格单层：Light 5.0% / Dark 6.5%） */
.accordionItem :global(.fileItem).isActive,
.accordionItem .fileItem.isActive,
.flatFileRow.isActive {
  background-color: var(--bg-active);
  border-bottom: 1px solid var(--border-subtle);
}
```

---

### 3.4 行内操作按钮防闪烁与透明度继承规范

为根除鼠标划入右侧按钮时的透明度骤降与撕裂感，行内快捷按钮必须维持完全透明，仅通过文字颜色与细微边框反馈交互：

```css
/* Git 快捷操作按钮组（浮动于行内右侧） */
.hoverActions {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-1_5);
  background: transparent; /* 始终透明 */
  padding: 0;
  border: none;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity var(--transition-micro);
}

/* 当父级行被悬停或内部聚焦时自然浮现 */
.accordionHeaderRow:hover .hoverActions,
.accordionHeaderRow:focus-within .hoverActions,
.flatFileRow:hover .hoverActions,
.flatFileRow:focus-within .hoverActions {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

/* 单个操作按钮：无背景色，透出整行的 var(--bg-hover) */
.hoverActBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  border: 1px solid transparent;
  background: transparent; /* 绝不声明独立色块 */
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    border-color var(--transition-micro),
    color var(--transition-micro);
}

/* 悬停仅微调前景色，背景始终透光 */
.hoverActBtn:hover {
  color: var(--text-primary);
  border-color: var(--border-subtle);
  background: transparent;
}

/* 危险操作（如放弃修改/回滚）悬停 */
.hoverActBtn.danger:hover {
  color: var(--color-error);
  border-color: var(--color-error-border);
  background: transparent;
}
```

---

## 四、13 处裸写色值与 6 处幽灵 Token 全量替换契约表

### 4.1 13 处硬编码 Hex 色值全量替换矩阵

经过全域扫描，差异面板组件中存在 **11 处 CSS 裸写色值** 与 **1 处 TSX 行内裸写色值**，加上 **1 处违章旧蓝**，共计 13 处硬编码坏味道。全量替换契约如下：

| 序号 | 现场文件与精确行号 | 现场违规代码片段 | 标准 Design Token (SSOT) | Light 实际解析值 | Dark 实际解析值 | 治理原因与语义角色 |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | [`DiffCard.module.css:14`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L14) | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 差异面板主容器底色，移除无意义 `#ffffff` 兜底，防止暗色模式偶发纯白穿透。 |
| **2** | [`DiffCard.module.css:29`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L29) | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 紧凑工具栏底色，统一收敛为卡片标准背景。 |
| **3** | [`DiffCard.module.css:140`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L140) | `background: color-mix(in srgb, var(--accent-red, #ef4444) 10%, var(--bg-card));` | `background: var(--color-error-bg);` | `var(--accent-red-light)` | `var(--accent-red-light)` | 错误横幅背景，使用系统权威语义错误背景令牌，消除 Tailwind 裸色 `#ef4444`。 |
| **4** | [`DiffCard.module.css:141`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L141) | `border-bottom: 1px solid color-mix(in srgb, var(--accent-red, #ef4444) 25%, transparent);` | `border-bottom: 1px solid var(--color-error-border);` | `color-mix(var(--accent-red) 25%, transparent)` | `color-mix(var(--accent-red) 25%, transparent)` | 错误横幅底边框，使用系统错误边框令牌。 |
| **5** | [`DiffCard.module.css:142`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L142) | `color: var(--accent-red, #ef4444);` | `color: var(--color-error);` | `var(--accent-red)` | `var(--accent-red)` | 错误横幅前景色，使用系统错误文本色。 |
| **6** | [`DiffCard.module.css:169`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L169) | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 差异面板主工作区外壳，收敛为 `var(--bg-card)`。 |
| **7** | [`DiffCard.module.css:280`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L280) | `color: var(--accent-blue);` | `color: var(--md-link-color);` | `var(--brand-deep, #059669)` | `var(--brand, #10b981)` | 文件名链接高亮，斩断违规旧蓝，回归 Conex Zero-Blue 翡翠绿规范。 |
| **8** | [`DiffCard.module.css:446`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L446) | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 代码比对视口滚动容器，清退幽灵变量与 `#ffffff`。 |
| **9** | [`DiffCard.module.css:462`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L462) | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 源码查看器滚动父容器，清退幽灵变量与 `#ffffff`。 |
| **10** | [`DiffCard.module.css:476`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L476) | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 比对行行容器，清退幽灵变量与 `#ffffff`。 |
| **11** | [`DiffCard.module.css:730`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L730) | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | Git Commit 提交信息输入框底色，清退幽灵变量与 `#ffffff`。 |
| **12** | [`DiffCard.module.css:845`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L845) | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 差异面板空状态容器底色，移除 `#ffffff` 兜底。 |
| **13** | [`VirtualPlainCodeViewer.tsx:65`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx#L65) | `background: 'var(--diff-bg-pane, #ffffff)',` | `background: 'var(--bg-card)',` | `hsl(0 0% 100%)` | `#242424` | TSX 行内样式，拔除幽灵变量与硬编码 `#ffffff`。 |

---

### 4.2 6 处幽灵 Token 清剿与收敛契约

在当前代码中消费但并未在权威令牌库 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中声明的“幽灵变量”及其处置方案：

1. **`--diff-bg-pane`（消费 5 次）**：
   - **定性**：原计划作为代码视图底板色，由于从未在 `tokens.css` 注册，在所有暗色模式下均回退到纯白 `#ffffff`，造成毁灭性的暗色亮瞎白屏 Bug！
   - **收敛方案**：全面收敛为 `var(--bg-card)`，彻底注销该变量名。
2. **`--diff-gutter-fg`（消费 1 次）**（[`DiffCard.module.css:498`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L498)）：
   - **定性**：代码行号列前景色，`tokens.css` 中实际注册的是 `--diff-linenum-fg`（line 608: `var(--text-tertiary, #696969)`）。
   - **收敛方案**：修正为 `var(--diff-linenum-fg, var(--text-tertiary))`，消除未对齐命名。
3. **`--diff-text-normal`（消费 2 次）**（[`DiffCard.module.css:523, 552`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L523)）：
   - **定性**：无变动普通代码行前景色，`tokens.css` 中未独立定义。
   - **收敛方案**：直接使用系统标准前景色 `var(--text-primary)`。
4. **`--diff-gutter-width-unified`（消费 2 次）**（[`DiffCard.module.css:484`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L484)）：
   - **定性**：Unified 视图双列行号宽（每列 40px），未在 token 中定义。
   - **收敛方案**：统一规范化为固定标尺 `40px` 或局部常量 `--diff-unified-gutter-w: 40px`。
5. **`--diff-gutter-width-split`（消费 1 次）**（[`DiffCard.module.css:590`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L590)）：
   - **定性**：Split 分栏视图单列行号宽（36px），未在 token 中定义。
   - **收敛方案**：统一规范化为固定标尺 `36px`。
6. **`--diff-gutter-marker-width`（消费 2 次）**（[`DiffCard.module.css:484, 590`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L484)）：
   - **定性**：增删符号（`+` / `-`）指示列宽（20px），未在 token 中定义。
   - **收敛方案**：统一规范化为固定标尺 `20px`。

---

### 4.3 Zero-Blue 铁律与 Emerald Green 品牌超链接规范

Conex 项目秉承严格的 **Zero-Blue** 设计哲学，杜绝通用平庸的网页默认蓝色，全仓采用极具辨识度的翡翠绿（Emerald Green）作为品牌活动色与超链接色。

在 [`DiffCard.module.css:280`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L280) 中：
```css
/* ❌ 违章遗留代码 */
.fileNameLink:hover {
  text-decoration: underline;
  color: var(--accent-blue);
}

/* ✅ 规范化重构代码 */
.fileNameLink:hover {
  text-decoration: underline;
  color: var(--md-link-color); /* 翡翠绿：Light #059669 / Dark #10b981 */
}
```
此项改动使得差异面板的文件名链接悬停态与全仓 Markdown、设置面板、终端超链接完全一致。

---

### 4.4 私有魔术混入比收敛（4% -> var(--control-soft-bg-hover)）

在 [`DiffCard.module.css:658`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L658) 中：
```css
/* ❌ 违章遗留私有魔术混入比 (4%) */
.commitTriggerBar:hover {
  background: color-mix(in srgb, var(--text-primary) 4%, var(--bg-secondary));
  border-color: var(--border-color);
}

/* ✅ 规范化重构代码（对齐系统控件轻悬停标准） */
.commitTriggerBar:hover {
  background: var(--control-soft-bg-hover); /* tokens.css:148 / 873 标准令牌 */
  border-color: var(--border-color);
}
```

---

## 五、AGENTS.md §13-14 色彩与对比度科学验证断言

### 5.1 AGENTS.md §13 焦点与激活态刚性断言

根据 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13「UI：输入框与焦点态」的刚性约束：

1. **默认不要重阴影**：
   - 输入框、搜索框、列表行默认不得包含任何粗重 `box-shadow`。
2. **克制的激活边框与无粗黑边铁律**：
   - 激活与聚焦时**严禁**粗、深、实心黑边（例如直接使用 `var(--text-primary)` 或厚重 `0 0 0 1px` 黑环）。
3. **焦点对比度上限约 10%**：
   - 边框相对基线的加深混入文本色不超过约 **10%**（例如 `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)` 为上限量级）；
   - 常规交互优先约 **2.5%–6%** 混入以保持柔和质感。

#### 差异面板焦点与交互态对齐验证表：

| 组件 / 元素 | 状态 | 规范 CSS 实现 | 文本混入度 | 是否符合 §13 铁律 |
| :--- | :--- | :--- | :---: | :---: |
| **文件行悬停** (`.fileItem:hover`) | 悬停 (Hover) | `background-color: var(--bg-hover);` | Light 2.5% / Dark 3.5% | ✅ **完美符合**（处于 2.5%~3.5% 柔和透光区间） |
| **文件行激活** (`.fileItem.isActive`) | 激活 (Active) | `background-color: var(--bg-active);` | Light 5.0% / Dark 6.5% | ✅ **完美符合**（远低于 10% 刚性硬顶） |
| **Commit 输入框** (`.commitInput`) | 聚焦 (Focus) | `border-color: var(--focus-border-color);`<br>`box-shadow: var(--focus-ring-shadow);` | 边框 10% 混入 / 外环 6% 柔灰 | ✅ **完美符合**（严格遵循 focus-visible 规范） |

---

### 5.2 形态 ④：Diff 搜索筛选框（纯光标极简型）刚性落地

根据 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13 关于内联浮层与卡片顶栏筛选框的专门要求：
> “*全态只有光标闪烁，其他什么变化也没有！严禁边框、描边与聚焦阴影。*”

在 [`DiffCard.module.css:119-132`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L119-L132) 中已实现的形态 ④ 规则必须作为永久基线刚性锁定：

```css
/* 形态 ④：Diff 搜索筛选框（纯光标极简型）
 * 全态只有光标闪烁，其他什么变化也没有！彻底消除边框、深黑描边与聚焦投影 */
.searchInput,
.searchInput:focus,
.searchInput:focus-visible {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  outline: none;
  box-shadow: none;
  box-sizing: border-box;
}
```

任何试图为 `.searchInput` 添加 `border`、`outline` 或 `box-shadow` 的改动均被防回归门禁直接拦截。

---

### 5.3 AGENTS.md §14 现代 CSS 与色彩空间断言

根据 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §14「色彩空间与现代 CSS 语法」：
1. **优先 HSLA / 斜杠透明度**：避免散落旧式 `rgba(r,g,b,a)`；UI 与 Design Token 优先 `hsl(h s l / a)` 或 `hsla(...)`，用斜杠 `/` 分隔不透明度；
2. **感知均匀渐变与色彩混配**：采用现代 `color-mix(in srgb, ...)` 进行层次演化；
3. **零裸写硬编码十六进制**：业务样式表内禁止出现裸写十六进制。

本方案在重构完成后，`DiffCard.module.css` 中将实现：
- **`rgba()` 数量**：**0**；
- **裸写 `#hex` 数量**：**0**（11 处全部清除）；
- **所有颜色全部走 Tokens 或 `color-mix(in srgb, ...)`**。

---

### 5.4 视觉对比度金字塔与科学光学梯次（WCAG AAA/AA 刚性达标）

为确保开发者在长时间比对代码时不产生视觉刺痛与认知负荷，系统构建了清晰的**光学对比度金字塔**：

```
光学对比度金字塔：
▲
│ [高强对比] 增删代码文字 (Add/Del Text): 6.75:1 ~ 9.46:1 (WCAG AAA 刚性阅读保障)
│ [中度对比] 行内词法差异 (Word Diff): 20% ~ 30% 饱和度遮罩 (精准锁定字符修改)
│ [低度对比] 增删整行背景 (Line Diff): 7% ~ 12% 极淡水彩透染 (大面积阅读无压迫)
│ [微量对比] 文件行悬停 (Row Hover): 2.5% ~ 3.5% 墨印微透 (灵动交互，界面静谧)
▼
```

#### 科学对比度实测矩阵表：

| 视觉元素 | 前景色 Token | 背景色 Token | 浅色对比度 (Light) | 暗色对比度 (Dark) | WCAG 评级与体验定性 |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **文件行悬停** | `var(--text-primary)` | `var(--bg-hover)` | **17.5 : 1** | **12.2 : 1** | 🟢 **WCAG AAA**<br>微透墨印，光标掠过如同指尖划过宣纸，绝无突兀黑斑。 |
| **常规代码行** | `var(--text-primary)` | `var(--bg-card)` | **18.5 : 1** | **13.0 : 1** | 🟢 **WCAG AAA**<br>纯净卡片底板，代码字符黑白分明，边缘清晰锐利。 |
| **新增代码行** | `var(--diff-add-fg)` | `var(--diff-add-bg)` | **6.75 : 1** | **9.46 : 1** | 🟢 **WCAG AAA**<br>7% 水彩翡翠绿底板避免大段新增代码刺眼，高对比前景保证易读。 |
| **删除代码行** | `var(--diff-del-fg)` | `var(--diff-del-bg)` | **7.01 : 1** | **7.21 : 1** | 🟢 **WCAG AAA**<br>7% 沉稳玫瑰粉底板，深绯红文字边缘分明，有效杜绝眼部疲劳。 |
| **词法级变动** | 继承增删行前景 | `var(--diff-*-word-bg)` | **4.8 : 1** (相对行底) | **5.2 : 1** (相对行底) | 🟢 **WCAG AA**<br>词法级改动精准凸显，变量与语法差异一目了然。 |

---

## 六、样式层删除面清单与防回归自动化门禁设计

### 6.1 拟物理删除与修改的样式代码清单（精确至行号）

#### 1. 物理删除项（彻底剔除，净减行数）：
- [`DiffCard.module.css:204-206`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L204-L206)：
  ```css
  /* 🔴 物理删除：导致双重叠加脏灰的父级 hover */
  .accordionItem:hover {
    background-color: var(--bg-hover);
  }
  ```
- [`DiffCard.module.css:90-104`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L90-L104)：
  ```css
  /* 🔴 物理删除：存量死代码，已被 DiffHeaderControls 原子按钮替换 */
  .actionBtn { ... }
  .actionBtn:hover { ... }
  ```
- [`DiffCard.module.css:214-221`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L214-L221)：
  ```css
  /* 🔴 物理删除：手风琴展开卡片修补式盖底代码 */
  .accordionActive:hover {
    background: var(--bg-card);
    border-color: color-mix(...);
  }
  ```

#### 2. 原位替换项（去硬编码与规范化）：
- [`DiffCard.module.css:14, 29, 169, 845`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L14)：
  - 修改前：`background: var(--bg-card, #ffffff);`
  - 修改后：`background: var(--bg-card);`
- [`DiffCard.module.css:140-142`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L140-L142)：
  - 修改前：
    ```css
    background: color-mix(in srgb, var(--accent-red, #ef4444) 10%, var(--bg-card));
    border-bottom: 1px solid color-mix(in srgb, var(--accent-red, #ef4444) 25%, transparent);
    color: var(--accent-red, #ef4444);
    ```
  - 修改后：
    ```css
    background: var(--color-error-bg);
    border-bottom: 1px solid var(--color-error-border);
    color: var(--color-error);
    ```
- [`DiffCard.module.css:280`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L280)：
  - 修改前：`color: var(--accent-blue);`
  - 修改后：`color: var(--md-link-color);`
- [`DiffCard.module.css:446, 462, 476, 730`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L446)：
  - 修改前：`background: var(--diff-bg-pane, #ffffff);`
  - 修改后：`background: var(--bg-card);`
- [`DiffCard.module.css:658`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L658)：
  - 修改前：`background: color-mix(in srgb, var(--text-primary) 4%, var(--bg-secondary));`
  - 修改后：`background: var(--control-soft-bg-hover);`
- [`VirtualPlainCodeViewer.tsx:65`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx#L65)：
  - 修改前：`background: 'var(--diff-bg-pane, #ffffff)'`
  - 修改后：`background: 'var(--bg-card)'`

---

### 6.2 代码净收敛与重构指标评估表

| 治理维度 | 涉及行数 / 规则实体 | 治理手段 | 架构净收敛效果 |
| :--- | :---: | :--- | :--- |
| **双重 Hover 根因拔除** | 3 行 | 物理删除 `.accordionItem:hover` | **净减 3 行**，彻底切断 Alpha 双重叠加 |
| **死代码与修补盖底清退** | 23 行 | 物理删除 `.actionBtn` 与 `.accordionActive:hover` | **净减 23 行**，消除存量死规则 |
| **硬编码十六进制拔除** | 13 处声明 | 统一换装权威 Tokens（`--bg-card` 等） | **消除 13 处坏味道**，实现 100% Token 化 |
| **幽灵 Token 彻底注销** | 5 处引用 | 收敛 `--diff-bg-pane` 至 `--bg-card` | **根除深色模式暗夜闪白重大缺陷** |
| **Zero-Blue 规范对齐** | 1 处规则 | 换装 `--md-link-color` 翡翠绿 | **全仓品牌色完全统一** |
| **魔术混入比收敛** | 1 处规则 | 换装 `--control-soft-bg-hover` | **对齐全仓 2.5%/3.5% 柔和焦点规范** |
| **总体净收益** | **约 46 行受影响** | **纯净 CSS 重构，零 hack、零 !important** | **CSS 净减少约 26 行，架构完全收敛** |

---

### 6.3 style-contract 自动化防回归门禁测试设计

在 [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts) 中植入针对差异面板的专项防回归测试集，利用静态文件读取与正则断言守门：

```ts
describe('差异面板样式系统与 Design Tokens 刚性契约（PLAN-04 专项门禁）', () => {
  const diffCss = readFile('src/components/diff/DiffCard.module.css');
  const viewerTsx = readFile('src/components/diff/VirtualPlainCodeViewer.tsx');

  it('刚性门禁 1：父级容器与包装层严禁声明任何 :hover 背景色规则', () => {
    // 拦截任何对容器/外壳的 :hover 背景注入
    const invalidHoverRe = /\.(accordionItem|flatFileList|fileList|groupItemsContainer|accordionHeaderRow):hover\s*\{[^}]*background/g;
    const violations = diffCss.match(invalidHoverRe) ?? [];
    expect(violations, `发现违章父级容器 hover 背景规则：${violations.join('; ')}`).toEqual([]);
  });

  it('刚性门禁 2：DiffCard.module.css 绝无任何裸写十六进制硬编码色值', () => {
    // 拦截任何裸写 #hex，排除注释
    const linesWithoutComments = diffCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const bareHexMatches = linesWithoutComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(bareHexMatches, `DiffCard.module.css 存在裸写十六进制色值：${bareHexMatches.join(', ')}`).toEqual([]);
  });

  it('刚性门禁 3：彻底注销 --diff-bg-pane 幽灵 Token，零引用', () => {
    expect(diffCss).not.toContain('--diff-bg-pane');
    expect(viewerTsx).not.toContain('--diff-bg-pane');
  });

  it('刚性门禁 4：Zero-Blue 刚性守门，严禁使用 --accent-blue 旧蓝别名', () => {
    expect(diffCss).not.toContain('--accent-blue');
  });

  it('刚性门禁 5：搜索筛选框严格落实形态 ④（纯光标极简型，无边框与聚焦投影）', () => {
    const searchBlock = diffCss.match(/\.searchInput[^{]*\{([^}]+)\}/);
    expect(searchBlock, '必须存在 .searchInput 规则').toBeTruthy();
    const body = searchBlock![1];
    expect(body).toContain('border: none');
    expect(body).toContain('outline: none');
    expect(body).toContain('box-shadow: none');
  });
});
```

---

### 6.4 实施推进顺序与反退避守则

在后续阶段（阶段三：方案执行）中，将严格遵循以下执行次序：

```
[步骤 1: Token 规范化] 替换 13 处裸写 Hex 与 6 处幽灵 Token，换装 --bg-card 与 --md-link-color
       │
       ▼
[步骤 2: 物理切断] 物理删除 .accordionItem:hover 与 .accordionActive:hover
       │
       ▼
[步骤 3: 交互行独占] 确立 .fileItem / .flatFileRow 为唯一 hover 响应实体
       │
       ▼
[步骤 4: 门禁注入] 将 5 项刚性断言注入 style-contract.test.ts 并运行全量验证
       │
       ▼
[步骤 5: 验证收口] 执行 npm run test:coverage -- --project=unit 与 npm run typecheck
```

**反退避守则（严格遵守）**：
- 任何情况下不得因特异性不足而使用 `!important`；
- 任何情况下不得为了保留某些视觉效果而重加父级 hover；
- 保持所有改动在工作区，提交权移交主 Agent。
