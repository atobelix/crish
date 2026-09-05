# 用量监控控制台 UI 组件规范与视觉样式深度审计报告

## 审计概览与缺陷统计

- **审查对象**：
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx`
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css`
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.tsx`
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.module.css`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.module.css`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.module.css`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.module.css`
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.tsx`
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.module.css`
  - `apps/crish-desktop/src/components/settings/EditablePriceRow.tsx`
  - `apps/crish-desktop/src/styles/tokens.css`
- **遵循权威准则**：
  - 用户现场批评与重构裁决；
  - 仓库协作指令 `AGENTS.md` §12（Tooltip / 悬停提示规范）、§13（输入框与焦点态规范）、§14（色彩空间与现代 CSS 语法规范）；
  - `ANTI_OVERENGINEERING_GUARDRAILS.md` 与反退避自检清单；
  - `docs/usage-system-migration/01-用量监控界面与组件规范重构终极融合方案.md`。
- **缺陷统计**：
  - **P1（严重违规与结构性视觉缺陷）**：8 项
  - **P2（组件契约漂移与排版几何错位）**：5 项
  - **P3（样式残留与兜底硬编码瑕疵）**：1 项
  - **总计**：14 项缺陷

---

## 缺陷清单

### 缺陷 ISSUE-01：UsageSummaryHero 外层卡片边距缺失导致与父容器顶死贴墙并产生垂直视觉断层
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css:9-17`
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.module.css:3-8`
- **缺陷确凿证据**：
  ```css
  /* SettingsUsageTab.module.css:9-17 */
  .usageDashboardCard {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-xl, 12px);
    box-shadow: var(--shadow-card);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  ```
  ```css
  /* UsageSummaryHero.module.css:3-8 */
  .heroGrid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-4, 16px);
    width: 100%;
  }
  ```
  1. `SettingsUsageTab` 将整个监控控制台包裹在带有边框与圆角的外层大容器 `.usageDashboardCard` 中，该容器未设置任何内边距（`padding: 0`）。
  2. 第一子模块 `UsageSummaryHero` 的根容器 `.heroGrid` 同样未定义内边距（`padding: 0`）或外边距（`margin: 0`）。
  3. `UsageSummaryHero.tsx:31, 61` 内部直接渲染了两个系统 [`SettingsCard`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.tsx)，该卡片自身自带 `border: 1px solid var(--border-color)` 与 `border-radius: var(--radius-xl, 12px)`。
  4. **现场视觉灾难**：
     - 左侧卡片的左边框与外层父容器左边框 0 间距直接重合顶死；
     - 右侧卡片的右边框与外层父容器右边框 0 间距直接重合顶死；
     - 两张卡片的下边框与紧随其后的 `UsageTrendChart` 顶部 0 间距直接粘连；
     - 对比下方所有下属模块：`UsageTrendChart`（`padding: 20px 22px`）、`ModelDistributionSection`（`padding: 10px 22px 20px`）、`ActivityMatrixHeatmap`（`padding: 20px 22px`）均有严格的 `22px` 左右安全缩进与呼吸感，而唯独顶部的核心 Hero 卡片出现“卡片套卡片、边框重叠卡死”的严重视觉断层。
- **根因分析**：
  重构时机械地将左右卡片直接换装为 `SettingsCard`，未顾及外层父卡片 `.usageDashboardCard` 与内层子卡片之间的代数外壳留白（Shell Gutter）与模块内边距流，造成父子边框贴合冲突。
- **修复加固建议**：
  在 `UsageSummaryHero.module.css` 的 `.heroGrid` 中补充统一的内边距与底边分界：
  ```css
  .heroGrid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-4, 16px);
    width: 100%;
    padding: 20px 22px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--border-subtle);
  }
  ```
  使顶部 Hero 卡片的左右边缘与下方图表模块的 `22px` 栅格保持 100% 垂直同轴对齐，并与走势图形成清晰的水平节奏。

---

### 缺陷 ISSUE-02：PriceConfigModal 暴力覆盖系统 Input 尺寸导致内层双重嵌套边框与表格组件高度参差不齐
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.tsx:267-282, 342-376`
  - `apps/crish-desktop/src/components/settings/EditablePriceRow.tsx:63-115`
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.module.css:80-113`
- **缺陷确凿证据**：
  ```tsx
  // PriceConfigModal.tsx:342-351
  <Input
    size="xs"
    placeholder="0.0"
    value={priceDraft.input}
    onChange={(e) =>
      setPriceDraft((d) => ({ ...d, input: e.target.value }))
    }
    className={styles.cellInput}
  />
  ```
  ```css
  /* PriceConfigModal.module.css:80-95 */
  .cellInput {
    width: 100%;
    height: 30px;
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md, 6px);
    font-size: 13px;
    background: var(--bg-card, #ffffff);
    color: var(--text-primary);
    outline: none;
    box-sizing: border-box;
  }
  ```
  1. 系统标准原子组件 [`ui/Input`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.tsx) 的内部 DOM 契约是：`.inputWrap > .inputShell > input.input.inputXs`。
  2. `ui/Input` 的 `size="xs"` 契约是严格锁定 `height: 24px`、`padding: 0 8px`、`border-radius: 4px`、`font-size: 12px`；其边框、背景与焦点环均由组件自身规范管理。
  3. 但 `PriceConfigModal` 与 `EditablePriceRow` 将 `className={styles.cellInput}` 传入了 `Input`，导致其直接应用在最深层的 `<input>` 原生节点上。
  4. `.cellInput` 强制注入了 `height: 30px`、`border: 1px solid var(--border-subtle)`、`border-radius: 6px`、`background: #ffffff`，与外层 `.inputShell` 形成了荒谬的**双重嵌套边框与双重圆角**。
  5. 聚焦（Focus）时，外层 `.input` 按照系统规范渲染焦点状态，内层 `.cellInput:focus` 又渲染一层 `border-color: color-mix(...)`，破坏统一 Focus Ring 契约。
  6. **组件尺寸矩阵失调**：在同一数据行内，`Input` 被撑高到 `30px`，相邻的系统 `<Select size="sm" />` 高度为 `28px`，右侧的操作按钮 `<Button size="xs" />` 高度为 `24px`。同一行内的表单组件高度呈现 `30px`、`28px`、`24px` 杂乱无章的阶梯状失范。
- **根因分析**：
  在从原生 `<input>` 重构迁入系统 `<Input />` 原子组件时，未清理原本用于原生 input 的覆盖类 `.cellInput`，违反了原子组件单一职责与免覆盖原则。
- **修复加固建议**：
  1. 彻底删除 `PriceConfigModal.module.css` 中的 `.cellInput` 类；
  2. 移除 `PriceConfigModal.tsx` 和 `EditablePriceRow.tsx` 中所有 `className={styles.cellInput}` 属性传参；
  3. 表格整行组件规范对齐为系统标准的同一高度档位（建议全行统一使用 `size="sm"` 28px 或统一使用 `size="xs"` 24px），由组件内部标准 Tokens 驱动尺寸。

---

### 缺陷 ISSUE-03：UsageSummaryHero 右卡片主指标数值与货币单位双重重复（¥ 0.00 CNY）破坏镜像对称
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.tsx:68-73`
- **缺陷确凿证据**：
  ```tsx
  // UsageSummaryHero.tsx:68-73
  <div className={styles.primaryMetricRow}>
    <span className={styles.primaryNumber}>
      {formatCost(totalCost, currencyPrefix)}
    </span>
    <span className={styles.primaryUnit}>{currency}</span>
  </div>
  ```
  1. `formatCost` 源码（`usageSpline.ts:31-34`）逻辑为：
     ```typescript
     export function formatCost(v: number, prefix = '¥ '): string {
       if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return `${prefix}0.00`;
       return `${prefix}${v.toFixed(2)}`;
     }
     ```
  2. 当 `currencyPrefix = '¥ '` 时，`formatCost` 的返回值自带货币前缀（如 `"¥ 0.00"`、`"¥ 12.34"`）。
  3. 而在 JSX 中，紧随其后的 `.primaryUnit` 又渲染了 `{currency}`（即 `"CNY"` 或 `"USD"`）。
  4. 界面实际渲染输出为：`¥ 0.00 CNY` 或 `$ 0.00 USD`。
  5. 对比左卡片：
     ```tsx
     <div className={styles.primaryMetricRow}>
       <span className={styles.primaryNumber}>{formatTokens(totalTokens)}</span>
       <span className={styles.primaryUnit}>tokens</span>
     </div>
     ```
     左卡片为纯净的数值 `12.5 万` + 英文单位 `tokens`；右卡片却前后包裹了两个重复的货币符号与币种名称，破坏了左右两张卡片大数字字阶与单位基线的纯净对称。
- **根因分析**：
  未对齐 `formatCost` 的输出语义与外层单位容器的关系，导致货币前缀与后缀单位冗余叠加。
- **修复加固建议**：
  保持左右卡片排版结构绝对镜像：`primaryNumber` 统一展示无前缀纯数字，`primaryUnit` 统一展示单位文本：
  ```tsx
  <div className={styles.primaryMetricRow}>
    <span className={styles.primaryNumber}>
      {formatCost(totalCost, '')}
    </span>
    <span className={styles.primaryUnit}>{currency}</span>
  </div>
  ```

---

### 缺陷 ISSUE-04：ActivityMatrixHeatmap 独立 Grid 与 Flex 容器导致 Y 轴标签与热力图数据行垂直严重错位
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:104-161`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.module.css:52-116`
- **缺陷确凿证据**：
  ```tsx
  // ActivityMatrixHeatmap.tsx:104-128
  <div className={styles.activityMatrixContainer}>
    {/* Y 轴独立 Grid */}
    <div
      className={styles.activityYAxis}
      style={{ gridTemplateRows: `repeat(${rows.length}, 1fr)` }}
    >
      {rows.map((rowName) => ...)}
    </div>

    {/* 单元格矩阵独立 Flex 容器 */}
    <div className={styles.activityMatrix}>
      {rows.map((rowName, rIdx) => (
        <div key={rIdx} className={styles.activityRow}>
          ...
        </div>
      ))}
    </div>
  </div>
  ```
  ```css
  /* ActivityMatrixHeatmap.module.css:61-116 */
  .activityYAxis {
    display: grid;
    gap: 4.5px;
    width: 64px;
    flex-shrink: 0;
    align-items: center;
  }
  .activityMatrix {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4.5px;
  }
  .activityCell {
    aspect-ratio: 1 / 1;
    width: 100%;
    max-width: 20px;
  }
  ```
  1. 左侧 Y 轴容器 `.activityYAxis` 是独立的 CSS Grid，通过 `grid-template-rows: repeat(${rows.length}, 1fr)` 均分垂直高度。
  2. 右侧热力图矩阵 `.activityMatrix` 是独立的 Flex 纵向容器，其每一行 `.activityRow` 内部单元格由 `aspect-ratio: 1 / 1; max-width: 20px;` 约束。
  3. **30d 模式下的严重错位实测**：
     - 在 30d 模式下列数达到 30 列。在标准视口（约 600px 内容区）下，每列单元格宽度被挤压至约 `13px`，其物理高度相应紧缩为 `13px`；
     - 4 行单元格矩阵的实际物理总高度仅为：$4 \times 13\text{px} + 3 \times 4.5\text{px} = 65.5\text{px}$；
     - 但左侧 Y 轴每一行都包含主标（`11px`, line-height `1.25`）和微标（`9.5px`, line-height `1.25`）两行文本，每行行高不低于 `26px`，4 行文本总高度至少撑起 `104px`；
     - 由于父容器 `.activityMatrixContainer` 默认 `align-items: stretch`，容器总高被左侧撑大到 `104px`；
     - 右侧 4 行单元格因 flex 布局被堆积在顶部 `65.5px` 的空间内，下方悬空留白近 `40px`；
     - **左侧第 3、4 行时间刻度（“下午 12-18”、“晚间 18-24”）与右侧第 3、4 行单元格的垂直中线发生严重偏位，肉眼清晰可见完全错开**。
- **根因分析**：
  将原本属于统一二维坐标网格的“行标题”与“行单元格数据”人为拆散到两个不同的 DOM 父容器中，左侧高度由字体内容决定，右侧高度由单元格宽高比决定，在动力学缩放时必然产生错位。
- **修复加固建议**：
  重塑热力图 DOM 架构，将每一行的 Y 轴 Header 与数据单元格包裹在同一个 Row 容器内：
  ```tsx
  <div className={styles.activityMatrixTable}>
    {rows.map((rowName, rIdx) => (
      <div key={rIdx} className={styles.activityUnifiedRow}>
        <div className={styles.yAxisRowHeader}>...</div>
        <div className={styles.activityCellsRow}>...</div>
      </div>
    ))}
  </div>
  ```
  在每一行内部通过 `display: flex; align-items: center;` 绑定，从架构根源上消灭错位隐患。

---

### 缺陷 ISSUE-05：tokens.css 中散落 10 处旧式 rgba 语法并残留已死 `--usage-seg-*` 伪分段变量违背 AGENTS.md §14
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/styles/tokens.css:1593-1598, 1607-1625`
- **缺陷确凿证据**：
  ```css
  /* tokens.css:1593-1598 */
  --usage-seg-pad: 2px;
  --usage-seg-radius: 7px;
  --usage-seg-btn-radius: calc(var(--usage-seg-radius) - var(--usage-seg-pad)); /* 5px */
  --usage-seg-sm-pad: 1.5px;
  --usage-seg-sm-radius: 5px;
  --usage-seg-sm-btn-radius: 3.5px;

  /* tokens.css:1607-1625 */
  --usage-color-brand-bg: rgba(16, 185, 129, 0.11);
  --usage-color-claude-bg: rgba(249, 115, 22, 0.11);
  --usage-color-minimax-bg: rgba(139, 92, 246, 0.11);
  --usage-color-kimi-bg: rgba(2, 132, 199, 0.11);
  --usage-color-other-bg: rgba(245, 158, 11, 0.11);
  --usage-color-input-bg: rgba(2, 132, 199, 0.11);
  --usage-color-cache-bg: rgba(139, 92, 246, 0.11);
  --usage-color-cost-total-bg: rgba(37, 99, 235, 0.10);
  --usage-color-total-bg: rgba(16, 185, 129, 0.11);
  --usage-color-danger-bg: rgba(220, 38, 38, 0.08);
  ```
  1. 第 1593-1598 行的 6 个 `--usage-seg-*` 变量，是在手写裸 `div` 伪分段时代私造的死 Token。当前顶栏、走势图、热力图三处已 100% 对接系统原子组件 `SegmentedControl`，该 6 个变量在工程中引用数为 0，属于死代码残留。
  2. 第 1607-1625 行整整 10 处显式散落旧式 `rgba(r,g,b,a)`。这直接践踏了 `AGENTS.md` §14 铁律：“**优先 HSLA / 斜杠透明度：避免散落旧式 rgba(r,g,b,a)；UI 与 Design Token 优先 hsl(h s l / a) 或 hsla(...)，用斜杠 / 分隔不透明度（如 hsl(210 20% 98% / 0.8)）**”。
  3. 第 1625 行保留了用户在现场批评中明确勒令清退的硬编码 `rgba(220, 38, 38, 0.08)`。
- **根因分析**：
  编写 Design Tokens 时缺乏现代 CSS 语法自觉，机械复制旧样式代码，且重构后未清理死 Token。
- **修复加固建议**：
  1. 物理删除 1593-1598 行的 `--usage-seg-*` 系列无用死 Token；
  2. 将 1607-1625 行的所有 `--usage-color-*-bg` 重塑为带斜杠透明度的现代 HSL 语法或 `color-mix` 语法：
     ```css
     --usage-color-brand-bg: hsl(160 84% 39% / 0.11);
     --usage-color-claude-bg: hsl(25 95% 53% / 0.11);
     --usage-color-minimax-bg: hsl(258 90% 66% / 0.11);
     --usage-color-kimi-bg: hsl(200 98% 39% / 0.11);
     --usage-color-other-bg: hsl(38 92% 50% / 0.11);
     --usage-color-input-bg: hsl(200 98% 39% / 0.11);
     --usage-color-cache-bg: hsl(258 90% 66% / 0.11);
     --usage-color-cost-total-bg: hsl(221 83% 53% / 0.10);
     --usage-color-total-bg: hsl(160 84% 39% / 0.11);
     --usage-color-danger-bg: hsl(0 84% 60% / 0.08);
     ```

---

### 缺陷 ISSUE-06：tokens.css 暗色模式（Dark Theme）缺少对 `--usage-*` 变量的适配导致深色下对比度劣化
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/styles/tokens.css:875-950, 1591-1658`
- **缺陷确凿证据**：
  1. 在 `tokens.css` 的第 875-950 行 `html[data-theme='dark']` 作用域内，检索 `--usage-` 结果为 0 处。
  2. 所有 `--usage-*` 变量全部被写在文件底部的 `:root` 全局规则中。
  3. 当应用切换至暗色模式（`--bg-card: #242424`，`--bg-primary: #1b1b1b`）时：
     - 模型用量胶囊条底色 `--usage-color-*-bg` 的不透明度仅为 `0.11`，叠加在 `#242424` 底色上近乎全黑浑浊，无法清晰辨识胶囊条内部的进度百分比几何轮廓；
     - 热力图未激活级别 `--usage-heat-0` 被写死为 `color-mix(in srgb, var(--border-color) 40%, transparent)`，在深灰色背景下与未激活单元格底色发生色彩塌陷，单元格矩形边界几乎消失。
- **根因分析**：
  Token 架构只完成了浅色（Light）模式的初始定义，遗漏了深色（Dark）主题的二元调和适配。
- **修复加固建议**：
  在 `tokens.css` 的 `html[data-theme='dark']` 规则中补全专属暗色用量 Token，微调暗色下的底色不透明度（提升至 `0.18 ~ 0.22`）与色彩明度，确保符合 WCAG AA 对比度准则。

---

### 缺陷 ISSUE-07：走势图“均线参考”与“删除单价”按钮破坏系统 Button icon 契约并采用内联 style 暴力覆盖
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:135-156`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.module.css:30-54`
  - `apps/crish-desktop/src/components/settings/EditablePriceRow.tsx:145, 150-167`
- **缺陷确凿证据**：
  1. `UsageTrendChart.tsx:135-156`：“均线参考”按钮使用系统 `<Button variant="plain" size="xs">`，但未将矢量图形传入 `icon` prop，而是将其作为裸 `children` 传入，并内联编写了：
     ```tsx
     <svg style={{ width: 12, height: 12, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}>
     ```
  2. 伴生的 `UsageTrendChart.module.css:30-54` 通过 `.btnAvgToggle` 大量覆盖系统 Button 的内建样式：
     ```css
     .btnAvgToggle {
       height: 22px;
       padding: 0 8px;
       font-size: 11px;
       border-radius: var(--radius-sm, 5px);
       display: flex;
       align-items: center;
       gap: 4px;
       border: 1px solid transparent;
       background: transparent;
     }
     ```
     暴力修改了组件的高度（`22px`）、圆角与内边距，违背方案 1.6 节“清退所有外部覆盖 class 与硬编码，杜绝破坏 Button 内部 flex 居中机制”的明确治理要求。
  3. `EditablePriceRow.tsx:150-167`：删除模型单价按钮使用 `<Button variant="ghost" size="xs">`，未传 `icon` prop，裸传 children，并写死多项内联覆盖：
     ```tsx
     style={{
       color: 'var(--text-tertiary)',
       padding: '4px',
       height: '24px',
       minWidth: '24px',
     }}
     ```
  4. 同文件第 145 行保存按钮同样写死内联样式：`style={{ padding: '0 6px', height: '24px' }}`。
- **根因分析**：
  部分组件实现未彻底落实方案规范，仍沿袭手写内联样式与外部类名覆写基础组件的坏习惯。
- **修复加固建议**：
  1. “均线参考”按钮重塑为：
     ```tsx
     <Button
       type="button"
       variant={showAvgLine ? 'secondary' : 'plain'}
       size="xs"
       icon={<DashLineIcon size={12} />}
       onClick={() => setShowAvgLine((prev) => !prev)}
     >
       均线参考
     </Button>
     ```
     彻底删除 `UsageTrendChart.module.css` 中的 `.btnAvgToggle` 与 `.btnAvgToggleActive` 样式类；
  2. `EditablePriceRow.tsx` 中的删除按钮清退全部内联 `style`，改走标准原子调用：
     ```tsx
     <Button
       type="button"
       variant="ghost"
       size="xs"
       icon={<Lucide.Trash2 size={13} />}
       onClick={onDelete}
       aria-label={`删除 ${row.model}`}
     />
     ```

---

### 缺陷 ISSUE-08：PriceConfigModal 智能建议浮层采用魔术数字测距与 DOM style 原生操控违背 AGENTS.md §7
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.tsx:45-54, 287-337`
- **缺陷确凿证据**：
  1. `PriceConfigModal.tsx:49`：
     ```typescript
     setAddDropdownRect({
       top: Math.max(10, rect.top - 186),
       left: rect.left,
       width: Math.max(rect.width, 240),
     });
     ```
     硬编码了魔术数字 `186px`（盲猜浮层高度为 186px 并向上浮动）。
     - 当输入匹配建议只有 1 项时（单项高约 32px，浮层总高仅约 40px），浮层依然停留在 `rect.top - 186` 处；
     - **浮层与输入框之间硬生生留出近 140px 的悬空巨大空隙**，呈现滑稽的“隔空悬浮”Bug。
  2. `PriceConfigModal.tsx:298` 浮层容器硬编码了散落旧式 `boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)'` 与 `#ffffff` 兜底背景。
  3. `PriceConfigModal.tsx:317-322`：
     ```tsx
     onMouseEnter={(e) =>
       (e.currentTarget.style.background = 'var(--bg-hover)')
     }
     onMouseLeave={(e) =>
       (e.currentTarget.style.background = 'transparent')
     }
     ```
     直接通过 JS 原生事件硬改 DOM style 属性模拟 Hover 态。这完全违背了 `AGENTS.md` §7“严禁补丁、绕过与作弊”与 React 声明式样式规范。
- **根因分析**：
  实现 Portal 联想浮层时使用了打补丁式的坐标测距魔术数字与内联 DOM 操控，未接入正规的 Popover / 相对定位组件。
- **修复加固建议**：
  1. 将浮层样式迁移进 `PriceConfigModal.module.css`，使用标准的 CSS `:hover` 规则替代 JS 原生 style 赋值；
  2. 废除 `rect.top - 186` 的盲目硬算，利用输入框包裹容器的 `position: relative`，将建议浮层定位在输入框正上方：
     ```css
     .suggestionsDropdown {
       position: absolute;
       bottom: calc(100% + 4px);
       left: 0;
       right: 0;
       max-height: 180px;
       overflow-y: auto;
     }
     ```
     由浏览器排版引擎根据子项数量自然收放高度，根除魔术数字与悬空漏洞。

---

### 缺陷 ISSUE-09：ModelDistributionSection 饼图切片截断（前 5 项）、图例（前 4 项）与右侧列表（全量）数量脱节致 Hover 失焦
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:43-46, 63-66, 103, 145-184`
- **缺陷确凿证据**：
  1. 左侧圆饼图切片计算：`models.slice(0, 5)`（固定截取前 5 项）；
  2. 圆饼图下方微型图例：`models.slice(0, 4)`（固定截取前 4 项）；
  3. 右侧胶囊进度列表：`models.map(...)`（渲染全部模型项，超出可纵向滚动）；
  4. **交互失焦断层**：
     - 当用户使用了 6 个或更多模型时，第 6 个模型在右侧列表中存在，但左侧圆环饼图中根本没有切片；
     - 用户在右侧列表中悬停（Hover）第 6 个模型时，`hoveredIdx` 被设为 5；
     - 左侧 5 个切片的 `hoveredIdx === idx` 恒为 `false`，导致左侧圆环全部变成 `opacity: 0.85` 的未激活态，左侧无任何高亮指示；
     - 第 5 个模型在圆环饼图中有切片（占有一段弧度），但在圆环正下方的微型图例中却失踪（只渲染了前 4 个）。
- **根因分析**：
  数据可视化模型未建立统一的切片聚合契约，在三个不同子区块中硬编码了各不相同的截断阈值（4 项 vs 5 项 vs 全量）。
- **修复加固建议**：
  在 `ModelDistributionSection` 内部建立统一的切片衍生模型：
  - 若模型超过 4 个，前 4 个独立展示，第 5 个及以后聚合为统一的“其他 (Others)”合并项；
  - 保证圆饼图切片、微型图例标签与右侧高亮映射的数据结构 100% 封闭对齐。

---

### 缺陷 ISSUE-10：UsageTrendChart X 轴抽稀算法靠 points.length 盲猜时间范围违背单一真理源（SSOT）
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:62-66`
- **缺陷确凿证据**：
  ```tsx
  // UsageTrendChart.tsx:62-66
  const rangeGuess: '24h' | '7d' | '30d' = useMemo(() => {
    if (points.length <= 8) return '7d';
    if (points.length <= 25) return '24h';
    return '30d';
  }, [points.length]);
  ```
  1. 父组件 `SettingsUsageTab` 明确维护着用户当前选择的全局时间范围真源 `globalRange`（`'24h' | '7d' | '30d'`）。
  2. 但 `UsageTrendChartProps` 接口中并未接收 `range` 参数，而是让子组件根据 `points.length` 盲猜。
  3. 当后端在 30d 模式下因历史时间窗口较短仅聚合出 18 个点时，`points.length = 18`，子组件将错误判定为 `24h` 模式，并去匹配 `endsWith('00:00')` 等小时刻度，导致抽稀逻辑完全错乱、X 轴刻度消失。
  4. 违背 `ANTI_OVERENGINEERING_GUARDRAILS.md` 与单一真理源（SSOT）铁律。
- **根因分析**：
  设计组件 props 契约时不严密，用下游猜测替代上游确定性状态传递。
- **修复加固建议**：
  在 `UsageTrendChartProps` 中增加 `range: '24h' | '7d' | '30d'` 显式参数，由父组件直接传入，彻底删除 `rangeGuess` 猜测逻辑。

---

### 缺陷 ISSUE-11：ActivityMatrixHeatmap X 轴刻度采用 space-between 导致刻度中轴线与矩阵单元格脱靶错位
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:165-175`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.module.css:126-134`
- **缺陷确凿证据**：
  ```tsx
  // ActivityMatrixHeatmap.tsx:165-175
  <div className={styles.activityXAxis}>
    {cols.length > 0 ? (
      <>
        <span>{cols[0]}</span>
        {cols.length > 4 && <span>{cols[Math.floor(cols.length / 2)]}</span>}
        <span>{cols[cols.length - 1]}</span>
      </>
    ) : (
      <span>-</span>
    )}
  </div>
  ```
  ```css
  /* ActivityMatrixHeatmap.module.css:126-134 */
  .activityXAxis {
    margin-left: 72px;
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--text-tertiary);
  }
  ```
  1. `.activityXAxis` 采用 `display: flex; justify-content: space-between;` 排版首、中、末 3 个时间标签。
  2. `justify-content: space-between` 将 `cols[0]` 紧贴在容器最左侧，`cols[cols.length - 1]` 紧贴在容器最右侧。
  3. 但上方热力图单元格自身有宽度和圆角，第 0 列单元格的几何中心与末列单元格的几何中心分别距离左右边缘有半个单元格的位移裕量。
  4. 当处于 24h 或 7d 模式、单元格达到 `max-width: 20px` 限制而整行未占满宽度时，热力图方块聚集在左侧，而 X 轴标签却通过 `space-between` 强制撑到了容器的最右端边缘，导致标签与上方数据列发生明显的“脱靶式错位”。
- **根因分析**：
  未对齐真实列索引的中轴线坐标，粗暴使用 flex `space-between` 替代数学绝对定位或 Grid 轨道对齐。
- **修复加固建议**：
  根据列索引的百分比位置（类似走势图抽稀刻度的 `leftPercent` 与 `transform`），使时间刻度的中心点精确吸附在对应单元格的垂直中轴线上。

---

### 缺陷 ISSUE-12：UsageSummaryHero 接口声明并传入 dailyAverageTokens 却在解构中丢弃，右侧子项凑数破坏指标对等性
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.tsx:12, 17-25, 43-56, 75-92`
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx:129`
- **缺陷确凿证据**：
  1. `SettingsUsageTab.tsx:129` 显式向 `UsageSummaryHero` 传入：
     ```tsx
     dailyAverageTokens={dashboardData.hero.dailyAverageTokens}
     ```
  2. `UsageSummaryHero.tsx:12` 接口定义了该属性：`dailyAverageTokens?: number;`。
  3. 但在组件入参解构（第 17~25 行）中，`dailyAverageTokens` 被完全忽略丢弃。
  4. 左右卡片子项指标排版出现信息不对称：
     - 左卡片：输入 `totalInput`、输出 `totalOutput`、缓存 `totalCacheRead`；
     - 右卡片：日均花费 `dailyAverageCost`、计费标准（静态写死“官方标准费率”）、结算币种（静态写死“CNY”）；
     - 左侧缺少日均用量，右侧后两项纯属静态文字占位，左右卡片统计维度脱节。
- **根因分析**：
  编码疏忽，接收了属性却未消费，用无信息的静态文字应付右侧卡片子栅格。
- **修复加固建议**：
  解构并在左侧卡片展示 `dailyAverageTokens`（如日均 Token 吞吐），或建立规范的左右对应指标（例如：左侧为输入/输出/日均，右侧为总额/日均花费/计费标准）。

---

### 缺陷 ISSUE-13：UsageSummaryHero 中文字符“官方标准费率”被强加 font-mono 等宽字体导致中文字形回退失真
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.module.css:89-97`
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.tsx:86`
- **缺陷确凿证据**：
  ```css
  /* UsageSummaryHero.module.css:89-97 */
  .subValue {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  ```
  ```tsx
  // UsageSummaryHero.tsx:85-87
  <div className={styles.subItem}>
    <span className={styles.subLabel}>计费标准</span>
    <span className={styles.subValue}>官方标准费率</span>
  </div>
  ```
  1. `.subValue` 在 CSS 中设置了 `font-family: var(--font-mono)`。
  2. 左卡片的子项均为数字（如 `12.5 万`），使用等宽字体尚属合理；但右卡片第 2 项的值是纯中文文本“官方标准费率”。
  3. 在 Windows 宿主环境下，等宽英文字体（Consolas、Courier New 等）不包含中文字形，浏览器会触发系统的中文字体回退，强制回退至老旧点阵中文字体（如 NSimSun / 新宋体），导致中文字符笔画发虚、字间距突变僵硬，破坏界面的精细质感。
- **根因分析**：
  样式类名一刀切，未将纯数值与纯中文文本样式细分解耦。
- **修复加固建议**：
  `.subValue` 默认继承系统主无衬线字体 `var(--font-sans)`，仅对包含纯数字度量值的节点追加专属的 `.subValueMono` 或利用 `font-variant-numeric: tabular-nums` 保证数字等宽。

---

### 缺陷 ISSUE-14：PriceConfigModal.module.css 残留死类名 .searchInput 与全局多处硬编码 #f5f5f5 / #ffffff 兜底
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.module.css:24-27, 70, 90, 110`
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.tsx:183`
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css:39, 46, 53`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.module.css:134`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:312`
- **缺陷确凿证据**：
  1. `PriceConfigModal.module.css:24-27` 定义了 `.searchInput { flex: 1; max-width: 260px; }`，但在 `PriceConfigModal.tsx:175-184` 中根本未曾引用该类，而是在 JSX 行内裸写了 `style={{ width: '150px' }}`，属于死样式类残留与内联样式违规并存。
  2. `PriceConfigModal.module.css:70` 硬编码旧式 rgba 回退：`var(--bg-hover, rgba(128, 128, 128, 0.08))`。
  3. `PriceConfigModal.module.css:90, 110` 硬编码纯白背景回退：`var(--bg-card, #ffffff)`。
  4. `SettingsUsageTab.module.css:39, 46, 53` 骨架屏硬编码亮色背景回退：`var(--bg-subtle, #f5f5f5)`。在暗色模式下，若变量尚未就绪，会闪现刺眼的浅灰色块。
  5. `UsageTrendChart.module.css:134` 悬浮卡片硬编码阴影：`box-shadow: 0 4px 18px rgba(0, 0, 0, 0.08);`，未对接系统 `--shadow-popover` 或 `--shadow-card`。
  6. `UsageTrendChart.tsx:312` 悬浮节点圆心填充硬编码纯白：`<circle fill="#ffffff" />`，暗色主题下悬浮节点露出突兀的白底。
- **根因分析**：
  残留死代码未做清理，随手编写固定十六进制色值与旧式 rgba 兜底，脱离系统统一 Design Tokens 体系。
- **修复加固建议**：
  1. 物理删除 `PriceConfigModal.module.css` 中的 `.searchInput` 死类名，清理行内 `style={{ width: '150px' }}`；
  2. 全量清退所有 `#ffffff`、`#f5f5f5` 与旧式 `rgba` 回退，统一收敛至标准系统设计变量（`var(--bg-card)`、`var(--bg-subtle)`、`var(--bg-hover)`、`var(--shadow-popover)`）。

---

## 结论与整改对照矩阵

| 缺陷编号 | 严重度 | 涉及模块 | 核心性质 | 整改抓手 |
| :--- | :--- | :--- | :--- | :--- |
| **ISSUE-01** | **P1** | `SettingsUsageTab` / `UsageSummaryHero` | 视觉边缘顶死与无内边距断层 | `.heroGrid` 增加 `padding: 20px 22px` 与底部分界 |
| **ISSUE-02** | **P1** | `PriceConfigModal` / `EditablePriceRow` | 暴力覆盖导致双重边框与高度失范 | 物理清退 `.cellInput` 尺寸覆盖，统一 `size="sm"` |
| **ISSUE-03** | **P1** | `UsageSummaryHero` | 主指标数值与单位重复（¥ 0.00 CNY） | `formatCost` 剥除前缀，镜像对齐纯数值+单位规范 |
| **ISSUE-04** | **P1** | `ActivityMatrixHeatmap` | 独立容器解耦致 Y 轴与矩阵严重错位 | 将行标题与单元格合并入同一统一 Row 网格容器 |
| **ISSUE-05** | **P1** | `tokens.css` | 散落 10 处旧式 rgba 语法并残留死 Token | 物理删除 `--usage-seg-*`，全面换装现代 HSL / 斜杠透明度 |
| **ISSUE-06** | **P1** | `tokens.css` | 暗色模式缺少用量 Token 导致对比度劣化 | 在 `html[data-theme='dark']` 中注入专属暗色用量变量 |
| **ISSUE-07** | **P1** | `UsageTrendChart` / `EditablePriceRow` | 破坏 Button icon 契约且内联覆盖 | 改走 `icon` prop，彻底清理外部覆盖 class 与内联 style |
| **ISSUE-08** | **P1** | `PriceConfigModal` | 魔术数字 186px 测距与原生 DOM style 操控 | 改走标准 CSS 相对定位与 `:hover`，消灭魔术数字 |
| **ISSUE-09** | **P2** | `ModelDistributionSection` | 饼图(5)、图例(4)、列表(全量)数量脱节 | 统一数据模型，第 5 项及以后统一归并为“其他” |
| **ISSUE-10** | **P2** | `UsageTrendChart` | 靠采样点数量盲猜时间范围违背 SSOT | 接口显式增加 `range` prop，由父级真源直接下发 |
| **ISSUE-11** | **P2** | `ActivityMatrixHeatmap` | X 轴 space-between 导致刻度与列脱靶 | 基于列索引中心坐标进行百分比锚点绝对对齐 |
| **ISSUE-12** | **P2** | `UsageSummaryHero` | 弃置 dailyAverageTokens，右侧凑数占位 | 消费日均用量指标，对齐左右卡片统计维度 |
| **ISSUE-13** | **P2** | `UsageSummaryHero` | 中文字符被强加 font-mono 致字体失真 | 默认继承 `font-sans`，仅对数值指标应用等宽 |
| **ISSUE-14** | **P3** | 全局 CSS / TSX | 死样式残留与 `#f5f5f5` / `#ffffff` 硬编码 | 清理 `.searchInput`，统一收敛至标准 Design Tokens |
