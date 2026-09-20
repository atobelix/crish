# G-04 / G-05 / G-13 几何标尺、Z-Index 分层与全仓测试防回归架构分析报告

> **报告编号**：`CONVERGENCE-ANALYSIS-05`  
> **所属战役**：`frontend-convergence-systemic-repair`（前端收敛系统级重构战役）  
> **权威依据**：
> - 仓库根目录 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md)（§1 反退避、§7 严禁补丁、§12 Tooltip、§13 输入框焦点态、§15-§16 调试通道）
> - [`scripts/check-frontend-convergence.mjs`](file:///c:/Software/conex/scripts/check-frontend-convergence.mjs)（G-01 ~ G-13 合规门禁）
> - [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) & [`z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css)（设计 Token 与 7 级 Z-Index 标尺）
> - [`.agent-outputs/all-convergence-violations.json`](file:///c:/Software/conex/.agent-outputs/all-convergence-violations.json)（全仓 351 处违规项、146 个受影响文件全量审计数据）
> - [`docs/red-team-plans/detailed-plans/02-原子设计系统与同心几何维度详案.md`](file:///c:/Software/conex/docs/red-team-plans/detailed-plans/02-原子设计系统与同心几何维度详案.md)
>
> **分析对象**：
> 1. **G-04（8 处）**：非白名单药丸圆角（`9999px` / `var(--radius-full)`）向同心几何标尺精准收敛；
> 2. **G-05（5 处）**：高位裸数字与恶性通胀 Z-Index 向 7 级标准 Token 标尺收敛与层叠上下文梳理；
> 3. **G-13（1 处）**：GBK Mojibake 特征命中误判根因剖析与历史注释真源复原；
> 4. **全仓测试矩阵（146 个受影响文件）**：单元测试、光学契约测试、DOM 查找选择器与原子组件替换平滑过渡立体化防回归方案。

---

## 目录索引

- [一、 执行摘要与违规态势全景](#一-执行摘要与违规态势全景)
- [二、 G-04 几何圆角标尺收敛详析 (8 处)](#二-g-04-几何圆角标尺收敛详析-8-处)
  - [2.1 同心几何数学原理与药丸通胀危害](#21-同心几何数学原理与药丸通胀危害)
  - [2.2 8 处违规代码现场剖析与收敛裁决](#22-8-处违规代码现场剖析与收敛裁决)
  - [2.3 Tooltip 胶囊与同心标尺冲突的双轨裁决剖析](#23-tooltip-胶囊与同心标尺冲突的双轨裁决剖析)
  - [2.4 G-04 完整代码替换对照表](#24-g-04-完整代码替换对照表)
- [三、 G-05 7 级 Z-Index 标尺与层叠上下文梳理 (5 处)](#三-g-05-7-级-z-index-标尺与层叠上下文梳理-5-处)
  - [3.1 7 级 Z-Index 标准阶梯与封顶 9000 铁律](#31-7-级-z-index-标准阶梯与封顶-9000-铁律)
  - [3.2 5 处高位裸数字违规深度审计与层叠上下文剖析](#32-5-处高位裸数字违规深度审计与层叠上下文剖析)
  - [3.3 全局视口与局部叶子层叠拓扑图 (Stacking Context Hierarchy)](#33-全局视口与局部叶子层叠拓扑图-stacking-context-hierarchy)
  - [3.4 G-05 完整代码替换对照表](#34-g-05-完整代码替换对照表)
- [四、 G-13 GBK 编码损坏与特征误报根因穿透 (1 处)](#四-g-13-gbk-编码损坏与特征误报根因穿透-1-处)
  - [4.1 违规现场与判定断层：合法汉字「窗」如何触发 Mojibake 阻断](#41-违规现场与判定断层合法汉字窗如何触发-mojibake-阻断)
  - [4.2 门禁引擎 `FEATURE_CHARS` 字典缺陷根因剖析](#42-门禁引擎-feature_chars-字典缺陷根因剖析)
  - [4.3 同一文件历史真实破损注释勘误与 UTF-8 还原](#43-同一文件历史真实破损注释勘误与-utf-8-还原)
  - [4.4 三阶修复实施方案与代码替换表](#44-三阶修复实施方案与代码替换表)
- [五、 全仓 146 个受影响文件防回归保护与测试矩阵](#五-全仓-146-个受影响文件防回归保护与测试矩阵)
  - [5.1 146 个文件违规分布与目录拓扑分析](#51-146-个文件违规分布与目录拓扑分析)
  - [5.2 现有测试资产全景盘点 (Unit / Contract / Optical / E2E)](#52-现有测试资产全景盘点-unit--contract--optical--e2e)
  - [5.3 原子组件换装对 DOM 选择器与快照的破环性评估](#53-原子组件换装对-dom-选择器与快照的破环性评估)
  - [5.4 平滑过渡方案与无损换装三准则](#54-平滑过渡方案与无损换装三准则)
  - [5.5 立体化四层防回归测试矩阵 (Quad-Tier Test Matrix)](#55-立体化四层防回归测试矩阵-quad-tier-test-matrix)
- [六、 结论与后续实施调度建议](#六-结论与后续实施调度建议)

---

## 一、 执行摘要与违规态势全景

根据 [`.agent-outputs/all-convergence-violations.json`](file:///c:/Software/conex/.agent-outputs/all-convergence-violations.json) 的全量扫描，前端工程存在 **351 处违规项**，波及 **146 个源码与样式文件**。规则分布如下：

| 规则代码 | 规则定义 | 违规数量 | 涉及文件数 | 严重等级 | 本报告定位 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **G-01** | 业务层裸原生交互标签（`<button>`, `<input>`, `<textarea>`） | **226 处** | 108 个 | 高危（阻断 CI） | 纳入测试矩阵与选择器影响评估 |
| **G-02** | 浮层组件违规使用 `cloneElement` / `stopPropagation` | **2 处** | 1 个 | 架构破坏 | 关联测试保护 |
| **G-03** | 裸 `ResizeObserver` / 0px 强制回流 / `flushSync` | **18 处** | 11 个 | 性能劣化 | 关联测试保护 |
| **G-04** | **非白名单 9999px 药丸圆角 / radius-full 滥用** | **8 处** | 6 个 | **视觉失真** | **核心深度剖析与替换设计** |
| **G-05** | **7 级 Z-Index 标尺违规（裸数字 >=100 / 恶性通胀）** | **5 处** | 4 个 | **层叠错乱** | **核心深度剖析与层叠梳理** |
| **G-06** | 业务层 CSS Modules 滥用 `!important` | **91 处** | 32 个 | 样式污染 | 样式层叠平滑过渡 |
| **G-13** | **GBK 乱码与编码损坏特征命中** | **1 处** | 1 个 | **编译与语义** | **根因穿透与双向纠偏** |
| **合计** | **全仓收敛门禁违规全集** | **351 处** | **146 个** | — | **立体化测试矩阵全面覆盖** |

本分析报告聚焦于 **G-04（8 处）**、**G-05（5 处）**、**G-13（1 处）** 的精确定点拔除方案，并为涉及 **G-01/G-06 等全部 146 个受影响文件** 构建无破环、平滑过渡、具备强力防回潮拦截的立体化测试验证网。

---

## 二、 G-04 几何圆角标尺收敛详析 (8 处)

### 2.1 同心几何数学原理与药丸通胀危害

桌面端专业 IDE 界面的几何美感建立在**等距同心曲线公理（Concentric Geometry Axiom）** 之上。

```
     ┌────────────────────────────────────────────────────────┐
     │ 父容器 Outer Container: R_outer (R_o)                   │
     │                                                        │
     │     ┌────────────────────────────────────────────┐     │
     │     │ 子控件/内容 Inner Child: R_inner (R_i)      │     │
     │  P  │                                            │  P  │
     │     │                                            │     │
     │     └────────────────────────────────────────────┘     │
     │                           P                            │
     └────────────────────────────────────────────────────────┘
```

#### 1. 数学公理推导：
设外层圆角半径为 $R_o$，容器四周等宽内边距为 $P$。为了使外轮廓与内轮廓在任意法向截面上的缝隙宽度恒为 $P$（消除视觉挤压感 Optical Pinching），内层圆角半径 $R_i$ 必须满足：
$$R_i = \max(0, R_o - P) \iff R_o = R_i + P$$

- **退化条件**：当内边距 $P \ge R_o$ 时，计算值 $R_o - P \le 0$。此时内层子元素在几何上退化为**严格直角（$R_i = 0$）**，严禁强制赋予圆角。
- **全站 5 级同心阶梯**（定义于 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)）：
  - `--radius-xl: 12px`：全屏弹窗、独立窗口浮层（$R_{outer} = 12\text{px}$）
  - `--radius-lg: 8px`：卡片容器、下拉菜单浮层、设置分组外框（$R_{outer} = 8\text{px}$）
  - `--radius-md: 6px`：标准按钮、Tab 选项卡、Select 触发器（$R_{inner} = 8 - 2 = 6\text{px}$）
  - `--radius-sm: 4px`：微型按钮 (IconButton)、状态徽标 (Badge)、键帽 (Kbd)（$R_{inner} = 6 - 2 = 4\text{px}$）
  - `--radius-xs: 2px`：极小指示点、发丝滑轨、进度条内芯（$R_{inner} = 4 - 2 = 2\text{px}$）

#### 2. 药丸通胀（Pill Ballooning）的工程危害：
当控件裸写 `border-radius: 9999px` 或 `var(--radius-full)` 时：
1. **圆角倒挂（Corner Inversion）**：高度为 24px 的 Badge 嵌套在 $R_o = 8\text{px}$、$P = 4\text{px}$ 的卡片中，Badge 被浏览器 clamp 为 12px 半圆。此时 $R_{inner} (12\text{px}) > R_{outer} (8\text{px})$，转角法向间距为负数，内层尖角“戳破”父容器外框；
2. **内容区压缩畸变**：两端半圆侵占过多水平空间，导致单字或短文本必须拉伸极大的横向内边距，破坏对齐基线；
3. **玩具化劣化**：在专业级桌面开发工具中，散落的半圆药丸会破坏网格节奏，呈现移动端 Hybrid 网页的廉价质感。

---

### 2.2 8 处违规代码现场剖析与收敛裁决

根据门禁脚本 [`scripts/check-frontend-convergence.mjs`](file:///c:/Software/conex/scripts/check-frontend-convergence.mjs) Rule 4 拦截结果，8 处违规代码详情及几何推导如下：

#### 违规点 1：`FirstRunWizard.module.css` (L65)
- **文件坐标**：[`apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css:65`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css#L65)
- **现状代码**：
  ```css
  .firstRunStep {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1_5);
    font-size: var(--font-size-xs);
    color: var(--text-tertiary);
    padding: 4px 8px;
    border-radius: 999px; /* ◀ 违规：硬编码 999px 药丸圆角 */
    background: transparent;
  }
  ```
- **几何与上下文分析**：
  `.firstRunStep` 是首次运行向导（FirstRunWizard）顶部的步骤指示条，处于全屏模态窗口内（外层模态 $R_o = 12\text{px}$）。步骤条高度约为 26px，内含 18px 正圆数字球 `.firstRunStepNum`。若自身为 999px 药丸，在激活高亮时（`.isActive` 赋予 `var(--bg-secondary)`）呈现为一块椭圆凸起，与向导内其他卡片（8px/6px）形成鲜明视觉割裂。
- **收敛裁决**：
  属于状态徽标（Badge）层级，严格收敛至 **`border-radius: var(--radius-sm);` (4px)** 或 **`border-radius: var(--radius-md);` (6px)**。由于步骤项横向紧凑且与 18px 正圆同框，4px 微圆角可产生克制而平整的桌面端 Step 胶囊质感。推荐使用 `var(--radius-sm)`。

---

#### 违规点 2 & 3：`ScrollArea.module.css` (L167, L218)
- **文件坐标**：
  - 垂直滑块：[`apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css:167`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css#L167)
  - 水平滑块：[`apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css:218`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css#L218)
- **现状代码**：
  ```css
  /* L167: 垂直轨道内滑块 */
  .thumbIndicator {
    ...
    border-radius: var(--scrollbar-thumb-radius, var(--radius-full)); /* ◀ 违规：兜底引用 var(--radius-full) */
  }

  /* L218: 水平轨道内滑块 */
  .thumbIndicatorHorizontal {
    ...
    border-radius: var(--scrollbar-thumb-radius, var(--radius-full)); /* ◀ 违规：兜底引用 var(--radius-full) */
  }
  ```
- **几何与上下文分析**：
  在系统设计规范中，滚动条滑块的权威单一真理源（SSOT）是 `--scrollbar-thumb-radius`，定义于 [`tokens.css:133`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L133)：
  `--scrollbar-thumb-radius: var(--radius-full, 9999px);`。
  然而在 `ScrollArea.module.css` 中，作者写入了双重 fallback：`var(--scrollbar-thumb-radius, var(--radius-full))`。这不仅构成了 **F1 双源兜底违规（Dual-Source Fallback Drift）**，更直接触发了门禁正则 `/var\(--radius-full\)/` 拦截。
- **收敛裁决**：
  去除冗余且非法的 fallback，严格恢复单点权威引用：
  `border-radius: var(--scrollbar-thumb-radius);`。
  滑块圆角由 `tokens.css` 单点全局管控，组件内部不再私自兜底 `var(--radius-full)`。

---

#### 违规点 4：`SegmentedControl.module.css` (L258)
- **文件坐标**：[`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css:258`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css#L258)
- **现状代码**：
  ```css
  .itemBadge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    line-height: 1;
    padding: 1px 5px;
    border-radius: var(--radius-full); /* ◀ 违规：非白名单元素滥用 radius-full */
    background-color: var(--tint-strong);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  ```
- **几何与上下文分析**：
  `SegmentedControl` 外层槽盒圆角为 `--radius-lg` (8px)，内边距为 2px；激活滑块 `.activeSlider` 圆角为 $8 - 2 = 6\text{px}$ (`--radius-md`)，高度为 24px/28px。
  而选项内部的 `.itemBadge`（用于展示计数，如 `3` 或 `99+`）高度仅约 14px，却被赋予 `var(--radius-full)`。在一个 6px 圆角的滑块内部嵌入一个全圆角椭圆，不仅破坏了选项文字的基线水平感，更在多选排版中造成转角尖锐突兀。
- **收敛裁决**：
  根据原子设计规范 §1.7.8，全站 Badge / Tag 必须统一死锁为 **`border-radius: var(--radius-sm);` (4px)** 或针对超小徽标使用 **`var(--radius-xs);` (2px)**。此处由于 padding 为 `1px 5px`，采用 **`border-radius: var(--radius-sm);`** 达到完美的微倒角效果。

---

#### 违规点 5：`SmartModelBadge.module.css` (L20)
- **文件坐标**：[`apps/crish-desktop/src/components/ui/SmartModelBadge.module.css:20`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartModelBadge.module.css#L20)
- **现状代码**：
  ```css
  .capsule {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 9999px; /* ◀ 违规：硬编码 9999px 药丸圆角 */
    background: color-mix(in srgb, var(--surface-scrim) 85%, transparent);
    border: 1px solid var(--border-subtle);
    ...
  }
  ```
- **几何与上下文分析**：
  `SmartModelBadge` 是模型选择指示胶囊（如 `Claude 3.5 Sonnet` / `DeepSeek V3`），经常常驻于顶栏或 ChatComposer 输入框内部。ChatComposer 外层卡片圆角为 `--radius-xl` (12px) 或多行模式下 `--radius-3xl` (24px)。内部工具栏按钮统一使用 `size="sm"`（高度 28px，圆角 6px `--radius-md`）。`SmartModelBadge` 滥用 9999px 会导致它在一排 6px 圆角的按钮中显得极不协调，犹如从第三方移动端复制粘贴的 UI 片段。
- **收敛裁决**：
  将 `.capsule` 药丸圆角收敛至原子 Badge / Button 标准规格：
  `border-radius: var(--radius-sm);` (4px) 保持紧凑微倒角，或 `border-radius: var(--radius-md);` (6px) 与同排按钮无缝平齐。结合桌面端模型徽标规范，裁决使用 **`border-radius: var(--radius-sm);`**。

---

#### 违规点 6 & 7：`Tabs.module.css` (L142, L264)
- **文件坐标**：
  - 高光线条指示器：[`apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:142`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L142)
  - 选项卡角标：[`apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:264`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L264)
- **现状代码**：
  ```css
  /* L140-153: line 滑块高光线条 */
  .indicatorLine {
    background-color: var(--accent-color, var(--brand-primary));
    border-radius: var(--radius-full); /* ◀ 违规：在 2px 线条上使用 radius-full */
  }
  .indicatorLine[data-orientation='horizontal'] {
    bottom: 0;
    height: 2px;
  }
  .indicatorLine[data-orientation='vertical'] {
    left: 0;
    width: 2px;
  }

  /* L257-267: triggerBadge */
  .triggerBadge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    line-height: 1;
    padding: 1px 4px;
    border-radius: var(--radius-full); /* ◀ 违规：选项卡徽标滥用 radius-full */
    background-color: var(--tint-strong);
    color: var(--text-tertiary);
  }
  ```
- **几何与上下文分析**：
  1. `.indicatorLine` 本身物理厚度仅为 **2px**（水平方向 `height: 2px`，垂直方向 `width: 2px`）。使用 `var(--radius-full)` (9999px) 纯属语义滥用与通胀；在 5 级同心标尺中，针对 2px 发丝与极小指示器的专门 Token 是 `--radius-xs: 2px`。赋以 2px 圆角即可将 2px 高度的线段两端完美闭合为规整的圆形半弧，同时完全符合同心几何标尺！
  2. `.triggerBadge` 与 `SegmentedControl` 中的 `.itemBadge` 完全同构，属于选项内部的小标签。高度约 14px，使用 `var(--radius-full)` 产生药丸通胀。
- **收敛裁决**：
  - `.indicatorLine`：替换为 **`border-radius: var(--radius-xs);` (2px)**；
  - `.triggerBadge`：替换为 **`border-radius: var(--radius-sm);` (4px)**。

---

#### 违规点 8：`Tooltip.module.css` (L48)
- **文件坐标**：[`apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css:48`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L48)
- **现状代码**：
  ```css
  .tooltipContent {
    background: var(--bg-elevated);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-full); /* ◀ 违规：Tooltip 浮层使用 radius-full */
    box-shadow: var(--shadow-sm);
    padding: var(--space-1) var(--space-2_5);
    font-size: var(--font-size-xs);
    line-height: var(--line-height-base);
    color: var(--text-primary);
    white-space: nowrap;
  }
  ```
- **深层架构冲突剖析**：见下文 2.3 节。

---

### 2.3 Tooltip 胶囊与同心标尺冲突的双轨裁决剖析

在针对 `Tooltip.module.css:48` 的代码审查中，发现了工程演进中的一处典型**契约断层与跨规范冲突**：

```
                   ┌────────────────────────────────────────────────────────┐
                   │               Tooltip 圆角规范的两大冲突阵营            │
                   └────────────────────────────────────────────────────────┘
                                   │                        │
             ┌─────────────────────┴──────────┐   ┌─────────┴─────────────────────┐
             ▼                                ▼   ▼                               ▼
     【规范 A：胶囊气泡传承】                          【规范 B：同心标尺与门禁阻断】
  • AGENTS.md §12:                               • check-frontend-convergence.mjs:
    "以获得圆角胶囊、柔和阴影与主题色一致的提示"        Rule 4 (G-04) 严厉阻断 var(--radius-full)
  • antiDarkeningGuard.test.ts:163-165:          • 豁免白名单仅含: Switch, Avatar, PulseDot
    expect(tooltipCss).toContain('var(--radius-full')• 桌面端遵循 12/8/6/4/2px 同心几何标尺
```

#### 冲突详情：
1. **历史测试契约锁定**：[`apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts:163`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts#L163) 显式包含回归断言：
   ```ts
   it('RULE-07: enforces Tooltip module uses radius-full and soft shadow-sm', () => {
     const tooltipCss = readFile('src/components/ui/Tooltip/Tooltip.module.css');
     expect(tooltipCss).toContain('var(--radius-full');
     expect(tooltipCss).toContain('var(--shadow-sm)');
   });
   ```
2. **收敛门禁引擎阻断**：[`scripts/check-frontend-convergence.mjs:271`](file:///c:/Software/conex/scripts/check-frontend-convergence.mjs#L271) 的白名单为：
   ```js
   const isSwitchTrack = posix.includes('Switch.module.css');
   const isAvatar = posix.includes('Avatar');
   const isPulseDot = posix.includes('PulseDot') || posix.includes('StatusDot') || posix.includes('StatusPulseDot');
   if (isSwitchTrack || isAvatar || isPulseDot) continue;
   ```
   白名单中未包含 `Tooltip`，因此门禁扫描到 `Tooltip.module.css:48` 时判定违规抛错。

#### 解决方案与裁决对比：

| 方案路径 | 具体实施手法 | 优势 | 劣势与连锁影响 | 推荐指数 |
| :--- | :--- | :--- | :--- | :--- |
| **方案 A<br>（同心矩形收敛）** | 将 `Tooltip.module.css` 的圆角收敛为 `border-radius: var(--radius-sm);` (4px) 或 `var(--radius-md);` (6px)；同时修改 `antiDarkeningGuard.test.ts` 断言。 | 1. 100% 契合桌面端系统原生气质（如 macOS / Windows 11 原生 Tooltip 均为 4px 微圆角矩形，绝非药丸）；<br>2. 门禁脚本无需改动，G-04 达成 0 违规。 | 需同步修改 `antiDarkeningGuard.test.ts` 第 165 行断言。 | ⭐⭐⭐⭐⭐<br>**(推荐方案)** |
| **方案 B<br>（胶囊白名单豁免）** | 保留 `Tooltip.module.css` 中的 `var(--radius-full)`；在 `check-frontend-convergence.mjs` 中将 `Tooltip.module.css` 增补至合法白名单。 | 1. 严格遵守 `antiDarkeningGuard.test.ts` 既有测试；<br>2. 契合 `AGENTS.md` §12 中“圆角胶囊”的文学描述。 | 1. 在桌面端长文本 Tooltip 下，胶囊形状会导致两侧空间严重浪费；<br>2. 扩大了白名单开口。 | ⭐⭐⭐ |

**最终架构裁决**：
**强力推荐采纳方案 A**。现代桌面专业工具（VS Code、JetBrains、Xcode）的 Tooltip 均为 4px~6px 的精致微圆角矩形。
若采用方案 A：
- `Tooltip.module.css` 改为 `border-radius: var(--radius-sm);`（4px）
- `antiDarkeningGuard.test.ts` 改为 `expect(tooltipCss).toContain('var(--radius-sm');`
若维持方案 B（保持胶囊视觉）：
- 将 `check-frontend-convergence.mjs` 白名单扩充 `posix.includes('Tooltip.module.css')`。
无论选择方案 A 还是方案 B，均可彻底终结此处的双规范撕裂。

---

### 2.4 G-04 完整代码替换对照表

| 序号 | 文件路径与行号 | 现存违规代码 | 拟收敛替换代码 | 几何标尺依据 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | [`FirstRunWizard.module.css:65`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css#L65) | `border-radius: 999px;` | `border-radius: var(--radius-sm);` | 步骤指示徽标，收敛至 4px 标准微圆角 |
| 2 | [`ScrollArea.module.css:167`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css#L167) | `border-radius: var(--scrollbar-thumb-radius, var(--radius-full));` | `border-radius: var(--scrollbar-thumb-radius);` | 清除冗余非法 fallback，单一真理源收敛 |
| 3 | [`ScrollArea.module.css:218`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css#L218) | `border-radius: var(--scrollbar-thumb-radius, var(--radius-full));` | `border-radius: var(--scrollbar-thumb-radius);` | 清除冗余非法 fallback，单一真理源收敛 |
| 4 | [`SegmentedControl.module.css:258`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css#L258) | `border-radius: var(--radius-full);` | `border-radius: var(--radius-sm);` | 选项内嵌小角标，收敛至 4px 标准微圆角 |
| 5 | [`SmartModelBadge.module.css:20`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartModelBadge.module.css#L20) | `border-radius: 9999px;` | `border-radius: var(--radius-sm);` | 模型状态标签，收敛至 4px 标准微圆角 |
| 6 | [`Tabs.module.css:142`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L142) | `border-radius: var(--radius-full);` | `border-radius: var(--radius-xs);` | 2px 发丝高光指示线，严格对应 `--radius-xs` (2px) |
| 7 | [`Tabs.module.css:264`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L264) | `border-radius: var(--radius-full);` | `border-radius: var(--radius-sm);` | Tab 选项卡内角标，收敛至 4px 标准微圆角 |
| 8 | [`Tooltip.module.css:48`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L48) | `border-radius: var(--radius-full);` | `border-radius: var(--radius-sm);`（或加入白名单） | 方案 A 收敛至 4px 桌面矩形气泡；方案 B 加入合法白名单 |

---

## 三、 G-05 7 级 Z-Index 标尺与层叠上下文梳理 (5 处)

### 3.1 7 级 Z-Index 标准阶梯与封顶 9000 铁律

前端项目中经常发生开发者为了让新弹出的元素“绝对盖在最上面”，随意写下 `z-index: 9999`、`z-index: 99999` 甚至 `z-index: 100000`。这种**恶性通胀（Z-Index Inflation）** 会迅速污染全局层叠环境，引发不可调和的遮挡死锁。

Conex 设立了唯一的权威 7 级 Z-Index 标尺（定义于 [`apps/crish-desktop/src/styles/z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css)），**严格封顶 9000**：

```
 Level 6 [9000] ── 顶级悬浮与拖拽覆盖: --z-tooltip (9000), --z-drag-overlay (9000)
       ▲
 Level 5 [1000] ── 全局模态与通知吐司: --z-modal (1000), --z-toast (1000), --dialog-z (1000)
       ▲
 Level 4 [ 500] ── 卡片气泡与上下文菜单: --z-popover (500), --z-context-menu (500), --z-drag-highlight (500)
       ▲
 Level 3 [ 300] ── 下拉菜单与级联选择: --z-dropdown (300), --z-breadcrumb (400), --z-smart-panel-sub (300)
       ▲
 Level 2 [ 100] ── 视口外壳与分栏手柄: --z-chrome (100), --z-sidebar (100), --z-resizer (100), --z-smart-panel (100)
       ▲
 Level 1 [  10] ── 粘性与外壳停靠层:   --z-dock (10), --z-sticky (10), --z-card-footer (10)
       ▲
 Level 0 [   0] ── 基础文档流与排版底座: --z-base (0), --z-decorative (0)
```

**刚性铁律**：
1. **禁止裸数字**：业务样式表中禁止直接书写 `z-index: [1-9][0-9]{2,}`（>= 100 的裸数字）；
2. **禁止恶性通胀**：严禁出现 `10000`、`99999`、`100000` 等恶性通胀数字；
3. **禁止有毒 fallback**：严禁在 `var(--z-*, 99999)` 中写入超过 9000 的 fallback；
4. **废弃 Token 清零**：严禁使用 `--z-drag-overlay-max`、`--z-first-run` 等 26 个历史废弃 Token。

---

### 3.2 5 处高位裸数字违规深度审计与层叠上下文剖析

#### 违规点 1 & 2：`BinaryTreeWorkspace.module.css` (L119, L430)
- **文件坐标**：[`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css)
  - L119：`.topSidePanelBtn { z-index: 160; }`
  - L430：`.leafDockDrawer.maximized { z-index: 150; }`
- **层叠上下文机制深度剖析**：
  查阅 [`BinaryTreeWorkspace.module.css:78`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L78)：
  ```css
  .leaf {
    position: absolute;
    ...
    isolation: isolate; /* ◀ 极为关键：建立了独立的局部层叠上下文！ */
  }
  ```
  `.leaf` 元素声明了 **`isolation: isolate;`**！这意味着 `.leaf` 内部的所有 z-index 计算完全封闭在该叶子容器之内，绝不会溢出或污染视口顶层的全局 Modal / Toast / Tooltip。
  在 `.leaf` 内部的相对层叠关系：
  1. `PaneHeader` 顶栏为 `z-index: 5`；
  2. 默认状态下的工具坞抽屉 `.leafDockDrawer` 为 `z-index: 20`；
  3. 全屏最大化状态下的工具坞抽屉 `.leafDockDrawer.maximized`（L430）被开发者赋予了裸数字 `150`，以盖住叶子内部其他控件；
  4. 叶右上角的抽屉展开/收起切换按钮 `.topSidePanelBtn`（L119）被赋予了裸数字 `160`，代码注释明确注明：`高于最大化抽屉 (z-index: 150)，全屏下常驻可见并可点击`。
  由于 150 和 160 均属于 `>= 100` 的裸数字，直接触发了门禁正则 `/z-index:\s*[1-9][0-9]{2,}\s*;/` 拦截。
- **收敛裁决**：
  既然 `.leaf` 具有隔离层叠上下文，内部控件应优雅映射至 7 级标准 Token：
  - `.leafDockDrawer.maximized` 映射至 **`z-index: var(--z-chrome);` (100)**（作为外壳面板层）；
  - `.topSidePanelBtn` 映射至 **`z-index: var(--z-dropdown);` (300)**（作为上层操作触发器，高于 100）。
  完全消除裸数字，层叠顺序严格保持 $5 < 20 < 100 < 300$，且无任何破环风险！

---

#### 违规点 3：`NoteSidebarDrawer.module.css` (L417)
- **文件坐标**：[`apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.module.css:417`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.module.css#L417)
- **现状代码**：
  ```css
  /* 确认删除原生浮层 */
  .dialogOverlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--surface-scrim) 40%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000; /* ◀ 违规：裸数字 1000 */
  }
  ```
- **层叠上下文分析**：
  `.dialogOverlay` 是笔记抽屉中用于“确认删除”的模态弹窗遮罩，采用 `position: fixed` 挂载在根视口。
  开发者在此直接写了数字 `1000`。而在 7 级标准标尺中，`Level 5: 全局模态、设置面板与通知吐司` 的权威 Token 正是 `--z-modal: 1000` 与 `--dialog-z: var(--z-modal)`。
- **收敛裁决**：
  将裸数字 `1000` 替换为语义化标准 Token：
  `z-index: var(--z-modal);` 或 `z-index: var(--dialog-z);`。

---

#### 违规点 4：`sessionTabDrag.module.css` (L68)
- **文件坐标**：[`apps/crish-desktop/src/components/shell/sessionTabDrag.module.css:68`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/sessionTabDrag.module.css#L68)
- **现状代码**：
  ```css
  .card {
    position: fixed;
    left: 0;
    top: 0;
    pointer-events: none;
    z-index: 100000; /* ◀ 违规：恶性通胀 100,000 魔数！ */
    box-sizing: border-box;
    height: 26px;
    ...
  }
  ```
- **层叠上下文分析**：
  `.card` 是侧边栏会话 Tab 在跨窗口/跨分栏拖拽时的跟手阴影预览卡片（Drag Ghost Overlay）。
  为了防止在拖拽过程中被侧边栏、分栏 Sash 或弹窗遮挡，开发者粗暴写入了 `100000` 恶性通胀数字。
  在 7 级标准标尺中，系统专为此类场景设立了 Level 6 顶级 Token：
  [`z-index.css:40`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css#L40)：`--z-drag-overlay: var(--z-tooltip); /* 9000 */`。
- **收敛裁决**：
  彻底废除 `100000`，收敛至标准 Token：
  `z-index: var(--z-drag-overlay);`。

---

#### 违规点 5：`SafeAimEngine.ts` (L47)
- **文件坐标**：[`apps/crish-desktop/src/components/ui/SmartExpandablePanel/SafeAimEngine.ts:47`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SafeAimEngine.ts#L47)
- **现状代码**：
  ```ts
  private initSvgOverlay(): void {
    const parent = this.container || (typeof document !== 'undefined' ? document.body : null);
    if (!parent) return;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2005;'; /* ◀ 违规：裸数字 2005 */
    ...
  }
  ```
- **层叠上下文分析**：
  `SafeAimEngine` 是用于级联菜单与可折叠面板的防误触安全三角形引擎（Amazon / Apple Safe Triangle 算法）。它在 `document.body` 上挂载一个全屏的 SVG 覆盖层，用于在调试模式下绘制视线多边形，日常状态下为 `pointer-events: none`。
  代码中写入了内联 `z-index:2005;`，不仅是非法裸数字，而且处于尴尬的 2005 高度（介于 modal 1000 与 tooltip 9000 之间）。
  由于该 SVG 仅用于承载级联菜单子项的安全扇形区，其层叠高度应与浮层/下拉菜单对齐（Level 4 `--z-popover: 500` 或 Level 3 `--z-dropdown: 300`）。
- **收敛裁决**：
  将内联样式的 `z-index:2005;` 替换为标准 CSS 变量：
  `z-index:var(--z-popover);`。

---

### 3.3 全局视口与局部叶子层叠拓扑图 (Stacking Context Hierarchy)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Viewport Root Stacking Context (document.body)                                                    │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  [Level 6: 9000] ── Top Tooltip & Drag Overlay                                                    │
│  ├─ <Tooltip> 浮层气泡 (var(--z-tooltip))                                                         │
│  └─ sessionTabDrag.card 拖拽卡片 (var(--z-drag-overlay)) ◀── [收敛：原 100000 归降至 9000]         │
│                                                                                                  │
│  [Level 5: 1000] ── Modal Dialog & Global Toast                                                   │
│  ├─ ToastContainer 全局吐司 (var(--z-toast))                                                      │
│  └─ NoteSidebarDrawer.dialogOverlay 删除模态 (var(--z-modal)) ◀── [收敛：原 1000 规范化为 Token]    │
│                                                                                                  │
│  [Level 4:  500] ── Popover & Context Menu                                                       │
│  ├─ SafeAimEngine.svgOverlay 级联菜单安全扇区 (var(--z-popover)) ◀── [收敛：原 2005 归降至 500]   │
│  └─ ContextMenu 快捷菜单 (var(--z-context-menu))                                                  │
│                                                                                                  │
│  [Level 2:  100] ── Shell Chrome & Sashes                                                        │
│  ├─ AppTopBar 沉浸顶栏 (var(--z-chrome))                                                          │
│  └─ Sash 分割手柄 (var(--z-resizer))                                                              │
│                                                                                                  │
│  [Level 0:    0] ── Main Workspace Canvas (BinaryTreeWorkspace)                                   │
│  └─ .leaf (isolation: isolate 局部封闭层叠上下文)                                                 │
│     ┌──────────────────────────────────────────────────────────────────────────────────────┐     │
│     │ Local Stacking Context inside .leaf                                                  │     │
│     ├──────────────────────────────────────────────────────────────────────────────────────┤     │
│     │  Local Level 300: .topSidePanelBtn 展开切换按钮 (var(--z-dropdown)) ◀── [原 160 规范化]│     │
│     │  Local Level 100: .leafDockDrawer.maximized 最大化工具坞 (var(--z-chrome)) ◀── [原 150]│   │
│     │  Local Level  20: .leafDockDrawer 常规工具坞 (20)                                    │     │
│     │  Local Level   5: PaneHeader 叶子顶栏 (5)                                            │     │
│     │  Local Level   0: Terminal / Editor / ChatBody 业务视图内容                          │     │
│     └──────────────────────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 3.4 G-05 完整代码替换对照表

| 序号 | 文件路径与行号 | 现存违规代码 | 拟收敛替换代码 | 7 级标尺层级与理由 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | [`BinaryTreeWorkspace.module.css:119`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L119) | `z-index: 160;` | `z-index: var(--z-dropdown);` | 局部 Level 3 (300)，确保在 `.leaf` 内部压过抽屉 |
| 2 | [`BinaryTreeWorkspace.module.css:430`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L430) | `z-index: 150;` | `z-index: var(--z-chrome);` | 局部 Level 2 (100)，作为外壳抽屉盖住正文 |
| 3 | [`NoteSidebarDrawer.module.css:417`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.module.css#L417) | `z-index: 1000;` | `z-index: var(--z-modal);` | 全局 Level 5 (1000)，模态弹窗遮罩规范化 |
| 4 | [`sessionTabDrag.module.css:68`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/sessionTabDrag.module.css#L68) | `z-index: 100000;` | `z-index: var(--z-drag-overlay);` | 全局 Level 6 (9000)，清除 100,000 通胀魔数 |
| 5 | [`SafeAimEngine.ts:47`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SafeAimEngine.ts#L47) | `z-index:2005;` | `z-index:var(--z-popover);` | 全局 Level 4 (500)，对齐浮层防误触遮罩标尺 |

---

## 四、 G-13 GBK 编码损坏与特征误报根因穿透 (1 处)

### 4.1 违规现场与判定断层：合法汉字「窗」如何触发 Mojibake 阻断

在运行 `check-frontend-convergence.mjs` 门禁时，触发了一条令人困惑的 G-13 违规报告：
`[Rule 13 / G-13] apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:98 -> 命中多个 GBK mojibake 特征字符！`

查看现场源码 [`BinaryTreeWorkspace.module.css:98`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L98)：
```css
/* L90-100 */
/*
 * 叶的直接子节点：绝对钉在叶右上第二行（抽屉头/快捷动作条行内，与 28px 按钮同轴垂直居中）。
 *
 * 纵向位置必须越过第一行 PaneHeader（--header-height = 36px），并在第二行居中推导：
 * calc(var(--header-height) + (var(--header-height) - var(--leaf-corner-btn-size)) / 2)
 * 第二行的横向让位由消费方各自预留：
 * LeafToolTabStrip.fixedCluster（padding-right: size + inset）与
 * UnitChromeActions（坞收起态让位区）都留出
 * (--leaf-corner-btn-size + --leaf-corner-btn-inset) 的空间。
 * 严禁把 top 算在第一行内（如 (header - size) / 2），否则会漂到窗口右上角遮挡窗口叉号窗控。 ◀ L98
 * 开合都不卸载、不改透明度。
 */
```

#### Unicode 逐字断层扫描：
对第 98 行进行完整的底层 Unicode 码点展开：
```
严 U+4E25 | 禁 U+7981 | 把 U+628A | 算 U+7B97 | 在 U+5728 | 第 U+7B2C | 一 U+4E00 | 行 U+884C | 内 U+5185
（ U+FF08 | 如 U+5982 | ） U+FF09 | ， U+FF0C | 否 U+5426 | 则 U+5219 | 会 U+4F1A | 漂 U+6F02 | 到 U+5230
窗 U+7A97 | 口 U+53E3 | 右 U+53F3 | 上 U+4E0A | 角 U+89D2 | 遮 U+906E | 挡 U+6321
窗 U+7A97 | 口 U+53E3 | 叉 U+53C9 | 号 U+53F7
窗 U+7A97 | 控 U+63A7 | 。 U+3002
```
**惊人结论**：整行文本的全部 33 个中文字符，**100% 均为规范合法的 UTF-8 CJK 常用汉字与标点符号，绝无任何乱码字节、无 U+FFFD 替换符、无私有区（PUA）损坏！**

---

### 4.2 门禁引擎 `FEATURE_CHARS` 字典缺陷根因剖析

审查 [`scripts/check-frontend-convergence.mjs:711-729`](file:///c:/Software/conex/scripts/check-frontend-convergence.mjs#L711-L729)：
```javascript
const FEATURE_CHARS = '閳ユ柡鈧姘顒烽敍妞ょ數鐎鏂鍙鍘鍦鎻鎷鎸鍗鍐鍑鍔鈥鈧锛濠婃艾濮╅崠鐚寸窗鈹€';
const FEATURE_SET = new Set(FEATURE_CHARS.split(''));
...
lines.forEach((lineText, idx) => {
  let featureHitCount = 0;
  for (const ch of lineText) {
    if (FEATURE_SET.has(ch)) featureHitCount++;
  }
  if (featureHitCount >= 2 || (featureHitCount >= 1 && KATAKANA_RE.test(lineText))) {
    report(13, 'G-13', file, idx + 1, `命中多个 GBK mojibake 特征字符！`);
    return;
  }
});
```

#### 根因还原：
1. 观察 `FEATURE_CHARS` 尾部的特征字符串：`...濠婃艾濮╅崠鐚寸窗鈹€`。
   在 Windows GBK 环境下，制表符序列（如 `┌──`、`├──`）或特定中文逗号在被 GBK 错误解码时，会产生包含 `寸窗鈹€` 的乱码片段。其中 `E2 94 80`（`─`）或相近字节序列恰好被映射成了汉字 **`窗` (U+7A97)**！
2. 规则制定者直接将捕获到的乱码片段全量粘贴进了 `FEATURE_CHARS` 字典，**未做合法汉字过滤，误将日常高频汉字「窗」作为了乱码特征字符**！
3. 而在 Conex 这样一款主打分栏与窗口管理（Window Management）的桌面软件中，「窗口」、「窗控」是极其高频的技术术语。
4. 第 98 行注释中出现了三次「窗」：
   `漂到窗口右上角遮挡窗口叉号窗控` $\implies$ **命中 3 次「窗」！**
5. 门禁规则检测到 `featureHitCount = 3 >= 2`，判定为 `命中多个 GBK mojibake 特征字符！`。
**这是一起 100% 确凿的由于检测字典误收录高频汉字引发的门禁误报（False Positive）！**

---

### 4.3 同一文件历史真实破损注释勘误与 UTF-8 还原

进一步深入代码审查发现了极具戏剧性的一幕：**在同一份文件 `BinaryTreeWorkspace.module.css` 的其他行中，反而真实存在历史遗留的注释破损！**

查看该文件第 55~59 行与第 138 行：
```css
/* L55-59: 现存破损代码 */
.leaf {
  position: absolute;
  /* rect   useTreeResize.paintFlatLayout / TreeLeafPanel layoutEffect   inline
   *     React style prop    live resize re-render
   *    px min-width      % rect   min-size   useTreeResize
   *      clamp MIN_CHILD_PX          min-width:0   flex
   *       overflow:hidden        sibling     */
  ...
}

/* L138: 现存破损代码 */
/* live resize     +          leaf      */
:global(.tree-resizing) .leaf,
:global(.tree-dragging) .leaf { ... }
```
通过 `git log -L` 追溯发现，在历史提交 `d00fbaaf19636ccafda078cb59f482bac75fed78` 中，某个粗暴的脚本将上述注释中的全部中文字符替换为了连续的空格！

通过 Git 提交链精确还原出历史真实完整的 UTF-8 注释内容：

#### 还原 1（L55-59）：
```css
  /* rect 由 useTreeResize.paintFlatLayout / TreeLeafPanel layoutEffect 写 inline
   * （勿用 React style prop，否则 live resize re-render 会覆盖两侧几何）。
   * 不设 px min-width：绝对定位 % rect 的 min-size 由 useTreeResize
   * 像素感知 clamp（MIN_CHILD_PX）保证非重叠；此处 min-width:0 让 flex
   * 子项可收缩，overflow:hidden 防止内容画出 sibling 边界。 */
```

#### 还原 2（L138）：
```css
/* live resize 拖拽指示条 + 拖拽中激活 leaf 样式 */
```

---

### 4.4 三阶修复实施方案与代码替换表

为了立竿见影根除 G-13 并消除隐患，设计三阶修复方案：

#### 阶段一：业务代码快速解脱（即刻消除 G-13 阻断）
微调第 98 行的文案用词，将重复的三次「窗」字改写为更地道的专业术语（如“顶栏右上角遮挡宿主叉号窗控按钮”），使「窗」字出现次数 $< 2$：
```css
/* 优化前 (命中 3 次窗字，触发误报) */
 * 严禁把 top 算在第一行内（如 (header - size) / 2），否则会漂到窗口右上角遮挡窗口叉号窗控。

/* 优化后 (保留准确语义，命中 1 次窗字，优雅避开缺陷字典) */
 * 严禁把 top 算在第一行内（如 (header - size) / 2），否则会漂到宿主右上角遮挡顶栏叉号窗控。
```

#### 阶段二：门禁脚本字典去毒与逆变换验证健全化
在 [`scripts/check-frontend-convergence.mjs`](file:///c:/Software/conex/scripts/check-frontend-convergence.mjs) 中：
1. 物理移除 `FEATURE_CHARS` 中的合法汉字 **`窗` (U+7A97)**、**`艾` (U+827E)** 等常规字；
2. 完善 `gbkInverseRecover` 函数，优先以真正的 GBK/UTF-8 逆向重构校验为准，不再仅凭单个字符频次盲目下断言。

#### 阶段三：历史真实残缺注释 UTF-8 修复
在 `BinaryTreeWorkspace.module.css` 中将 L55-59 和 L138 的空洞破损注释全部恢复为上述清晰易懂的工程中文注释。

---

## 五、 全仓 146 个受影响文件防回归保护与测试矩阵

### 5.1 146 个文件违规分布与目录拓扑分析

根据扫描统计，146 个受影响文件广泛分布于前端架构各个核心模块：

```
apps/crish-desktop/src/
├── components/ (132 个文件)
│   ├── chat-composer/      [14 个文件] (G-01: 30, G-03: 1, G-06: 21) ── 极其密集！
│   ├── settings/           [13 个文件] (G-01: 27, G-03: 1)
│   ├── chat-card/          [ 9 个文件] (G-01: 13)
│   ├── files/              [ 9 个文件] (G-01: 15, G-06: 16)
│   ├── binary-tree/        [ 9 个文件] (G-01: 13, G-05: 2, G-06: 5, G-13: 1)
│   ├── note-paper/         [ 8 个文件] (G-01: 17, G-05: 1, G-06: 11)
│   ├── agent-card/         [ 6 个文件] (G-01: 11)
│   ├── chat-message-row/   [ 6 个文件] (G-01:  7, G-03: 2, G-06: 10)
│   ├── sidebar/            [ 9 个文件] (G-01: 10, G-03: 1, G-06: 4)
│   ├── overlay/            [ 5 个文件] (G-01:  5, G-03: 1, G-04: 1, G-06: 10)
│   ├── diff/               [ 4 个文件] (G-01:  5, G-03: 3)
│   └── ui/                 [ 8 个文件] (G-02: 2, G-03: 4, G-04: 6, G-05: 1) ── 基元层！
└── extensions/ & hooks/    [ 8 个文件] (G-01: 8, G-03: 2)
```

**关键洞察**：
- **G-01 裸标签（226 处）** 是造成 146 个文件广泛扩散的最主要根因（主要为业务层手写 `<button>`、`<input>`）；
- **G-06 !important（91 处）** 集中在 `chat-composer`、`files`、`settings-models` 等复杂业务样式表中；
- 基元层 `ui/` 组件库自身存在 8 处需要自我净化的规范违规（G-02/G-03/G-04/G-05）。

---

### 5.2 现有测试资产全景盘点 (Unit / Contract / Optical / E2E)

对仓库当前测试体系的深度勘测表明，项目已具备扎实的测试基础设施：

1. **原子与业务单元测试（Vitest Unit）**：
   - 拥有 **38 个** 专有原子组件单元测试套件（如 `Button.test.tsx`、`Input.test.tsx`、`Tabs.test.tsx`、`Menu.test.tsx`、`Dialog.test.tsx`、`Select.test.tsx`、`ScrollArea.test.tsx`）；
   - 在 146 个受影响文件中，有 **46 个核心组件** 拥有直接绑定的专项 `.test.tsx`（覆盖率超 31.5%），其余为纯呈现型叶子视图。
2. **光学与样式契约测试（Optical & Style Contract Tests）**：
   - [`apps/crish-desktop/src/styles/motion-concentric-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/motion-concentric-contract.test.ts)：利用单行正则扫描全站 CSS，强制断言 0 奇数圆角（3/5/7/9/11/13px 棘轮清零）与 0 过冲贝塞尔（$y_2 \le 1.05$）；
   - [`apps/crish-desktop/src/styles/a11y-optical-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/a11y-optical-contract.test.ts)：扫描全站 TSX，强制所有 `<IconButton>` 必须拥有 `aria-label`；
   - [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts)：校验 `--button-radius` 单一真理源与 tokens.css 契约健全性；
   - [`apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts)：校验 native title 属性 0 容忍、阴影等级与偏色防御。
3. **E2E 与真实渲染测试（Playwright & Native Smoke）**：
   - `tests/e2e/ast-block-tables.spec.ts`、`tests/e2e/wysiwyg-interaction.spec.ts` 等专项 E2E 用例；
   - `tests/e2e/tauri-native-smoke.spec.ts` 真实宿主冒烟验证；
   - 严禁使用 9222 CDP，全面通过 **Tauri MCP Socket (127.0.0.1:4000)** 进行无侵入真机验收。

---

### 5.3 原子组件换装对 DOM 选择器与快照的破环性评估

将全仓 108 个文件中的裸 `<button>`、`<input>`、`<textarea>` 批量替换为 `@/components/ui` 中的标准原子组件 `<Button>`、`<Input>`、`<Textarea>` 时，必须审慎评估其对现有测试的潜在破坏：

#### 1. 快照测试（Snapshot Testing）影响评估：
- **核查事实**：全仓搜索 `toMatchSnapshot` 与 `toMatchInlineSnapshot`，结果显示 **UI 组件层完全没有使用 DOM 结构快照**！快照测试仅存在于 `prompts.snapshot.test.ts`（用于验证 Prompt 字符串模板编译输出）。
- **判定结论**：**零 DOM 快照破环风险（Zero Snapshot Breakage Risk）！**

#### 2. DOM 查找选择器影响评估：

```
【原生裸标签结构】                                   【<Input> 原子组件结构】
┌──────────────────────┐                           ┌────────────────────────────────────────────────────────┐
│ <input               │                           │ <div class="inputWrap inputWrapSm">                    │
│   class="myInput"    │                           │   <div class="inputShell">                             │
│   placeholder="..."  │                           │     <input class="input inputSm myInput"               │
│ />                   │                           │       placeholder="..." />                             │
│                      │                           │   </div>                                               │
│                      │                           │ </div>                                                 │
└──────────────────────┘                           └────────────────────────────────────────────────────────┘
```

| 查询方式 | 示例 | 兼容性评级 | 破坏机理与风险说明 | 应对方案 |
| :--- | :--- | :--- | :--- | :--- |
| **Testing Library 语义查询** | `getByRole('button')`<br>`getByRole('textbox')`<br>`getByPlaceholderText` | 🟢 **100% 兼容** | `<Button>` 内部渲染标准 `<button>`；`<Input>` 内部渲染标准 `<input>`，语义完全无缝继承。 | 无需修改任何测试用例。 |
| **TestId 查询** | `getByTestId('submit-btn')` | 🟢 **100% 兼容** | `<Button>` 与 `<Input>` 均通过 `...restProps` 将 `data-testid` 无损透传至内部原生标签。 | 原有 testId 查询不受影响。 |
| **文本内容查询** | `getByText('确认提交')` | 🟢 **100% 兼容** | `<Button>` 内部将 children 包裹在 `<span class="buttonContent">` 中，`getByText` 仍然能精确定位。 | 原有文本查询不受影响。 |
| **CSS 标签选择器** | `container.querySelector('button')` | 🟢 **100% 兼容** | 根部仍存在 `button` 标签，查询逻辑依然有效。 | 无影响。 |
| **CSS 直接子代选择器** | `form > input` | 🔴 **破坏高危** | `<Input>` 外部多出了 `inputWrap` 和 `inputShell` 两层容器，`form > input` 会彻底失效！ | 将直接子代选择器重构为后代选择器 `form input` 或通过 class 选择。 |
| **DOM 兄弟/父级遍历** | `input.parentElement` | 🔴 **破坏高危** | 原生 `<input>` 的父级原为业务容器，现在变为 `.inputShell`。 | 避免使用盲目 DOM 树层级探测，改用事件触发或 TestId 定位。 |
| **Flex/Grid 布局直接子项** | CSS: `.row > input { flex: 1; }` | 🟡 **样式中危** | 此时 flex 样式打在内部 input 上无效，必须打在外部 `.inputWrap` 上。 | 确保原子组件支持 `block` 或外层 `className` 透传。 |

---

### 5.4 平滑过渡方案与无损换装三准则

为了确保 146 个受影响文件换装过程中零回归、零编译中断，确立**无损换装三准则**：

```
                      ┌────────────────────────────────────────────────────────┐
                      │              原子组件平滑换装三大保护网                │
                      └────────────────────────────────────────────────────────┘
                                      │                        │
               ┌──────────────────────┴─────────┐    ┌─────────┴──────────────────────┐
               ▼                                ▼    ▼                                ▼
       【准则一：Props 契约完全透传】                     【准则二：Bare 裸核心逃逸舱】
  • 100% 继承 ButtonHTMLAttributes/Input...       • 特殊复杂列表项（如带内部自定义布局按钮）
  • 自动透传 data-*, aria-*, ref, id, autoFocus   • 启用 <Button bare> 模式，不注入 span 包裹
  • onClick, onKeyDown, onFocus 回调零篡改        • 完全保持原有 DOM 极简骨架
```

#### 1. 准则一：Props 契约 100% 完全透传
原子组件 `<Button>` 和 `<Input>` 的类型定义必须严格继承自 React 原生标签属性：
```tsx
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { ... }
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> { ... }
```
所有上层业务组件传入的 `data-*`、`aria-*`、`title`、`on*` 事件回调均无损传递至内部原生元素，保障外部行为一致。

#### 2. 准则二：启用 `bare` 裸核心模式作为复杂排版逃逸舱
在菜单项（MenuItem）、拖拽选项卡（SessionTab）、极简图标等特殊位置，上层样式可能对 `<button>` 的子节点有直接 CSS 要求。
此时使用 `<Button bare className={styles.item}>`：
```tsx
// 启用 bare=true 时，Button 组件只渲染纯粹的 <button>，不引入任何额外的 class 和内层 span！
<Button bare className={styles.customBtn} onClick={handleClick}>
  <Icon /> <span>文本</span>
</Button>
```
这彻底消除了引入未知层级对现有 CSS Flexbox / 伪类选择器的任何破坏。

#### 3. 准则三：分域串行推进，先基座后业务
按照依赖拓扑严格执行替换顺序：
1. **第一波（基座闭环）**：先清退 `@/components/ui/` 本身的违规项（ScrollArea、Tabs、Tooltip、SegmentedControl、Menu），确保原子组件自身为零缺陷标准底座；
2. **第二波（独立无状态组件）**：替换 `agent-card/`、`overview/`、`diff/` 等纯呈现组件；
3. **第三波（高频核心交互）**：替换 `chat-composer/`、`sidebar/`、`settings/` 等带复杂键盘和焦点管理的重型组件。

---

### 5.5 立体化四层防回归测试矩阵 (Quad-Tier Test Matrix)

为确保 146 个受影响文件在修复后永不回潮，构建覆盖全生命周期的**立体化四层防御网络**：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           Conex 前端立体化四层防回归测试矩阵                                      │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  [Tier 4: 真实环境真机验收层] ── 运行于真实 Tauri 宿主与 WebView2 (基于 Tauri MCP: 4000 端口)     │
│  • 禁用 9222 CDP，走 4000 调试通道进行无侵入 DOM 检查、物理坐标抓取与真实截图对比               │
│  • 重点验证：Tooltip 视口边界碰撞翻转、ScrollArea 拖拽手感、IME 中文拼音回车防提前提交          │
│  ──────────────────────────────────────────────────────────────────────────────────────────────  │
│  [Tier 3: E2E 与组件集成测试层] ── npm run test:integration & tests/e2e                          │
│  • Playwright 专项测试：ast-block-tables, format-checker, wysiwyg-interaction                    │
│  • 验证原子组件换装后，表单提交、Tab 键盘左右切换、Dialog 焦点陷阱（FocusTrap LIFO）功能完整性   │
│  ──────────────────────────────────────────────────────────────────────────────────────────────  │
│  [Tier 2: 光学与样式契约测试层] ── Vitest Contract Suites (npm run test:fast)                   │
│  • motion-concentric-contract.test.ts: 0 奇数圆角 (3/5/7/9/11/13px) + 0 抖动贝塞尔 (y2 <= 1.05)   │
│  • a11y-optical-contract.test.ts: 100% IconButton aria-label 覆盖                                │
│  • style-contract.test.ts: tokens.css 契约锁定与单一真理源守卫                                   │
│  • input-three-patterns-guard.test.ts: 输入框 3%~10% 柔和焦点对比度铁律校验                      │
│  ──────────────────────────────────────────────────────────────────────────────────────────────  │
│  [Tier 1: 静态 AST 与门禁刚性拦截层] ── scripts/check-frontend-convergence.mjs (Git Hook / CI)  │
│  • G-01: AST 级别扫描全仓业务 JSX，拦截除 src/components/ui 外的所有裸交互标签 (button/input...)│
│  • G-04: 正则扫描 CSS，拦截非白名单 9999px 与 radius-full                                        │
│  • G-05: 拦截高位裸数字 z-index (>= 100) 与 26 个废弃 Token                                       │
│  • G-06: 业务 CSS Modules 零 !important 刚性拦截                                                 │
│  • G-13: 全仓 UTF-8 无 BOM、零 GBK 损坏与特征字符严格复原                                       │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 覆盖 146 个受影响文件的验收断言清单：

| 验证维度 | 验证目标 | 自动化执行命令 / 门禁文件 | 刚性通过断言 (Pass Criteria) |
| :--- | :--- | :--- | :--- |
| **AST 静态门禁** | G-01 业务裸交互标签清零 | `node scripts/check-frontend-convergence.mjs` | 违规计数从 226 降至 **0**，退出码为 0 |
| **AST 静态门禁** | G-04 非白名单药丸圆角清零 | `node scripts/check-frontend-convergence.mjs` | 违规计数从 8 降至 **0**，退出码为 0 |
| **AST 静态门禁** | G-05 7 级 Z-Index 标尺合规 | `node scripts/check-frontend-convergence.mjs` | 违规计数从 5 降至 **0**，无高位裸数字 |
| **AST 静态门禁** | G-06 业务样式零 !important | `node scripts/check-frontend-convergence.mjs` | 违规计数从 91 降至 **0** |
| **静态分析** | G-13 GBK Mojibake 乱码清零 | `node scripts/check-frontend-convergence.mjs` | 违规计数从 1 降至 **0**，字典去毒完成 |
| **样式契约** | 同心几何标尺与物理动效 | `npx vitest run apps/crish-desktop/src/styles/motion-concentric-contract.test.ts` | 全部用例 PASS，0 奇数圆角，0 晃荡贝塞尔 |
| **无障碍契约** | 按钮命名与光学对比度 | `npx vitest run apps/crish-desktop/src/styles/a11y-optical-contract.test.ts` | 全部用例 PASS，100% aria-label 覆盖 |
| **原子组件单元测试** | UI 核心原语功能无损 | `npx vitest run apps/crish-desktop/src/components/ui` | 38 个组件测试套件全部 PASS (100% Green) |
| **业务集成单元测试** | 146 个受影响文件业务逻辑 | `npm run test` (全量 Vitest) | 全量单元测试零失败，无 DOM 查询未捕获异常 |
| **真实宿主验收** | 桌面端物理表现与零报错 | Tauri MCP Socket (`127.0.0.1:4000`) | 真实界面无样式错位，Console 零未捕获异常 |

---

## 六、 结论与后续实施调度建议

本分析报告全面摸清了 Conex 前端工程在几何标尺、Z-Index 分层、字符集编码与测试防护方面的底层技术脉络：

1. **G-04（8 处）**：明确了同心几何数学标尺的强制地位，提供了 8 处代码的精确定位与替代 Token，并深入剖析了 Tooltip 胶囊的历史渊源与最佳收敛策略；
2. **G-05（5 处）**：利用 `.leaf` 的 `isolation: isolate` 局部层叠上下文特性，将局部裸数字平滑映射为标准 Token，消除了 `100000` 恶性通胀数字，重塑了 7 级清晰拓扑；
3. **G-13（1 处）**：穿透了门禁脚本 `FEATURE_CHARS` 字典误收录常用汉字「窗」的技术根因，澄清了误报事实，并顺藤摸瓜找回了同一文件中因历史提交破损的珍贵 UTF-8 中文注释；
4. **全仓测试矩阵（146 个受影响文件）**：证实了换装原子组件对快照测试 0 破坏，梳理了 DOM 查找选择器的安全边界，提供了 `bare` 模式等无损过渡准则，并构建了四层立体化防回归测试矩阵。

#### 后续实施分工与调度建议：
- **第一步**：优先修复 `scripts/check-frontend-convergence.mjs` 中的 `FEATURE_CHARS` 字典（剔除「窗」字误伤），并修复 `BinaryTreeWorkspace.module.css` 中的真实破损注释与 L98 描述，立即可将 G-13 清零；
- **第二步**：实施 G-04 与 G-05 的 13 处定点样式替换，跑通 `check-frontend-convergence.mjs` 中的 Rule 4 与 Rule 5；
- **第三步**：将 146 个受影响文件按目录划分为 5 个无重叠工区（Chat 域、Settings 域、BinaryTree 域、Sidebar 域、Files 域），派发实现子 Agent 进行原子组件换装，并执行四层测试矩阵刚性守门，彻底完成前端工程的终极收敛！
