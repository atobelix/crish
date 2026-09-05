# 用量监控控制台数据真实性、数学模型与交互行为终审验收报告（Post-Fix）

## 审查目标文件
- `apps/crish-desktop/src/components/settings/usage/usageSpline.ts`
- `apps/crish-desktop/src/components/settings/usage/usageSpline.test.ts`
- `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx`
- `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx`
- `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.tsx`
- `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx`
- `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx`
- `crates/conex-db/src/usage_analytics.rs`
- `apps/crish-desktop/src/components/settings/usage/usageChartModel.ts`
- `apps/crish-desktop/src/api/usageApi.ts`

---

## 核心排查清单复核结论表

| 序号 | 排查项目 | 验收状态 | 核心代码断言与逻辑证据 | 残留风险 |
| :--- | :--- | :---: | :--- | :---: |
| 1 | 数据真源性审查 | 达标 | `usage_analytics.rs:530-569` 空库严格输出 `"——"` 与 `0`；`usageApi.ts:14-33` 假体清除虚构画像；`UsageTrendChart.tsx:134` 与 `ModelDistributionSection.tsx:224` 正确拦截渲染优雅空态。 | 无 |
| 2 | 全零状态与坐标轴标尺审查 | 达标 | `UsageTrendChart.tsx:134` 增加全零守卫 `(maxTokens === 0 && maxCost === 0 && models.length === 0)` 拦截空态；`usageChartModel.ts:61, 113, 148` 全零时 `computedYMax = 0`，Y 轴刻度归零，彻底清退 1000、10 与 1.15 标尺。 | 无 |
| 3 | Tooltip 视口边缘钳位与 transform 锚点几何模型审查 | 达标 | `UsageTrendChart.tsx:105-107` 彻底移除 `isNearRight` 与 `translateX(-100%)`；全局锁定 `transform: translateX(-50%)`；`clampViewportX` 将中心点平滑钳位在 $[cardW/2 + 6, containerW - cardW/2 - 6]$ 区间，无瞬移跳跃。 | 无 |
| 4 | 百分比与胶囊进度条审查 | 达标 | `usageSpline.ts:41-46` 严格除以 100，0.5% 保留为 0.5%；`ModelDistributionSection.tsx:230` 判定 `normRatio > 0 ? Math.max(2, ...) : 0`，零用量模型 `barWidth` 严格归零，无 2% 幽灵进度条。 | 无 |
| 5 | X 轴刻度抽稀算法审查 | 达标 | `usageSpline.ts:109-126` 在 `range === '7d' && n <= 8` 时全量保留 7 个日历刻度；`range === '24h'` 滑动窗口施加 $\Delta \text{index} \ge 3$（物理间距 $\ge 90\text{px}$）防叠字碰撞保护。 | 无 |
| 6 | Y 轴刻度数学模型审查 | 达标 | `usageChartModel.ts:95-96, 133-134, 192-193` 采用精确算术比例 `(2.0 / 3.0)` 与 `(1.0 / 3.0)`，消除 0.66 与 0.33 引起的 15,000 / 30,000 临界进位单位震荡；`avgVal` 与 `avgLabel` 字段全部清退。 | 无 |
| 7 | 配色算法与色彩碰撞审查 | 达标 | `usageSpline.ts:75` 为 `'other'` 与 `'__others__'` 显式映射 `GLOBAL_MODEL_PALETTE[4]`；消除 `fallbackIdx + 4` 溢出；OpenAI/GPT 映射索引 5（费用色），与 DeepSeek 索引 0（翡翠绿）彻底色彩解耦。 | 无 |
| 8 | 货币体系与历史清空审查 | 达标 | `PriceConfigModal.tsx:30` 默认币种严格对齐为 `CNY`；`SettingsUsageTab.tsx:81` 清空成功后立即执行 `setDashboardData(null)`，切入骨架屏，杜绝幽灵数据驻留。 | 无 |
| 9 | 热力图 7d 边界与时钟分析 | 达标 | `usage_analytics.rs:732` 将条件修正为闭区间 `(0..=7).contains(&diff_days)`，跨度 7 天的星期映射完整保留第 7 天历史记录，无物理丢弃。 | 无 |

---

## 残留缺陷清单

### 缺陷 ISSUE-POST-01：热力图底部平均花费同时渲染货币符号与货币代码致字符冗余
- **严重度**：P3
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:203-208`
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts:32-35`
- **缺陷确凿证据**：
  ```typescript
  // apps/crish-desktop/src/components/settings/usage/usageSpline.ts:32-35
  export function formatCost(v: number, prefix = '¥ '): string {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return `${prefix}0.00`;
    return `${prefix}${v.toFixed(2)}`;
  }
  ```
  ```tsx
  // apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:203-208
  <div className={styles.actStatItem}>
    <span className={styles.actStatLabel}>每天平均花费</span>
    <span className={styles.actStatVal}>
      {formatCost(heroStats.dailyAverageCost)}{' '}
      <span className={styles.actStatUnit}>CNY</span>
    </span>
  </div>
  ```
- **证明与反例**：
  1. `formatCost` 在缺省第二参数时默认携带前缀 `prefix = '¥ '`。
  2. 当 `heroStats.dailyAverageCost = 0` 时，`formatCost(0)` 返回 `"¥ 0.00"`。
  3. `ActivityMatrixHeatmap.tsx:206` 在其后紧跟 `<span className={styles.actStatUnit}>CNY</span>`。
  4. 最终 DOM 渲染文本为：`"¥ 0.00 CNY"`（或 `"¥ 2.35 CNY"`），在前缀已显示人民币符号 `"¥ "` 的情况下重复追加后缀货币代码 `"CNY"`。
  5. 对比 `UsageSummaryHero.tsx:37`，该组件显式传入空前缀 `formatCost(totalCost, '')` 避免双重符号污染，而此处未传空前缀，存在格式不一致。
- **修复加固建议**：
  将调用修改为剥离前缀格式：
  ```tsx
  <span className={styles.actStatVal}>
    {formatCost(heroStats.dailyAverageCost, '')}{' '}
    <span className={styles.actStatUnit}>CNY</span>
  </span>
  ```

---

### 缺陷 ISSUE-POST-02：热力图组件内部独立时间跨度控制器与底部 6 项宏观指标数据源状态分裂
- **严重度**：P3
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:35, 83-88, 194-234`
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx:148-151`
- **缺陷确凿证据**：
  ```tsx
  // apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:35, 83-88
  const [matrixRange, setMatrixRange] = useState<'24h' | '7d' | '30d'>('30d');
  ...
  <SegmentedControl
    size="xs"
    value={matrixRange}
    onChange={(val) => setMatrixRange(val as '24h' | '7d' | '30d')}
    options={RANGE_OPTIONS}
  />
  ```
  ```tsx
  // apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:194-201
  <div className={styles.activityStatsGrid}>
    <div className={styles.actStatItem}>
      <span className={styles.actStatLabel}>每天平均用量</span>
      <span className={styles.actStatVal}>
        {formatTokens(heroStats.dailyAverageTokens)}{' '}
        <span className={styles.actStatUnit}>tokens</span>
      </span>
    </div>
  ...
  ```
- **证明与反例**：
  1. `ActivityMatrixHeatmap` 内部维护私有状态 `matrixRange`，切换时触发 `getActivityMatrix(matrixRange)` 重新拉取热力图单元格数据 `matrixData`。
  2. 但卡片底部的 6 项习惯与偏好统计指标（`heroStats`）来自父组件 `SettingsUsageTab` 传入的 `dashboardData.hero`。
  3. 父组件的 `dashboardData` 仅受顶部主控栏的 `globalRange` 驱动。
  4. 交互反例：当顶部 `globalRange` 为 `'24h'` 时，用户点击热力图右上角的 SegmentedControl 切换为 `'30 天'`：
     - 上方的热力图矩阵重绘为 4 行 x 30 列的 30 天单元格网格；
     - 但紧随其下方的“每天平均用量”、“每天平均花费”、“发送消息总数”依然展示来自 `globalRange`（24 小时）的数值；
     - 同一交互区块内上层图表与下层指标的时间基准割裂。
- **修复加固建议**：
  方案 A：在热力图内部切换 `matrixRange` 时，同时调用包含完整宏观指标的时序接口，或将 `heroStats` 与当前矩阵周期解除绑定；
  方案 B：在 6 项习惯偏好网格标题旁标注基准时间范围（如展示当前绑定的全局时段提示）。

---

## 历史缺陷修复闭环对照表

| 历史缺陷编号 | 缺陷描述 | 修复所在文件与行号 | 验证结果 |
| :--- | :--- | :--- | :---: |
| ISSUE-01 | 前端降级假体硬编码 `09:00 - 18:00` 与 `默认工作区` | `usageApi.ts:16-23`, `ActivityMatrixHeatmap.tsx:220, 226, 232` | 已根除 |
| ISSUE-02 | 趋势图在全零时未拦截空态且绘制 1000/10 虚构标尺 | `UsageTrendChart.tsx:134`, `usageChartModel.ts:61, 113, 148` | 已根除 |
| ISSUE-03 | 悬浮卡片存在 `isNearRight` 双重补偿致 78px 瞬移跳跃 | `UsageTrendChart.tsx:105-107`, `usageSpline.ts:283-293` | 已根除 |
| ISSUE-04 | 模型胶囊进度条在 0 用量时异常渲染 2% 幽灵进度 | `ModelDistributionSection.tsx:230` | 已根除 |
| ISSUE-05 | 7d 热力图切片半开区间 `0..7` 丢弃第 7 天历史记录 | `crates/conex-db/src/usage_analytics.rs:732` | 已根除 |
| ISSUE-06 | 7d 趋势图 X 轴刻度抽稀过度抑制致丢弃 57% 刻度 | `usageSpline.ts:109-126` | 已根除 |
| ISSUE-07 | Y 轴刻度使用 0.66/0.33 经验系数致 15,000 临界进位震荡 | `usageChartModel.ts:95-96, 133-134, 192-193` | 已根除 |
| ISSUE-08 | 热力图切换器与底部 6 项指标数据源割裂 | `ActivityMatrixHeatmap.tsx:35, 194` | 仍残留 (ISSUE-POST-02) |
| ISSUE-09 | `handleMouseMove` 在空模型维度下锁定 index=0 频繁重绘 | `UsageTrendChart.tsx:61` | 已根除 |
| ISSUE-10 | 清空历史操作缺少乐观置空致弱网时幽灵数据驻留 | `SettingsUsageTab.tsx:81` | 已根除 |
