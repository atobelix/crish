# 用量监控控制台 UI 组件规范与视觉样式终审报告

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
- **遵循准则**：
  - 仓库协作指令 `AGENTS.md` §7（严禁补丁、绕过与作弊）、§12（Tooltip / 悬停提示规范）、§13（输入框与焦点态规范）、§14（色彩空间与现代 CSS 语法规范）；
  - `ANTI_OVERENGINEERING_GUARDRAILS.md` 反过度设计红线；
  - 任务核查清单 7 大死角核查项。
- **缺陷统计**：
  - **P1（严重违规、结构性视觉缺陷与交互破坏）**：6 项
  - **P2（样式规范违背、契约漂移与边界瑕疵）**：5 项
  - **P3（代码残留与工程清洁度瑕疵）**：2 项
  - **总计**：13 项确凿缺陷

---

## 7 大死角核查结论对照表

| 序号 | 重点排查项 | 状态 | 缺陷定级与编号 |
| :--- | :--- | :--- | :--- |
| 1 | 残留私造样式类（`_heroSubtext`、`_labelDot`、`_labelDotCost`、`_btnAvgToggle` 均线功能） | **存在残留** | P3（ISSUE-12、ISSUE-13）：UI 层类名已清退，但底层 `usageChartModel.ts` 契约残留 `avgVal`/`avgLabel` 幽灵字段；目录下残留 `UsageChart.tsx`/`UsageModelTable.tsx` 死文件 |
| 2 | 全仓严格禁止 `rgba` 语法？`tokens.css` 残留排查？现代色彩空间转换与暗色模式深色调优？ | **违规不达标** | P2（ISSUE-07、ISSUE-08）：`tokens.css` 残留 20 处 `rgba(...)`，`Button.module.css` 残留 1 处；暗色模式缺失前景色变量，热力图硬编码 OKLCH 导致暗色调优被强行遮蔽 |
| 3 | 最上方 `UsageSummaryHero` 是否完全重构为单行极简仪表盘？彻底拔除冗余小字行？ | **基本达标** | 无样式冗余小字行，但存在与弹窗货币配置默认值冲突的潜在问题（见 ISSUE-10） |
| 4 | 带图标按钮（配置单价、刷新、清空历史、删除模型单价）是否 100% 对齐规范？ | **部分不规范** | P2（ISSUE-11）：删除按钮为纯图标按钮，但未挂载 `.iconButton` 类，内边距致其为拉长矩形（34px）而非正方形（28x28px） |
| 5 | 单价弹窗：彻底删除 `.cellInput` 覆盖？统一 `size="sm"`？浮层消除魔术数字与原生 JS DOM style 补丁？ | **严重不达标** | P1（ISSUE-01、ISSUE-02）：`.cellInput` 已删且组件统一 `size="sm"`，但建议浮层残留魔术数字 `+4`/`240` 与 `createPortal` 动态算坐标；操作列宽度仅 48px 致编辑态双按钮溢出脱轨 |
| 6 | 热力图：行标题与单元格是否在同一 Row 容器中严格同轴对齐？X 轴刻度是否消除了脱靶错位？ | **部分不达标** | P1（ISSUE-03）：行标题与单元格已在同一 Row 容器实现垂直同轴，但 X 轴刻度使用独立 Flex `space-between` 与 Grid 轨道物理脱节，导致首尾与中间刻度发生 40px~70px 严重脱靶错位 |
| 7 | 模型用量：饼图切片、图例与右侧胶囊列表是否统一聚合？hover 交互是否不再有死灰降透明度和圆环抖动？ | **严重不达标** | P1/P2（ISSUE-05、ISSUE-06、ISSUE-07、ISSUE-09）：左侧 5 项聚合而右侧全量展开导致信息不对称；`getModelColor` 调色板回退加 4 溢出导致“其他”错染 Minimax 紫色；hover 仍有非选中切片 0.75 降透明度死灰感 |

---

## 缺陷清单

### 缺陷 ISSUE-01：PriceConfigModal 智能建议浮层残留魔术数字与 window 坐标 Portal 硬计算补丁
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.tsx:43-54, 265, 284-295`
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.module.css:109-119`
- **缺陷确凿证据**：
  ```tsx
  // PriceConfigModal.tsx:45-54
  const updateAddDropdownPos = () => {
    if (addInputRef.current) {
      const rect = addInputRef.current.getBoundingClientRect();
      setAddDropdownPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
        width: Math.max(rect.width, 240),
      });
    }
  };
  ```
  ```tsx
  // PriceConfigModal.tsx:284-295
  createPortal(
    <div
      className={styles.suggestionsDropdown}
      style={{
        position: 'fixed',
        bottom: `${addDropdownPos.bottom}px`,
        left: `${addDropdownPos.left}px`,
        width: `${addDropdownPos.width}px`,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
  ```
  1. `bottom: window.innerHeight - rect.top + 4` 包含魔术数字 `+ 4`。
  2. `width: Math.max(rect.width, 240)` 包含魔术数字 `240`。
  3. 使用 `createPortal(..., document.body)` 脱壳渲染，并通过内联 `style={{ position: 'fixed', bottom, left, width }}` 暴力注入由 JS 计算的视口绝对物理像素。
  4. `updateAddDropdownPos` 仅绑定在输入框的 `onChange` 与 `onFocus` 事件上，完全未监听窗口 resize 或滚动事件。当窗口缩放或产生滚动时，浮层停留在原物理坐标悬空，与输入框脱节错位。
- **根因分析**：
  未利用 CSS 相对定位能力，违背了 `AGENTS.md` §7 中“穿透表象找到架构断层，用原生、精确方式解决，严禁使用盲目猜测的魔术数字补偿与临时补丁”的铁律。新增行父级单元格已声明 `position: relative`，完全可以通过原生 CSS 绝对定位在上方向自适应展开。
- **修复加固建议**：
  废除 `createPortal`、`getBoundingClientRect` 以及 `addDropdownPos` 状态与内联样式计算，将下拉建议直接放置于输入框所在的父级相对定位容器内，在 `PriceConfigModal.module.css` 中声明：
  ```css
  .suggestionsDropdown {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    min-width: 100%;
    width: max-content;
    max-width: 260px;
    z-index: 50;
  }
  ```

---

### 缺陷 ISSUE-02：PriceConfigModal 表格操作列宽度仅 48px，编辑态双按钮与新增态按钮溢出破坏表格栅格
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.module.css:36-42`
  - `apps/crish-desktop/src/components/settings/EditablePriceRow.tsx:124-156`
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.tsx:364-376`
- **缺陷确凿证据**：
  ```css
  /* PriceConfigModal.module.css:36-42 */
  .tableHeader,
  .tableRow,
  .addRow {
    display: grid;
    grid-template-columns: minmax(130px, 2.2fr) minmax(75px, 1fr) minmax(75px, 1fr) minmax(75px, 1fr) 110px 48px;
    align-items: center;
    padding: 6px 12px;
    gap: 8px;
    box-sizing: border-box;
  }
  ```
  ```tsx
  // EditablePriceRow.tsx:124-156
  <div className={styles.colCell}>
    <div className={styles.rowActions}>
      {hasChanged && (
        <Button type="button" variant="secondary" size="sm" ...>保存</Button>
      )}
      <Tooltip content="删除该模型单价">
        <Button type="button" variant="ghost" size="sm" icon={<Lucide.Trash2 size={13} />} ... />
      </Tooltip>
    </div>
  </div>
  ```
  1. 第 6 列操作列的宽度被固定写死为 `48px`。
  2. 当单价数据发生修改时，`hasChanged` 为 `true`，`rowActions` 同时渲染“保存”按钮（宽度约 52px）与“删除”按钮（宽度约 34px），外加 `gap: 4px`，合计需要占用最小宽度约 `90px`。
  3. 在被限制为 `48px` 的栅格单元内，两按钮直接产生严重的横向溢出越界，超出表格外沿 `42px`，破坏行右侧对齐并触发非预期遮挡。
  4. 底部新增行 `addRow` 的第 6 列渲染“添加”按钮，其实际宽度同样大于 `48px`，导致新增行右侧边缘与上方表头脱靶错位。
- **根因分析**：
  网格模板 `grid-template-columns` 的最后一列未考虑编辑状态多动作并存的物理尺寸，仅以单图标态进行极限压缩，导致状态切换时栅格容积失守。
- **修复加固建议**：
  将表格最后一列由固定 `48px` 扩展为自适应弹性宽度（如 `minmax(72px, 84px)` 或 `88px`），确保“保存 + 删除”双动作并存及“添加”动作均能在网格约束内完整容纳：
  ```css
  .tableHeader,
  .tableRow,
  .addRow {
    display: grid;
    grid-template-columns: minmax(120px, 2.2fr) minmax(70px, 1fr) minmax(70px, 1fr) minmax(70px, 1fr) 105px 84px;
    gap: 8px;
  }
  ```

---

### 缺陷 ISSUE-03：ActivityMatrixHeatmap X 轴时间刻度脱靶错位（Flex space-between 与 Grid 离散列脱节）
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:116-120, 158-172`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.module.css:89-107, 117-137`
- **缺陷确凿证据**：
  ```tsx
  // ActivityMatrixHeatmap.tsx:158-172
  <div className={styles.activityXAxisWrapper}>
    <div className={styles.xAxisSpacer} />
    <div className={styles.activityXAxis}>
      {cols.length > 0 ? (
        <>
          <span>{cols[0]}</span>
          {cols.length > 4 && <span>{cols[Math.floor(cols.length / 2)]}</span>}
          <span>{cols[cols.length - 1]}</span>
        </>
      ) : (
        <span>—</span>
      )}
    </div>
  </div>
  ```
  ```css
  /* ActivityMatrixHeatmap.module.css:89-107, 129-137 */
  .cellsRow {
    flex: 1;
    display: grid;
    gap: 4.5px;
    min-width: 0;
    align-items: center;
  }
  .activityCell {
    aspect-ratio: 1 / 1;
    width: 100%;
    max-width: 20px;
    border-radius: 4px;
  }
  .activityXAxis {
    flex: 1;
    display: flex;
    justify-content: space-between;
    font-size: 10px;
  }
  ```
  1. 上方热力图单元格使用 CSS Grid 离散列布局（`grid-template-columns: repeat(N, 1fr)`）。当周期为 7 天时（N=7），若可用宽度为 600px，每列宽度约为 82px。
  2. `.activityCell` 被施加了 `max-width: 20px` 限制，且父级 `.cellsRow` 未设置 `justify-items: center`，导致单元格默认居左于 82px 的轨道内，第 7 列单元格仅延伸至容器宽度的约 512px 处，距离右边缘留白近 80px。
  3. 下方 X 轴容器 `.activityXAxis` 采用 `display: flex; justify-content: space-between;`，将末尾标签 `cols[cols.length - 1]` 顶到容器的最右边缘（100% 处，即 600px）。
  4. 现场物理断层：末尾日期刻度文字位于 600px，而对应的末尾热力图方块位于 512px，两者产生高达 `80px` 的严重脱靶错位；首尾及居中刻度均无法与对应列严格对齐。
- **根因分析**：
  X 轴时间刻度未使用与热力图单元格相同的 CSS Grid 轨道与几何列坐标，而是用松散的 Flex `space-between` 粗暴分布，且单元格未在网格轨道内居中对齐，引发离散轨道与连续弹性盒之间的几何断裂。
- **修复加固建议**：
  1. `.cellsRow` 补充 `justify-items: center;`，确保当单元格触达 `max-width: 20px` 时在自身网格列居中；
  2. X 轴刻度放弃 `justify-content: space-between`，改用与 `.cellsRow` 完全同构的 Grid 结构，或使用绝对百分比锚点（对齐第 `0` 列中心、`Math.floor(N/2)` 列中心、第 `N-1` 列中心），消除几何脱靶。

---

### 缺陷 ISSUE-04：UsageTrendChart 悬浮卡片在右侧边界处因双重补偿导致瞬间横跳 80px 视觉断裂
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:95-110`
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts:262-272`
- **缺陷确凿证据**：
  ```ts
  // UsageTrendChart.tsx:102-107
  const clampedX = clampViewportX(idealX, cardW, containerW, 6);
  const isNearRight = idealX > containerW - 170;

  return {
    left: `${clampedX}px`,
    transform: isNearRight ? 'translateX(-100%)' : 'translateX(-50%)',
    display: 'flex',
  };
  ```
  ```ts
  // usageSpline.ts:262-272
  export function clampViewportX(idealX: number, cardWidth: number, containerWidth: number, margin = 6): number {
    const half = cardWidth / 2;
    const minX = half + margin;
    const maxX = Math.max(minX, containerWidth - half - margin);
    return Math.min(Math.max(idealX, minX), maxX);
  }
  ```
  1. `clampViewportX` 本身的数学设计是以中心对齐（即默认 `translateX(-50%)`）为前提的视口钳位算法，返回的 `clampedX` 保证了卡片在 `translateX(-50%)` 时左右外沿均严格落在 `[margin, containerWidth - margin]` 安全范围内。
  2. 但代码在第 103 行与第 107 行额外叠加了人工启发式判断 `isNearRight = idealX > containerW - 170`，当满足条件时强制切换为 `transform: 'translateX(-100%)'`。
  3. 现场视觉断层：当鼠标从左向右移动，坐标穿过 `containerW - 170` 临界点的瞬间，卡片从中心对齐跳变至右侧贴齐，在 X 轴上产生瞬间左移 `cardW / 2`（约 80px）的突兀跳变，产生严重视觉闪烁与抖动感。
- **根因分析**：
  在已经具备精确平滑视口钳位纯函数 `clampViewportX` 的情况下，重复堆砌盲目猜测的坐标补偿补丁（反过度设计与反补丁铁律所禁止的典型双重补偿）。
- **修复加固建议**：
  彻底拔除 `isNearRight` 补丁逻辑，使悬停卡片恒定以 `translateX(-50%)` 为基准，全权交由 `clampViewportX` 保证视口贴边保护：
  ```ts
  const clampedX = clampViewportX(idealX, cardW, containerW, 6);
  return {
    left: `${clampedX}px`,
    transform: 'translateX(-50%)',
    display: 'flex',
  };
  ```

---

### 缺陷 ISSUE-05：ModelDistributionSection 饼图切片/图例与右侧胶囊列表聚合口径不一致导致信息架构断层
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:37-99, 178-235`
- **缺陷确凿证据**：
  ```tsx
  // ModelDistributionSection.tsx:37-39, 70-81
  const hasOthers = models.length > 5;
  const displayModels = hasOthers ? models.slice(0, 4) : models.slice(0, 5);
  // ... 左侧将超出部分聚合为单一切片 '__others__' / '其他'
  ```
  ```tsx
  // ModelDistributionSection.tsx:178-235
  <div className={styles.capsuleList}>
    {models.map((m, idx) => {
      // 右侧无截断无聚合，直接全量渲染所有模型
      const isHovered =
        hoveredModel === m.model ||
        (hoveredModel === '__others__' && idx >= 4);
      return (
        <div key={m.model} className={...}>
  ```
  1. 左侧圆环图与微型图例执行“最多 4 项 + 聚合‘其他’”口径（总数上限 5 项）。
  2. 右侧胶囊进度列表却对 `models` 进行全量映射（若有 15 个模型，右侧完整展开 15 个胶囊列表项），未提供任何“其他”聚合行。
  3. 联动交互混乱：当用户悬停在右侧第 5 个至第 15 个胶囊行时，均会触发左侧唯一的“其他”切片高亮；但悬停在左侧“其他”切片时，右侧第 5~15 行全部同时高亮，两端信息架构与聚合层级完全不统一。
- **根因分析**：
  重构时对数据展示密度的要求只在左侧 SVG 饼图落地，右侧列表层遗漏了相对应的聚合收口机制，造成左右两侧同一区块内的模型实体集合不一致。
- **修复加固建议**：
  统一左右数据聚合协议。若左侧以“前 4 项 + 其他”聚合，右侧列表同样应在前 4 项之后展示聚合的“其他”胶囊条（显示总 token 与百分比），并提供可折叠展开查看明细的二级弹层或统一全量展开，杜绝两端集合不对称。

---

### 缺陷 ISSUE-06：usageSpline.ts 中 getModelColor 调色板回退索引计算错误导致“其他”被误染为 Minimax 紫色
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts:61-68, 73-81`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:81`
- **缺陷确凿证据**：
  ```ts
  // usageSpline.ts:61-68
  export const GLOBAL_MODEL_PALETTE: ModelColorTheme[] = [
    { stroke: 'var(--usage-color-brand)', bg: 'var(--usage-color-brand-bg)' },      // 索引 0: 品牌翡翠绿
    { stroke: 'var(--usage-color-claude)', bg: 'var(--usage-color-claude-bg)' },    // 索引 1: Claude 暖橙色
    { stroke: 'var(--usage-color-minimax)', bg: 'var(--usage-color-minimax-bg)' },  // 索引 2: MiniMax 亮紫色
    { stroke: 'var(--usage-color-kimi)', bg: 'var(--usage-color-kimi-bg)' },        // 索引 3: Kimi 天蓝色
    { stroke: 'var(--usage-color-other)', bg: 'var(--usage-color-other-bg)' },      // 索引 4: 其他 暖黄色
    { stroke: 'var(--usage-color-cost-total)', bg: 'var(--usage-color-cost-total-bg)' }, // 索引 5: 费用 靛青色
  ];

  export function getModelColor(modelName: string, fallbackIdx = 0): ModelColorTheme {
    // ...
    return GLOBAL_MODEL_PALETTE[(fallbackIdx + 4) % GLOBAL_MODEL_PALETTE.length] ?? GLOBAL_MODEL_PALETTE[0]!;
  }
  ```
  ```ts
  // ModelDistributionSection.tsx:81
  const color = getModelColor('other', 4);
  ```
  1. `GLOBAL_MODEL_PALETTE` 索引 4 精确定义了为“其他”保留的调色板 `--usage-color-other`。
  2. `ModelDistributionSection` 在处理聚合模型时传入 `fallbackIdx = 4`。
  3. `getModelColor` 内部执行 `(fallbackIdx + 4) % 6`，计算结果为 `(4 + 4) % 6 = 8 % 6 = 2`！
  4. 索引 2 对应的正是 MiniMax 的专属紫色 `--usage-color-minimax`。
  5. 现场事实：界面上的“其他”切片和标签并未被渲染为 Amber 琥珀色，而是被错误着色为 MiniMax 紫色，破坏了全局色彩语义映射契约。
  6. 此外，第 75 行与第 79 行将 `deepseek` 与 `openai/gpt` 均固定返回索引 0（`var(--usage-color-brand)`），导致同屏下 DeepSeek 与 OpenAI 模型完全撞色。
- **根因分析**：
  数学计算逻辑严重混乱，盲目对 `fallbackIdx` 累加偏置量 `+ 4`，导致传入的显式索引被无故偏移破坏。
- **修复加固建议**：
  在 `getModelColor` 中针对 `'other'` 建立显式映射，且回退索引取模严禁施加多余魔术偏移：
  ```ts
  export function getModelColor(modelName: string, fallbackIdx = 0): ModelColorTheme {
    const lower = (modelName || '').toLowerCase();
    if (lower === 'other' || lower === '__others__') return GLOBAL_MODEL_PALETTE[4]!;
    if (lower.includes('deepseek')) return GLOBAL_MODEL_PALETTE[0]!;
    if (lower.includes('claude')) return GLOBAL_MODEL_PALETTE[1]!;
    if (lower.includes('minimax')) return GLOBAL_MODEL_PALETTE[2]!;
    if (lower.includes('kimi') || lower.includes('moonshot')) return GLOBAL_MODEL_PALETTE[3]!;
    if (lower.includes('openai') || lower.includes('gpt')) return GLOBAL_MODEL_PALETTE[5]!;
    return GLOBAL_MODEL_PALETTE[fallbackIdx % GLOBAL_MODEL_PALETTE.length] ?? GLOBAL_MODEL_PALETTE[0]!;
  }
  ```

---

### 缺陷 ISSUE-07：tokens.css 残留 20 处旧式 rgba(...) 语法与 Button.module.css 残留 1 处 rgba(...)，破坏现代色彩空间统一约束
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/styles/tokens.css:212, 217, 367, 411, 948, 1001, 1023, 1027, 1032, 1045, 1046, 1117, 1118, 1120, 1121, 1123, 1124, 1153, 1680, 1686`
  - `apps/crish-desktop/src/components/ui/Button/Button.module.css:159`
- **缺陷确凿证据**：
  ```css
  /* tokens.css:212, 217 */
  --sep-bg-input: rgba(29, 28, 26, 0.03);
  --sep-divider-color: rgba(29, 28, 26, 0.06);

  /* tokens.css:948 */
  --switch-thumb-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);

  /* tokens.css:1001, 1023 */
  --bg-panel: rgba(24, 23, 21, 0.96);
  --sep-bg-panel: rgba(24, 23, 21, 0.96);

  /* tokens.css:1045-1046, 1117-1124 */
  0 4px 18px rgba(0, 0, 0, 0.28),
  0 1px 3px rgba(0, 0, 0, 0.18);

  /* Button.module.css:159 (用量监控控制台核心原子依赖) */
  --btn-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  ```
  违反用户“全仓严格禁止 rgba 语法，排查 tokens.css 及上述所有组件样式中是否有任何残留的旧式 rgba(...)，全部转换为算法与现代色彩空间（oklch / color-mix / hsl 斜杠透明度）”的红线铁律。
- **根因分析**：
  历史 token 与底层原子组件在演进过程中未被全量清扫，遗漏了阴影、遮罩与面板背景中的旧式 `rgba(...)`。
- **修复加固建议**：
  全量将残留的 `rgba(r, g, b, a)` 替换为 `hsl(h s l / a)` 或 `color-mix(in srgb, ...)`：
  - `rgba(0, 0, 0, 0.4)` $\to$ `hsl(0 0% 0% / 0.4)`
  - `rgba(29, 28, 26, 0.03)` $\to$ `hsl(40 5% 11% / 0.03)`
  - `Button.module.css:159` 中的 `--btn-shadow` $\to$ `0 1px 3px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 35%, transparent)`.

---

### 缺陷 ISSUE-08：暗色模式用量监控前景色变量缺失，且热力图硬编码 OKLCH 导致暗色模式调优失效
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/styles/tokens.css:1423-1442, 1616-1668`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.module.css:160-174`
- **缺陷确凿证据**：
  ```css
  /* tokens.css:1423-1442 (html[data-theme='dark']) */
  --usage-color-brand-bg: hsl(160 84% 45% / 0.18);
  --usage-color-claude-bg: hsl(25 95% 56% / 0.18);
  /* 仅定义了 -bg 变量与 --usage-heat-*，完全未覆盖 --usage-color-brand 等前景色变量 */
  ```
  ```css
  /* ActivityMatrixHeatmap.module.css:160-174 */
  @supports (color: oklch(0.7 0.1 140)) {
    .actLvl1 { background: oklch(0.75 0.155 148 / 0.22); }
    .actLvl2 { background: oklch(0.75 0.155 148 / 0.45); }
    .actLvl3 { background: oklch(0.75 0.155 148 / 0.72); }
    .actLvl4 { background: oklch(0.75 0.155 148); }
  }
  ```
  1. `tokens.css` 的暗色模式块 `html[data-theme='dark']` 仅重写了背景弱透明度变量 `--usage-color-*-bg`，核心线条、文字与图例前景色变量（`--usage-color-brand` 等）完全缺失。在深色模式下，线条继承浅色模式下亮度偏暗的 HSL 值（如亮度仅 39% 的 `hsl(160 84% 39%)`），在近黑底板上严重缺失对比度。
  2. `ActivityMatrixHeatmap.module.css` 在第 140-158 行引入了 `--usage-heat-0` ~ `--usage-heat-4`，但在第 160-174 行直接用硬编码的 `oklch(...)` 样式强行覆盖。无论处于亮色还是暗色模式，热力块均使用固定的亮色系 OKLCH 值，`tokens.css` 中暗色模式针对热力图的调优变量（`tokens.css:1435-1439`）被完全架空失效。
- **根因分析**：
  组件局部样式覆盖与全局 Token 单一真源脱节；暗色模式变量定义不完整。
- **修复加固建议**：
  1. 在 `tokens.css` 的 `html[data-theme='dark']` 块中补全暗色专用明度提升的前景线条色（如 `--usage-color-brand: hsl(160 84% 48%);`）；
  2. 移除 `ActivityMatrixHeatmap.module.css` 中的局部硬编码 `@supports` 规则，将 OKLCH 增强统一定义在 `tokens.css` 内的变量层，让组件无条件通过 `var(--usage-heat-*)` 消费。

---

### 缺陷 ISSUE-09：ModelDistributionSection hover 交互仍残留非匹配项 0.75 降透明度死灰感，且 CSS .donutSlice:hover 规则死代码遮蔽
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:132-136`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.module.css:68-70`
- **缺陷确凿证据**：
  ```tsx
  // ModelDistributionSection.tsx:132-136
  style={{
    strokeWidth: 24,
    opacity: isMatch ? 1 : 0.75,
    transition: 'opacity 140ms ease',
  }}
  ```
  ```css
  /* ModelDistributionSection.module.css:68-70 */
  .donutSlice:hover {
    opacity: 0.95;
  }
  ```
  1. 当鼠标悬停在圆环某个模型切片或右侧胶囊时，非匹配的切片被内联样式强制降透明度至 `0.75`，带来明显的降暗“死灰”感。
  2. CSS 中声明了 `.donutSlice:hover { opacity: 0.95; }`，试图在悬停时降低切片透明度；但该规则被内联 `style={{ opacity: 1 }}` 永久覆盖，成为完全无效的死 CSS。
- **根因分析**：
  未能通过微光描边（Stroke Highlight）或阴影实现高亮，仍沿用了粗暴调节全局透明度的旧思路。
- **修复加固建议**：
  废除 `opacity: 0.75` 降暗机制，非匹配项保持 `opacity: 1` 稳定不变，改用在匹配切片上增加轻微饱和度提升或外部发光/微缩放，杜绝死灰感；删除 `.donutSlice:hover` 死规则。

---

### 缺陷 ISSUE-10：PriceConfigModal 默认货币为 USD，与 UsageSummaryHero 及底层数据 CNY 默认币种存在语义冲突
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/PriceConfigModal.tsx:31`
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.tsx:14`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:188`
  - `crates/conex-db/src/usage_analytics.rs:449, 572`
- **缺陷确凿证据**：
  ```tsx
  // PriceConfigModal.tsx:31
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('USD');

  // UsageSummaryHero.tsx:14
  export const UsageSummaryHero: React.FC<UsageSummaryHeroProps> = ({ ..., currency = 'CNY' }) => {

  // ActivityMatrixHeatmap.tsx:188
  <span className={styles.actStatUnit}>CNY</span>
  ```
  ```rust
  // crates/conex-db/src/usage_analytics.rs:449
  total_cost += row.cost_cny;
  ```
  1. Rust 数据库底层的 `total_cost` 与各聚合分析字段恒定以 `cost_cny`（人民币）为标准进行统计累加。
  2. 前端展示层 `UsageSummaryHero` 与 `ActivityMatrixHeatmap` 默认展示单位为 `CNY`（`¥`）。
  3. 但单价配置弹窗 `PriceConfigModal` 在打开时的初始币种状态硬编码为 `'USD'`。由于前后端不存在实时汇率转换算子，用户配置的美金单价直接作为原值被计入 `cost_cny`，导致金额数据严重失真。
- **根因分析**：
  前端配置组件与全局真实币种真源解耦，未与当前系统主货币保持单一真源对齐。
- **修复加固建议**：
  将 `PriceConfigModal` 的初始货币状态统一对齐为 `'CNY'`，或由父级 `SettingsUsageTab` 统一注入当前的货币体系上下文。

---

### 缺陷 ISSUE-11：EditablePriceRow 删除按钮未标记为纯图标按钮导致尺寸偏宽（34px 而非 28x28px）
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/EditablePriceRow.tsx:146-154`
  - `apps/crish-desktop/src/components/ui/Button/Button.tsx:89-99`
  - `apps/crish-desktop/src/components/ui/Button/Button.module.css:98-105, 237-241`
- **缺陷确凿证据**：
  ```tsx
  // EditablePriceRow.tsx:146-154
  <Tooltip content="删除该模型单价">
    <Button
      type="button"
      variant="ghost"
      size="sm"
      icon={<Lucide.Trash2 size={13} />}
      onClick={onDelete}
      aria-label={`删除 ${row.model}`}
    />
  </Tooltip>
  ```
  ```css
  /* Button.module.css:98-105, 237-241 */
  .buttonSm, .button[data-size='sm'] {
    --btn-h: 28px;
    --btn-px: 10px; /* 默认带有 10px 水平 padding */
  }
  .iconButton {
    width: var(--btn-h);
    padding: 0;
    flex-shrink: 0;
  }
  ```
  1. `Button` 组件在没有 `children` 只有 `icon` 时，未自动附加上 `.iconButton` 类。
  2. `EditablePriceRow` 渲染删除按钮时未传入 `className={styles.iconButton}` 或 `iconOnly` 属性。
  3. 该按钮继承了普通 `size="sm"` 按钮的 `padding: 0 10px`，其实际尺寸为宽 34px、高 28px 的拉长矩形，而非 28x28px 正方形微型图标按钮，视觉比例失衡，并进一步加剧了 ISSUE-02 中的网格列挤压。
- **根因分析**：
  原子 `Button` 组件未在内部根据 `!children && icon` 自动应用 `.iconButton` 变体，消费方亦未主动补全正方形规格。
- **修复加固建议**：
  在 `Button.tsx` 内部增加自动判定：若 `!children && Boolean(icon)`，自动合入 `styles.iconButton`；或在 `EditablePriceRow` 的删除按钮上挂载显式正方形类名。

---

### 缺陷 ISSUE-12：usageChartModel.ts 虽清退均线 UI，但在图表模型契约中仍残留 avgVal / avgLabel 死代码与无用计算
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/usageChartModel.ts:41-42, 58-59, 106-107, 145-146, 203-204`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:42`
- **缺陷确凿证据**：
  ```ts
  // usageChartModel.ts:41-42
  export interface ChartModelOutput {
    seriesList: ChartSeriesConfig[];
    yTicks: [string, string, string, string];
    yMax: number;
    avgVal: number;    // 完全未被消费的死契约
    avgLabel: string;  // 完全未被消费的死契约
    formatVal: (v: number) => string;
  }
  ```
  ```tsx
  // UsageTrendChart.tsx:42
  const { seriesList, yTicks, yMax, formatVal } = chartModel;
  // avgVal 与 avgLabel 被彻底抛弃
  ```
  1. 用户明确勒令清退 `_btnAvgToggle` 均线参考按钮与功能，UI 层折线图已彻底清退均线。
  2. 但在底层的模型计算逻辑 `usageChartModel.ts` 中，每个维度（`overview`、`models`、`cost`）仍然在对全部点集执行 `reduce` 求和与 `avg` 均值数学计算，并向契约输出 `avgVal` 与 `avgLabel`。
- **根因分析**：
  重构过程中仅清理了顶层表现层代码，未对底层模型模块进行完整收敛重构，留存幽灵计算。
- **修复加固建议**：
  从 `ChartModelOutput` 接口及 `buildChartSeriesConfig` 各分支中彻底删除 `avgVal`、`avgLabel` 字段及对应的数组 reduce 求和计算。

---

### 缺陷 ISSUE-13：全仓残留两处已废弃且引用失效的旧用量组件死代码文件（UsageChart.tsx、UsageModelTable.tsx）
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/UsageChart.tsx`
  - `apps/crish-desktop/src/components/settings/UsageModelTable.tsx`
- **缺陷确凿证据**：
  1. `UsageChart.tsx` 与 `UsageModelTable.tsx` 仍驻留在 `src/components/settings/` 目录下，全工程 0 处引用，属于完全脱水的遗留死文件。
  2. 两个文件均直接 `import styles from './SettingsUsageTab.module.css'`，并引用了 `.chartSection`、`.chartTitle`、`.chartBars`、`.modelsSection` 等类名。
  3. 但 `SettingsUsageTab.module.css` 已经全量重构，已彻底删除了上述全部类名。若此二文件被实例化，将发生全量样式失效与排版坍塌。
- **根因分析**：
  重构完成切流后，未履行死代码清理纪律，遗留孤立未跟踪组件。
- **修复加固建议**：
  物理删除 `UsageChart.tsx` 与 `UsageModelTable.tsx`，保持工程目录洁净收敛。
