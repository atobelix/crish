# 用量监控控制台 UI 组件规范与视觉样式终审报告（Post-Fix）

## 一、排查项对照结论表

| 序号 | 重点排查项 | 状态 | 缺陷编号与判定 |
| :--- | :--- | :--- | :--- |
| 1 | 残留私造样式类（`_heroSubtext`、`_labelDot`、`_labelDotCost`、`_btnAvgToggle` 均线功能） | **存在残留违规** | P1（ISSUE-02）：`_heroSubtext` 等已清退，但 `PriceConfigModal.module.css` 新增私造覆盖类 `.deleteBtn` 并滥用 `!important` |
| 2 | 全仓严格禁止 `rgba` 语法？`tokens.css` 残留排查？现代色彩空间转换与暗色模式深色调优？ | **严重不达标** | P1（ISSUE-01）+ P2（ISSUE-04）：`tokens.css` 用量 Token 错置进 `[data-ui-size='large']` 导致常规档位失效；`tokens.css` 仍残留 20 处旧式 `rgba(...)` |
| 3 | 最上方 `UsageSummaryHero` 卡片完全重构为单行极简仪表盘？拔除冗余小字行？中英文字体统一（排查 mono 中文污染）？ | **部分违规** | P1（ISSUE-03）：卡片结构已重构且拔除冗余行，但周边多个组件严重存在 `var(--font-mono)` 污染中文字符问题 |
| 4 | 带图标按钮（配置单价、刷新、清空历史、删除模型单价）是否 100% 对齐系统规范？垂直居中、icon prop、清退外部样式覆盖？删除按钮是否为标准 28x28px 正方形微型图标按钮？ | **严重不达标** | P1（ISSUE-02）+ P3（ISSUE-10）：删除按钮未接入系统 `<IconButton>` 原子基元，用外部 `.deleteBtn` 强行 `!important` 覆盖尺寸；图标混用非标 `size={13}` |
| 5 | 单价弹窗（`PriceConfigModal`）：彻底删除 `.cellInput` 尺寸覆盖？整行组件尺寸统一对齐为 `size="sm"`（28px）？智能建议浮层消除魔术数字与 window 坐标计算？操作列拓宽至 84px？ | **部分不规范** | P1（ISSUE-02）+ P3（ISSUE-11、ISSUE-12）：`.cellInput` 已删，尺寸统一 28px，建议浮层已改为 CSS 绝对定位，列宽拓宽至 84px；但操作列仍有外部覆盖，JSX 残留内联 `style`，按张计费单位文案漂移 |
| 6 | 热力图（`ActivityMatrixHeatmap`）：行标题、单元格与 X 轴刻度在同一 Grid 轨道严格同轴居中对齐（`justify-items: center`）？彻底消除脱靶错位与 OKLCH 硬编码覆盖？ | **部分违规** | P2（ISSUE-06、ISSUE-08）：模块已剔除 OKLCH 硬编码，但 X 轴刻度使用 `text-align` 冒充网格对齐导致首尾刻度脱靶向外溢出；单元格存在 `tabIndex={0}` 但缺失无障碍名称 |
| 7 | 模型用量（`ModelDistributionSection`）：饼图切片、图例与右侧胶囊列表统一 1:1 聚合（前 4 项 + 第 5 项聚合“其他”）？hover 交互彻底清除 `opacity: 0.75` 死灰降透明度和圆环抖动？ | **部分违规** | P1（ISSUE-03）+ P2（ISSUE-07）：1:1 聚合与 hover 滤镜已完成，但内层进度条在 100% 满额时突破右侧边界被裁切破坏同心圆角；胶囊与图例文本存在 mono 中文污染 |
| 8 | 孤立死代码：`UsageChart.tsx` 与 `UsageModelTable.tsx` 是否已被物理删除？ | **已达标** | 经全仓路径扫描与引用排查，两文件已被彻底物理删除，零悬空导入 |

---

## 二、缺陷统计

- **P1（严重违规、架构断层与样式/视觉破坏）**：3 项
- **P2（规范违背、几何溢出与无障碍缺陷）**：5 项
- **P3（工程整洁度、硬编码与文本歧义瑕疵）**：4 项
- **总计**：12 项确凿问题

---

## 三、缺陷详细清单

### 缺陷 ISSUE-01：`tokens.css` 核心用量 Tokens 被错误包裹在 `[data-ui-size='large']` 选择器内，导致标准与小尺寸档位全局失效
- **严重度**：P1
- **涉及文件与行号**：`apps/crish-desktop/src/styles/tokens.css:1538, 1619-1654`
- **缺陷确凿证据**：
  ```css
  /* tokens.css:1538 */
  [data-ui-size='large'] {
    --settings-sidebar-width: 260px;
    ...
    --md-table-cell-pad-y: 10px;

    /* ── 用量监控与时序分析（Usage Dashboard）专用系统设计规范 ── */
    /* 胶囊进度行：outer(9px) = inner(6px) + pad(3px) */
    --usage-capsule-outer-radius: 9px;
    --usage-capsule-pad: 3px;
    --usage-capsule-inner-radius: calc(var(--usage-capsule-outer-radius) - var(--usage-capsule-pad)); /* 6px */

    /* 色彩体系回退 (现代 HSL / 斜杠透明度，严格零 rgba) */
    --usage-color-brand: hsl(160 84% 39%);
    --usage-color-brand-bg: hsl(160 84% 39% / 0.11);
    --usage-color-claude: hsl(25 95% 53%);
    --usage-color-claude-bg: hsl(25 95% 53% / 0.11);
    --usage-color-minimax: hsl(258 90% 66%);
    --usage-color-minimax-bg: hsl(258 90% 66% / 0.11);
    --usage-color-kimi: hsl(200 98% 39%);
    --usage-color-kimi-bg: hsl(200 98% 39% / 0.11);
    --usage-color-other: hsl(38 92% 50%);
    --usage-color-other-bg: hsl(38 92% 50% / 0.11);
    --usage-color-input: hsl(200 98% 39%);
    --usage-color-input-bg: hsl(200 98% 39% / 0.11);
    --usage-color-cache: hsl(258 90% 66%);
    --usage-color-cache-bg: hsl(258 90% 66% / 0.11);
    --usage-color-cost-total: hsl(221 83% 53%);
    --usage-color-cost-total-bg: hsl(221 83% 53% / 0.10);
    --usage-color-total: hsl(160 84% 39%);
    --usage-color-total-bg: hsl(160 84% 39% / 0.11);
    --usage-color-danger: hsl(0 84% 60%);
    --usage-color-danger-bg: hsl(0 84% 60% / 0.08);

    /* 热力图 5 级颜色 */
    --usage-heat-0: color-mix(in srgb, var(--border-color) 40%, transparent);
    --usage-heat-1: color-mix(in srgb, var(--brand, #10b981) 25%, transparent);
    --usage-heat-2: color-mix(in srgb, var(--brand, #10b981) 50%, transparent);
    --usage-heat-3: color-mix(in srgb, var(--brand, #10b981) 75%, transparent);
    --usage-heat-4: var(--brand, #10b981);
  } /* line 1653 */
  ```
- **根因分析**：
  前序修改未在 1618 行正确闭合 `[data-ui-size='large']` 的后括号，导致整个用量监控系统的浅色模式全局基础设计变量（几何圆角、内边距、品牌色系、热力图 5 阶色标）被强行塞进大尺寸档位作用域。在默认标准尺寸及小尺寸档位下，根节点无法获取任何上述变量，被迫降级至各组件的局部 fallback 值。此外，暗色模式定义块（1423-1452 行）中同样缺失 `--usage-capsule-*` 几何定义。
- **修复加固建议**：
  1. 在 `tokens.css:1618` 之后立即闭合 `[data-ui-size='large']`；
  2. 将 1619-1653 行迁移至 `:root, html[data-theme='light']` 全局基座中；
  3. 在 `:root` 与 `html[data-theme='dark']` 中均确保 `--usage-capsule-outer-radius: 9px;`、`--usage-capsule-pad: 3px;`、`--usage-capsule-inner-radius: 6px;` 全局可访问。

---

### 缺陷 ISSUE-02：`PriceConfigModal` 外部私造覆盖样式 `.deleteBtn` 使用 `!important` 强行篡改按钮尺寸，未接入系统原子 `<IconButton>`
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.module.css:127-131`
  - `apps/crish-desktop/src/components/settings/EditablePriceRow.tsx:4, 145-156`
- **缺陷确凿证据**：
  ```css
  /* PriceConfigModal.module.css:127-131 */
  .deleteBtn {
    width: 28px !important;
    padding: 0 !important;
    flex-shrink: 0;
  }
  ```
  ```tsx
  // EditablePriceRow.tsx:145-156
  <Tooltip content="删除该模型单价">
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={styles.deleteBtn}
      icon={<Lucide.Trash2 size={13} />}
      onClick={onDelete}
      aria-label={`删除 ${row.model}`}
    />
  </Tooltip>
  ```
- **根因分析**：
  1. 违背 `AGENTS.md` §7（严禁打补丁、绕过与私造外部样式覆盖）；
  2. 违背核心排查清单第 4 项（“带图标的按钮是否 100% 对齐系统规范？垂直居中、icon prop、以及清退所有外部样式覆盖？删除按钮是否为标准 28x28px 正方形微型图标按钮？”）；
  3. `apps/crish-desktop/src/components/ui` 已经正式导出标准的原子级正方形图标按钮基元 `<IconButton>`（`ui/Button/IconButton.tsx`），其内部在 `size="sm"` 时自动具备 `--btn-h: 28px`、`width: var(--btn-h)`（28px）、`padding: 0`、原生支持 `tooltip` 属性与 `aria-label` 校验。业务代码未引入标准原子基元，反而使用常规 `<Button>` 并在外部 CSS 文件声明 `.deleteBtn` 搭配 `!important` 进行尺寸覆盖，属于粗暴打补丁。
- **修复加固建议**：
  1. 物理删除 `PriceConfigModal.module.css` 中的 `.deleteBtn`；
  2. 在 `EditablePriceRow.tsx` 中移除 `<Tooltip>` 外层包裹与 `styles.deleteBtn` 引用，从 `../ui` 导入并直接使用 `IconButton`：
     ```tsx
     <IconButton
       variant="ghost"
       size="sm"
       icon={<Lucide.Trash2 size={14} />}
       tooltip="删除该模型单价"
       aria-label={`删除 ${row.model}`}
       onClick={onDelete}
     />
     ```

---

### 缺陷 ISSUE-03：用量模块多处将 `var(--font-mono)` 施加于含中文文本的容器，导致 Windows 环境出现中文字体回退点阵宋体（SimSun）污染
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.module.css:205-214, 227-233`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:137, 253, 257`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.module.css:136-141`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:317`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.module.css:220-227`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:230`
- **缺陷确凿证据**：
  1. `ModelDistributionSection.module.css:206`:
     ```css
     .capsuleModelName { font-family: var(--font-mono); }
     ```
     在 `ModelDistributionSection.tsx:137` 中，聚合模型项名称为 `其他 (${models.length - 4} 个模型)`，其中包含汉字“其他”与“个模型”，直接落在 monospace 字体栈中。
  2. `ModelDistributionSection.module.css:228`:
     ```css
     .capsuleTokenVal { font-family: var(--font-mono); }
     ```
     在 `ModelDistributionSection.tsx:257` 中渲染 `{formatTokens(item.tokens)}`。当 Token 数量超过 10,000 时，`formatTokens` 输出如 `12.5 万`、`1.2 亿` 等包含汉字“万”和“亿”的字符串，同样受 monospace 污染。
  3. `UsageTrendChart.module.css:137`:
     ```css
     .tooltipRowVal { font-family: var(--font-mono); }
     ```
     悬浮卡片数值在“吞吐总览”和“模型对比”维度调用 `formatTokens`，带有汉字“万”和“亿”。
  4. `ActivityMatrixHeatmap.module.css:221`:
     ```css
     .actStatValCode { font-family: var(--font-mono); }
     ```
     在 `ActivityMatrixHeatmap.tsx:230` 中作用于用户项目名称 `heroStats.topProject`，项目名称经常为全中文（如“中文翻译”、“后台重构”）。
- **根因分析**：
  `tokens.css:450` 中 `--font-mono` 仅包含英文字体：`'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Segoe UI Mono', 'SF Mono', Consolas, 'Liberation Mono', ui-monospace, monospace`。当该字体栈遇到汉字字符时，浏览器被迫回退到系统最底层的等宽中文字体（在 Windows 下为中易宋体 / SimSun 点阵或带衬线字体），字体边缘产生锯齿与高矮不一的变形。
- **修复加固建议**：
  1. 涉及带中文单位的数值容器（`.capsuleTokenVal`、`.tooltipRowVal`），全面剔除 `font-family: var(--font-mono)`，改用系统统一无衬线字体及等宽数字属性：
     ```css
     font-family: var(--font-sans);
     font-variant-numeric: tabular-nums;
     ```
  2. 针对 `.capsuleModelName`，若为聚合的“其他”项，不应强制设定为纯 mono；
  3. 针对 `.actStatValCode` 中的 `topProject`，移除 `var(--font-mono)` 声明。

---

### 缺陷 ISSUE-04：`tokens.css` 仍残留 20 处旧式 `rgba(...)` 裸写，违背 AGENTS.md 现代色彩空间铁律
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/styles/tokens.css:212, 217, 367, 411, 948, 1001, 1023, 1027, 1032, 1045, 1046, 1117, 1118, 1120, 1121, 1123, 1124, 1153, 1690, 1696`
- **缺陷确凿证据**：
  ```css
  Line 212:  --sep-bg-input: rgba(29, 28, 26, 0.03);
  Line 217:  --sep-divider-color: rgba(29, 28, 26, 0.06);
  Line 367:  --xterm-selection: rgba(255, 255, 255, 0.18);
  Line 411:  --bg-glass: rgba(255, 255, 255, 0.75);
  Line 948:  --switch-thumb-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  Line 1001: --bg-panel: rgba(24, 23, 21, 0.96);
  Line 1023: --sep-bg-panel: rgba(24, 23, 21, 0.96);
  Line 1027: --sep-bg-input: rgba(245, 244, 240, 0.04);
  Line 1032: --sep-divider-color: rgba(255, 255, 255, 0.07);
  Line 1045: 0 4px 18px rgba(0, 0, 0, 0.28),
  Line 1046: 0 1px 3px rgba(0, 0, 0, 0.18);
  Line 1117: 0 1px 2px rgba(0, 0, 0, 0.16),
  Line 1118: 0 1px 1px rgba(0, 0, 0, 0.10);
  Line 1120: 0 2px 8px rgba(0, 0, 0, 0.20),
  Line 1121: 0 1px 2px rgba(0, 0, 0, 0.12);
  Line 1123: 0 4px 18px rgba(0, 0, 0, 0.28),
  Line 1124: 0 1px 3px rgba(0, 0, 0, 0.18);
  Line 1153: --bg-glass: rgba(10, 10, 10, 0.75);
  Line 1690: --bg-glass: rgba(255, 255, 255, 0.75);
  Line 1696: --bg-glass: rgba(10, 10, 10, 0.75);
  ```
- **根因分析**：
  违背 `AGENTS.md` §14（“优先 HSLA / 斜杠透明度：避免散落旧式 rgba(r,g,b,a)；UI 与 Design Token 优先 hsl(h s l / a) 或 color-mix，用斜杠 / 分隔不透明度”）以及排查清单第 2 项之刚性要求。
- **修复加固建议**：
  将上述所有旧式 `rgba(r,g,b,a)` 改造为现代斜杠透明度 `hsl(h s l / a)` 或 `color-mix(in srgb, ...)`。例如：
  - `rgba(255, 255, 255, 0.75)` -> `hsl(0 0% 100% / 0.75)`
  - `rgba(10, 10, 10, 0.75)` -> `hsl(0 0% 4% / 0.75)`
  - 阴影中的 `rgba(0, 0, 0, a)` -> `color-mix(in srgb, var(--shadow-color, #000) a%, transparent)`

---

### 缺陷 ISSUE-05：`SettingsUsageTab.module.css` 引用虚空变量 `--shadow-card` 且无任何 fallback，导致卡片外框阴影丢失
- **严重度**：P2
- **涉及文件与行号**：`apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css:13`
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
- **根因分析**：
  全局设计系统 `tokens.css` 中定义的标准阴影阶梯为 `--shadow-sm`、`--shadow-md`、`--shadow-lg`、`--shadow-drag`、`--shadow-2xl`，不存在 `--shadow-card`。此处裸写未定义的变量且未传第二参数，导致该 CSS 规则被浏览器判定为 invalid 忽略，卡片阴影缺失。
- **修复加固建议**：
  对齐设计系统卡片规范，改为：
  ```css
  box-shadow: var(--shadow-sm);
  ```

---

### 缺陷 ISSUE-06：热力图 X 轴在 CSS Grid 中使用 `text-align` 假对齐，导致首尾刻度向容器外侧脱靶悬空
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.module.css:130-158`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:180-184`
- **缺陷确凿证据**：
  ```css
  /* ActivityMatrixHeatmap.module.css:130-158 */
  .activityXAxis {
    flex: 1;
    display: grid;
    gap: 4.5px;
    justify-items: center;
  }

  .xAxisColFirst {
    text-align: left;
  }

  .xAxisColLast {
    text-align: right;
  }
  ```
- **根因分析**：
  在 CSS Grid 中，父容器设定了 `justify-items: center`。子元素 `<span className="xAxisColLabel xAxisColFirst">` 是宽度自适应的 inline 元素，其外边框严格包裹文字自身。在网格布局中对自适应宽度的项声明 `text-align: left` **没有任何定位位移能力**，首列文本中心依然被对齐在首列轨道中央（约 8px 位置）。对于 35px 宽度的日期标签（如“03-01”），文本左缘会悬空溢出左边界 9.5px，侵入左侧间隙并与左侧 Y 轴标签错位撞击。
- **修复加固建议**：
  在 CSS Grid 中使用专用的自对齐属性覆盖 `justify-items`：
  ```css
  .xAxisColFirst {
    justify-self: start;
  }
  .xAxisColMid {
    justify-self: center;
  }
  .xAxisColLast {
    justify-self: end;
  }
  ```

---

### 缺陷 ISSUE-07：模型用量胶囊内层同心进度条在 100% 满额时突破右侧内边距，被父级 `overflow: hidden` 横切削平圆角
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.module.css:162-186`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:230, 244`
- **缺陷确凿证据**：
  ```css
  /* ModelDistributionSection.module.css */
  .modelCapsuleRow {
    position: relative;
    border-radius: var(--usage-capsule-outer-radius, 9px);
    overflow: hidden;
  }

  .capsuleBarBg {
    position: absolute;
    left: var(--usage-capsule-pad, 3px);
    top: var(--usage-capsule-pad, 3px);
    bottom: var(--usage-capsule-pad, 3px);
    border-radius: var(--usage-capsule-inner-radius, 6px);
  }
  ```
  ```tsx
  // ModelDistributionSection.tsx:230, 244
  const barWidth = normRatio > 0 ? Math.max(2, Math.min(100, normRatio * 100)) : 0;
  // barWidth = 100% 时，left=3px + width=100% => 右边界 = 100% + 3px
  ```
- **根因分析**：
  `.capsuleBarBg` 绝对定位具有 `left: 3px`。当某模型占比接近 100% 时，`width: 100%` 导致右边界溢出父容器 3px。父容器虽然有 `overflow: hidden`，但截断破坏了右侧原本应保留的 3px 气垫，使得内层 6px 圆角在右侧被生硬裁切成垂直平角，破坏了同心圆角几何标尺。
- **修复加固建议**：
  为 `.capsuleBarBg` 施加右侧最大边界几何约束：
  ```css
  .capsuleBarBg {
    max-width: calc(100% - (var(--usage-capsule-pad, 3px) * 2));
  }
  ```
  保证左右对称保留 3px 气垫，100% 时依然具备完美的 6px 同心内圆角。

---

### 缺陷 ISSUE-08：热力图单元格被赋予 `tabIndex={0}` 纳入键盘导航，却未声明无障碍语义属性（`aria-label` 与 `role`）
- **严重度**：P2
- **涉及文件与行号**：`apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:144-148`
- **缺陷确凿证据**：
  ```tsx
  // ActivityMatrixHeatmap.tsx:144-148
  <Tooltip
    key={`cell_${rIdx}_${cIdx}`}
    content={tooltipText}
    side="top"
  >
    <div
      className={`${styles.activityCell} ${getLevelClass(cell.level)}`}
      tabIndex={0}
    />
  </Tooltip>
  ```
- **根因分析**：
  元素声明了 `tabIndex={0}`，键盘用户可以通过 Tab 键按序获得焦点。但该元素为无语义 `<div>`，既未指定 `role="gridcell"`，也未挂载 `aria-label`，屏幕阅读器聚焦时无法播报任何用量与调用次数信息。
- **修复加固建议**：
  为可聚焦单元格补齐标准无障碍属性：
  ```tsx
  <div
    role="gridcell"
    aria-label={tooltipText}
    className={`${styles.activityCell} ${getLevelClass(cell.level)}`}
    tabIndex={0}
  />
  ```

---

### 缺陷 ISSUE-09：`SettingsUsageTab.module.css` 骨架屏硬编码浅色 `#f5f5f5` 与硬编码动画时间，未适配减弱动画模式
- **严重度**：P3
- **涉及文件与行号**：`apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css:39, 46, 53, 58-65`
- **缺陷确凿证据**：
  ```css
  /* SettingsUsageTab.module.css:37-56 */
  .skeletonHeader {
    height: 60px;
    background: var(--bg-subtle, #f5f5f5);
    border-radius: var(--radius-md, 6px);
    animation: shimmer 1.5s infinite ease-in-out;
  }
  ```
- **根因分析**：
  1. `#f5f5f5` 是写死的浅色十六进制值，深色模式下若触发 fallback 会产生高亮白斑；
  2. 动画时间硬编码 `1.5s`，未复用 `tokens.css:426` 声明的 `--transition-skeleton: 1.5s ease-in-out;`；
  3. 未在 `@media (prefers-reduced-motion: reduce)` 下暂停动画。
- **修复加固建议**：
  移除十六进制硬编码，接入系统设计 Token：
  ```css
  background: var(--bg-subtle);
  animation: shimmer var(--transition-skeleton, 1.5s ease-in-out) infinite;
  ```

---

### 缺陷 ISSUE-10：刷新与清空等小号按钮内部图标混用 `size={13}` 与 `size={14}`，脱离系统统一标尺
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx:159, 172`
  - `apps/crish-desktop/src/components/settings/EditablePriceRow.tsx:151`
- **缺陷确凿证据**：
  - `SettingsUsageTab.tsx:159`: `<Lucide.RefreshCw size={13} />`
  - `SettingsUsageTab.tsx:172`: `<Lucide.Trash2 size={13} />`
  - `EditablePriceRow.tsx:151`: `<Lucide.Trash2 size={13} />`
  - 对比：`SettingsUsageTab.tsx:106`: `<Lucide.DollarSign size={14} />`
- **根因分析**：
  系统 `tokens.css:773` 与 `Button.module.css:103` 明确规定 `data-size="sm"` 小号按钮标准图标尺寸为 `--btn-icon-size: 14px;`。混用 `13px` 导致 SVG 矢量产生非整数缩放锯齿与 1px 细微垂直偏心。
- **修复加固建议**：
  统一小号按钮内 Lucide 图标尺寸为 `size={14}`。

---

### 缺陷 ISSUE-11：`PriceConfigModal.tsx` 表头与单元格混入 JSX 内联 `style`
- **严重度**：P3
- **涉及文件与行号**：`apps/crish-desktop/src/components/settings/PriceConfigModal.tsx:193, 252`
- **缺陷确凿证据**：
  - Line 193: `<div style={{ textAlign: 'right' }}>操作</div>`
  - Line 252: `<div className={styles.colCell} style={{ position: 'relative' }}>`
- **根因分析**：
  残留 JSX 内联 style 破坏了 CSS Modules 集中式维护纪律。
- **修复加固建议**：
  在 `PriceConfigModal.module.css` 中声明 `.headerColAction { text-align: right; }` 与 `.addModelCell { position: relative; }`，彻底清除内联 `style`。

---

### 缺陷 ISSUE-12：`PriceConfigModal` 表头与悬浮提示对“按张”计费模型产生单位认知混淆
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.tsx:189-191`
  - `apps/crish-desktop/src/components/settings/EditablePriceRow.tsx:76, 89, 102`
- **缺陷确凿证据**：
  - 表头写死：`提示输入 ({currencySymbol}/1M)`、`生成补全 ({currencySymbol}/1M)`
  - Tooltip 写死：`提示词输入单价 (${currencySymbol}/1M Tokens)`
- **根因分析**：
  系统已扩展支持 `billingUnit: 'per_image'`（按张计费模式）。当用户查看图像生成模型的定价时，单价实际含义为“每次生成几元”，但表头与 Tooltip 依然强制提示“/1M Tokens”，信息表达存在歧义。
- **修复加固建议**：
  在 `EditablePriceRow` 的 Tooltip 中根据 `row.billingUnit` 动态区分单位文案（按张则展示 `元/张`，按 token 则展示 `元/1M Tokens`）。
