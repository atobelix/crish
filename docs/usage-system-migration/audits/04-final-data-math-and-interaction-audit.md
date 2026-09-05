# 用量监控控制台数据真实性、数学模型与交互行为终审报告

## 审查范围
- `apps/crish-desktop/src/components/settings/usage/usageSpline.ts`
- `apps/crish-desktop/src/components/settings/usage/usageSpline.test.ts`
- `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx`
- `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx`
- `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.tsx`
- `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx`
- `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx`
- `crates/conex-db/src/usage_analytics.rs`
- `apps/crish-desktop/src/components/settings/usage/usageChartModel.ts`

## 缺陷统计
- P0（破坏数据真源性与核心功能）：1 项
- P1（破坏渲染几何模型与空态表现）：2 项
- P2（数学模型精度漂移与边界数据截断）：3 项
- P3（交互一致性缺陷与异常容错隐患）：4 项

---

## 缺陷清单

### 缺陷 ISSUE-01：前端降级假体与模板运算符硬编码虚构用户行为特征破坏数据真源性
- **严重度**：P0
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/api/usageApi.ts:16-23`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:200, 206-208, 212-214`
- **缺陷确凿证据**：
  ```typescript
  // apps/crish-desktop/src/api/usageApi.ts:14-23
  export const FALLBACK_USAGE_DASHBOARD: UsageDashboardDto = {
    range: '7d',
    hero: {
      dailyAverageTokens: 0,
      dailyAverageCost: 0,
      totalMessages: 0,
      topModel: '无记录',
      peakActiveHourRange: '09:00 - 18:00',
      topProject: '默认工作区',
    },
    ...
  };
  ```
  ```tsx
  // apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:198-214
  <div className={styles.actStatItem}>
    <span className={styles.actStatLabel}>最常用的模型</span>
    <span className={`${styles.actStatVal} ${styles.actStatValCode}`}>
      {heroStats.topModel || '无记录'}
    </span>
  </div>
  <div className={styles.actStatItem}>
    <span className={styles.actStatLabel}>最活跃的时间</span>
    <span className={styles.actStatVal}>
      {heroStats.peakActiveHourRange || '09:00 - 18:00'}
    </span>
  </div>
  <div className={styles.actStatItem}>
    <span className={styles.actStatLabel}>最常工作的项目</span>
    <span className={`${styles.actStatVal} ${styles.actStatValCode}`}>
      {heroStats.topProject || '默认工作区'}
    </span>
  </div>
  ```
- **证明与反例**：
  1. 后端 `crates/conex-db/src/usage_analytics.rs:530-569` 已修复空库返回，当 `grand_total_tokens == 0` 时三者返回均为 `"——"`（`"—"`）。
  2. 但在 `apps/crish-desktop/src/api/usageApi.ts` 中，`FALLBACK_USAGE_DASHBOARD` 依旧硬编码伪造数据：`peakActiveHourRange: '09:00 - 18:00'`、`topProject: '默认工作区'`、`topModel: '无记录'`。在 IPC 断开或初次拉取异常时，前端直接虚构出用户的使用画像。
  3. `ActivityMatrixHeatmap.tsx` 模板表达式使用逻辑或运算符 `||`。若后端或外部上报字段为空字符串 `""`，`"" || '09:00 - 18:00'` 将求值为 `'09:00 - 18:00'`，`"" || '默认工作区'` 求值为 `'默认工作区'`。
  4. 此外，空值文案在前后端呈现二元分裂：后端使用 `"—"`，而前端降级体与组件内分别出现 `'无记录'`、`'09:00 - 18:00'` 与 `'默认工作区'`，未统一为空态占位符 `"—"`。
- **修复加固建议**：
  1. 将 `FALLBACK_USAGE_DASHBOARD` 中的 `topModel`、`peakActiveHourRange`、`topProject` 全部改为 `"—"`。
  2. 将 `ActivityMatrixHeatmap.tsx` 中的 fallback 从 `'09:00 - 18:00'` 与 `'默认工作区'` 统一替换为 `"—"`。

---

### 缺陷 ISSUE-02：趋势折线图在空库与零用量时绘制伪造 Y 轴标尺且空态拦截失效
- **严重度**：P1
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:135-138`
  - `apps/crish-desktop/src/components/settings/usage/usageChartModel.ts:65, 116, 131, 152`
- **缺陷确凿证据**：
  ```tsx
  // apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:135-137
  {points.length <= 1 ? (
    <div className={styles.emptyChart}>暂无充足时序采样数据</div>
  ) : (
    ...
  ```
  ```typescript
  // apps/crish-desktop/src/components/settings/usage/usageChartModel.ts:65, 116, 131, 152
  // 费用走势维度
  const computedYMax = maxCost > 0 ? maxCost * 1.15 : 10;
  ...
  // 模型对比维度
  let localMax = 1;
  ...
  const computedYMax = localMax * 1.15;
  ...
  // 吞吐总览维度
  const computedYMax = maxTokens > 0 ? maxTokens * 1.15 : 1000;
  ```
- **证明与反例**：
  1. 后端 `query_usage_dashboard` 实施时间序列 Zero-Fill 补零保障，无论数据库是否有记录，`points` 数组恒定产出 24（24h）、7（7d）或 30（30d）个补零点。
  2. 因此，在清空历史或无记录空库状态下，`points.length <= 1` 恒为 `false`，组件永远无法进入 `emptyChart` 分支。
  3. 当 `maxTokens == 0`、`maxCost == 0` 时：
     - “吞吐总览”硬编码 `computedYMax = 1000`，Y 轴渲染刻度 `["1,000", "660", "330", "0"]`，在 0 刻度上绘制一条具有 1000 tokens 虚假标尺的死线；
     - “费用走势”硬编码 `computedYMax = 10`，Y 轴渲染刻度 `["¥ 10.00", "¥ 6.60", "¥ 3.30", "¥ 0.00"]`，虚构出 10 元量程；
     - “模型对比”因 `models` 为空向量，`seriesList` 为空数组，`localMax` 保持默认值 `1`，`computedYMax = 1.15`，Y 轴渲染 `["1.15", "0.76", "0.38", "0"]`，图表区呈现无任何曲线的纯虚数标尺。
- **修复加固建议**：
  1. 在 `UsageTrendChart.tsx` 中增加全零判定：当 `points.length === 0 || (maxTokens === 0 && maxCost === 0 && models.length === 0)` 时，直接渲染 `emptyChart` 或归零状态。
  2. 若需保留坐标轴，在 `maxTokens === 0` 时应令 `computedYMax = 0`，Y 轴刻度统一输出 `["0", "0", "0", "0"]`，杜绝臆造 `1000`、`10` 与 `1.15`。

---

### 缺陷 ISSUE-03：悬浮卡片视口边缘钳位与 transform 锚点几何模型自相矛盾致 80px 瞬移与右边缘 86px 留白
- **严重度**：P1
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:101-107`
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts:262-272`
- **缺陷确凿证据**：
  ```typescript
  // apps/crish-desktop/src/components/settings/usage/usageSpline.ts:262-272
  export function clampViewportX(
    idealX: number,
    cardWidth: number,
    containerWidth: number,
    margin = 6
  ): number {
    const half = cardWidth / 2;
    const minX = half + margin;
    const maxX = Math.max(minX, containerWidth - half - margin);
    return Math.min(Math.max(idealX, minX), maxX);
  }
  ```
  ```tsx
  // apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:101-107
  const cardW = tooltipRef.current?.offsetWidth || 160;
  const clampedX = clampViewportX(idealX, cardW, containerW, 6);
  const isNearRight = idealX > containerW - 170;

  return {
    left: `${clampedX}px`,
    transform: isNearRight ? 'translateX(-100%)' : 'translateX(-50%)',
    display: 'flex',
  };
  ```
- **数学证明与反例**：
  1. 函数 `clampViewportX` 的定义域与值域映射建立在卡片水平居中锚点（即 `transform: translateX(-50%)`）的前提下：
     $$\text{card\_left} = X - \frac{W}{2} \ge \text{margin} \implies X \ge \frac{W}{2} + \text{margin}$$
     $$\text{card\_right} = X + \frac{W}{2} \le \text{containerW} - \text{margin} \implies X \le \text{containerW} - \frac{W}{2} - \text{margin}$$
     当 `clampedX` 处于 $[minX, maxX]$ 时，在 `translateX(-50%)` 作用下卡片天然严格位于视口内部 $[margin, containerW - margin]$，绝不会发生右边缘截断。
  2. 但 `UsageTrendChart.tsx` 引入了布尔分支 `isNearRight = idealX > containerW - 170`，并在为真时将变换改为 `translateX(-100%)`。
  3. 几何反例计算（设 `containerW = 760`, `cardW = 160`, `margin = 6`, 阈值点为 $760 - 170 = 590\text{px}$）：
     - 鼠标位于 $idealX = 589\text{px}$ 时：$isNearRight = false$。$clampedX = 589\text{px}$。`transform: translateX(-50%)`。卡片几何物理覆盖区间为：
       $$[589 - 80, 589 + 80] = [509\text{px}, 669\text{px}]$$
     - 鼠标微移 2 像素至 $idealX = 591\text{px}$ 时：$isNearRight = true$。$clampedX = 591\text{px}$。`transform: translateX(-100%)`。卡片几何物理覆盖区间变为：
       $$[591 - 160, 591] = [431\text{px}, 591\text{px}]$$
     - 连续移动 2 像素导致卡片瞬间向左剧烈跳跃 $\Delta X = 509 - 431 = 78\text{px}$。
     - 当鼠标移至右端采样点 $idealX = 740\text{px}$ 时：$clampedX$ 被截断为 $maxX = 760 - 80 - 6 = 674\text{px}$。在 `translateX(-100%)` 作用下，卡片右边缘落在 $674\text{px}$ 处，距离容器右侧产生长达 $760 - 674 = 86\text{px}$ 的无效空白死区，右侧吸附指示线与卡片主体脱节。
- **修复加固建议**：
  移除 `isNearRight` 与 `translateX(-100%)`。始终使用 `transform: 'translateX(-50%)'`，由 `clampViewportX` 单一算法负责全视口边缘无损平滑钳位。

---

### 缺陷 ISSUE-04：模型胶囊列表在零用量时异常渲染 2% 活性进度条
- **严重度**：P2
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:185-192`
- **缺陷确凿证据**：
  ```tsx
  // apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:185-192
  const rawRatio =
    m.percentage > 0
      ? m.percentage
      : totalTokens > 0
        ? (m.tokens / totalTokens) * 100
        : 0;
  const normRatio = normalizeModelRatio(rawRatio);
  const barWidth = Math.max(2, Math.min(100, normRatio * 100));
  ```
- **证明与反例**：
  1. 当 `m.tokens == 0` 或 `totalTokens == 0` 时，`rawRatio = 0`，经 `normalizeModelRatio(0)` 归一化后 `normRatio = 0.0`。
  2. 评估 `barWidth = Math.max(2, Math.min(100, 0.0 * 100))` 得到 `barWidth = 2`。
  3. 渲染结果为 `<div className={styles.capsuleBarBg} style={{ width: '2.0%', background: ... }} />`。
  4. 界面右侧百分比标签为 `0.0%`，但胶囊背景渲染了宽度为 2% 的进度填充条，使未使用模型伪造出活跃占用。
- **修复加固建议**：
  修改进度条宽度计算逻辑，仅在实际占比大于 0 时施加 2% 最小可见度下限：
  ```typescript
  const barWidth = normRatio > 0 ? Math.max(2, Math.min(100, normRatio * 100)) : 0;
  ```

---

### 缺陷 ISSUE-05：7d 滑动窗口活跃度热力图切片边界算法丢弃第 7 天历史记录
- **严重度**：P2
- **涉及文件与代码行号**：
  - `crates/conex-db/src/usage_analytics.rs:638, 731-736`
- **缺陷确凿证据**：
  ```rust
  // crates/conex-db/src/usage_analytics.rs:638, 731-736
  let start = now_ms - (7 * 86_400_000);
  ...
  let diff_days = today_days - record_days;
  if (0..7).contains(&diff_days) {
      let dow = day_of_week(record_days); // 0=Mon..6=Sun
      if dow < 7 && h < 24 {
          let idx = dow * 24 + h;
          if let Some(cell) = cells.get_mut(idx) {
              cell.tokens += tokens;
              cell.cost += cost;
              cell.calls += 1;
          }
      }
  }
  ```
- **证明与反例**：
  1. SQL 查询语句过滤 `timestamp >= start_ms AND timestamp <= now_ms`，其中 `start_ms = now_ms - 7 * 86_400_000`。
  2. 设执行查询时刻为周四 15:00，则 7 天前周四 15:00 至 23:59 期间的用量记录其时间戳落在 $[start\_ms, now\_ms]$ 内，被 SQL 正常读取。
  3. 但在内存分桶映射时：该部分记录的 `record_days` 相比 `today_days` 相差整整 7 天，即 `diff_days = 7`。
  4. 循环体过滤条件为 `(0..7).contains(&diff_days)`，半开区间 `0..7` 仅包含集合 $\{0, 1, 2, 3, 4, 5, 6\}$。
  5. 值为 7 的有效记录被判定为 `false` 并直接丢弃，导致 7d 视窗内首日（7 天前）的用量数据在热力图矩阵中被物理抹除。
- **修复加固建议**：
  对齐滑动窗口判定逻辑，对于跨度为 7 天的星期映射，需根据精确时钟偏移或闭区间 `0..=7` 进行按时归并，或将 SQL 查询区间与日历对齐。

---

### 缺陷 ISSUE-06：7d 趋势图 X 轴刻度抽稀算法过度抑制致丢失 57% 有效刻度
- **严重度**：P2
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts:121-123, 132-149`
- **缺陷确凿证据**：
  ```typescript
  // apps/crish-desktop/src/components/settings/usage/usageSpline.ts:121-123, 132-149
  if (n <= 8) {
    for (let i = 1; i < n - 1; i++) candidateIndices.push(i);
  }
  ...
  // 物理防碰撞过滤：确保任意相邻两点索引差值 >= 3 (物理间距 >= 90px)
  const validIndices: number[] = [];
  for (let i = 0; i < candidateIndices.length; i++) {
    const cur = candidateIndices[i]!;
    if (validIndices.length === 0) {
      validIndices.push(cur);
    } else {
      const last = validIndices[validIndices.length - 1]!;
      if (i === candidateIndices.length - 1) {
        if (cur - last < 3 && validIndices.length > 1) {
          validIndices.pop();
        }
        validIndices.push(cur);
      } else if (cur - last >= 3) {
        validIndices.push(cur);
      }
    }
  }
  ```
- **证明与反例**：
  1. 在 `7d` 模式下，点集长度为 $n = 7$（索引 $0 \sim 6$）。绘图横向净跨度为 $xEnd - xStart = 750 - 40 = 710\text{px}$。
  2. 若全部渲染 7 个点，相邻刻度物理中心距为 $\frac{710}{6} \approx 118.33\text{px}$。每个刻度标签为 MM-DD 格式（如 `"09-01"`），在 10.5px 字号下文本物理宽度仅约 $35\text{px}$，相邻标签间留有高达 $118.33 - 35 = 83.33\text{px}$ 的安全间隙，绝对不存在任何叠字碰撞风险。
  3. 但抽稀算法无视物理间距，强制施加索引差值 `cur - last >= 3`：
     - $i = 0$：保留；
     - $i = 1, 2$：差值 $< 3$，被剔除；
     - $i = 3$：保留；
     - $i = 4, 5$：差值 $< 3$，被剔除；
     - $i = 6$：保留。
  4. 最终仅输出 `[0, 3, 6]` 三个刻度，将一周 7 天中原本安全、清晰的 4 个刻度（57.1%）无端截断。
- **修复加固建议**：
  当 `range === '7d'` 且 $n \le 8$ 时，因相邻间距已达 118px，无需套用 $\Delta \text{index} \ge 3$ 抽稀规则，应全部放行。

---

### 缺陷 ISSUE-07：Y 轴三等分网格刻度采用 0.66/0.33 经验系数致使临界进位单位震荡
- **严重度**：P3
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/usageChartModel.ts:101-102, 140-141, 198-199`
- **缺陷确凿证据**：
  ```typescript
  // apps/crish-desktop/src/components/settings/usage/usageChartModel.ts:196-200
  yTicks: [
    formatTokens(computedYMax),
    formatTokens(computedYMax * 0.66),
    formatTokens(computedYMax * 0.33),
    '0',
  ],
  ```
- **数学反例**：
  1. SVG 绘图区辅助横线物理坐标严格四等分（三等分高度）：$y = 20, 60, 100, 140$，间距恒为 $40\text{px}$，理论分位比例为 $1.0$、$\frac{2}{3}$（$0.6666...$）、$\frac{1}{3}$（$0.3333...$）与 $0$。
  2. 取数值临界点 `computedYMax = 15,000`（1.5 万）：
     - 理论次高分位点值应为 $15000 \times \frac{2}{3} = 10,000$。经 `formatTokens(10000)` 格式化输出为 `"1.00 万"`；
     - 但代码采用近似系数 `0.66`：$15000 \times 0.66 = 9,900$。
     - 由于 $9900 < 10000$，`formatTokens` 未能进入万分位分支，退化为千分位，输出为 `"9,900"`。
  3. 导致同一纵轴自上而下的刻度序列为：`["1.50 万", "9,900", "4,950", "0"]`，在万与个位整数之间产生杂乱的单位跳跃。在 `30,000` 处同理，$30000 \times 0.33 = 9900$，输出 `"9,900"` 而非 `"1.00 万"`。
- **修复加固建议**：
  将刻度系数由近似浮点数 `0.66`、`0.33` 修正为精确算术比例：`computedYMax * (2.0 / 3.0)` 与 `computedYMax * (1.0 / 3.0)`。

---

### 缺陷 ISSUE-08：热力图独立周期切换与下方 6 项习惯统计宏观指标数据源割裂
- **严重度**：P3
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:35, 83-88, 175-215`
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx:147-150`
- **缺陷确凿证据**：
  ```tsx
  // apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:35, 175-181
  const [matrixRange, setMatrixRange] = useState<'24h' | '7d' | '30d'>('30d');
  ...
  <SegmentedControl
    size="xs"
    value={matrixRange}
    onChange={(val) => setMatrixRange(val as '24h' | '7d' | '30d')}
    options={RANGE_OPTIONS}
  />
  ...
  <div className={styles.activityStatsGrid}>
    <div className={styles.actStatItem}>
      <span className={styles.actStatLabel}>每天平均用量</span>
      <span className={styles.actStatVal}>
        {formatTokens(heroStats.dailyAverageTokens)}{' '}
        <span className={styles.actStatUnit}>tokens</span>
      </span>
    </div>
  ```
- **证明与反例**：
  1. `ActivityMatrixHeatmap` 拥有私有状态 `matrixRange` 与独立的切换控制器（24h/7d/30d），用于驱动矩阵格子的重绘。
  2. 但处于同一卡片底部的 6 项习惯指标（`dailyAverageTokens` 等）直接绑定 props 传入的 `heroStats`。
  3. 父级 `SettingsUsageTab` 仅在顶部全局 `globalRange` 变化时重新请求 `dashboardData.hero`。
  4. 现场表现：用户在“活动”卡片内将时间跨度从“30 天”切换为“24 小时”，上方的热力图矩阵切换为今日/昨日模式，但其正下方的“每天平均用量”、“每天平均花费”、“发送消息总数”依然显示 30 天的统计均值，卡片内部呈现状态分裂。
- **修复加固建议**：
  将 6 项习惯指标移出 `ActivityMatrixHeatmap`，作为独立全局看板组件挂载于顶层；或使热力图私有切换器仅作用于局部切片并明确标注时间基准。

---

### 缺陷 ISSUE-09：`handleMouseMove` 在模型维度空状态下产生常数坐标与无效重渲染
- **严重度**：P3
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:69-76`
- **缺陷确凿证据**：
  ```typescript
  // apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:68-75
  for (let i = 0; i < numPoints; i++) {
    const ptX = (computedSeries[0]?.points[i]?.x ?? xStart) / 760 * rect.width;
    const diff = Math.abs(ptX - mouseX);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  setHoverIdx(closest);
  ```
- **证明与反例**：
  1. 当用户切换至“模型对比”维度且 `models` 为空时，`computedSeries` 为空数组 `[]`。
  2. `computedSeries[0]` 为 `undefined`，`ptX` 回退为常数 `(xStart / 760) * rect.width`。
  3. 循环遍历所有采样点时，$ptX$ 恒定不变，导致首项 $i = 0$ 的 `diff` 永远等于后续各项，`closest` 锁定为 0。
  4. 鼠标在画布区域移动时，系统在无任何可视数据点的情况下频繁触发 `setHoverIdx(0)` 重渲染。
- **修复加固建议**：
  在 `handleMouseMove` 开头增加守卫：`if (!computedSeries.length) return;`。

---

### 缺陷 ISSUE-10：清空历史操作缺少乐观重置致接口异常时幽灵数据驻留
- **严重度**：P3
- **涉及文件与代码行号**：
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx:78-85`
- **缺陷确凿证据**：
  ```typescript
  // apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx:78-85
  const cleared = await clearUsageHistory();
  if (cleared) {
    showToast('用量历史已清空');
    setRefreshTick((t) => t + 1);
    void loadData(globalRange);
  } else {
    showToast('清空历史失败');
  }
  ```
- **证明与反例**：
  1. 底层 SQLite 的 `usage_records` 表在 `clearUsageHistory()` 成功后已被清空。
  2. 但前端并未在此时将 `dashboardData` 状态置空或重置为初始假体。
  3. 若随后的 `loadData(globalRange)` 因网络抖动或 IPC 异常进入 `catch` 块，`dashboardData` 将继续驻留旧的历史数据对象。
  4. 用户界面将呈现“提示已清空，但图表与指标依然展示历史用量”的幽灵驻留现象。
- **修复加固建议**：
  在 `cleared` 确认为 `true` 后立即执行 `setDashboardData(null)`，再启动异步重拉。

---

## 终审结论表

| 排查项目 | 状态 | 涉及缺陷编号 | 核心结论与加固要求 |
| :--- | :---: | :---: | :--- |
| 1. 数据真源性审查 | 未完全达标 | ISSUE-01, ISSUE-02 | 前端降级体存在 `'09:00 - 18:00'` 与 `'默认工作区'` 虚假占位；空库时趋势图虚构 1000/10 标尺未进空态。需彻底替换为 `"—"` 与空态拦截。 |
| 2. 百分比与 SVG 饼图数学模型审查 | 基本稳固 | ISSUE-04 | `normalizeModelRatio` 严格除以 100 已通过验证；SVG 剩余周长钳位有效；但胶囊列表对 0 用量模型存在 2% 幽灵进度条。 |
| 3. X 轴刻度抽稀算法审查 | 存在缺陷 | ISSUE-06 | 24h 滑动窗口防叠字已杜绝碰撞；但 7d 模式过度抽稀丢弃 57% 刻度。 |
| 4. 热力图状态同步审查 | 存在缺陷 | ISSUE-05, ISSUE-08, ISSUE-10 | 清空刷新已接入 `refreshKey` 同步；但 7d 滑窗丢弃第 7 日数据，卡片内宏观指标与局部周期切换器数据源割裂。 |
| 5. 极端边界与容错性审查 | 存在缺陷 | ISSUE-03, ISSUE-07, ISSUE-09 | `formatTokens` 临界进位稳固；但悬浮卡片存在双重补偿几何瞬移，Y 轴 0.66 系数导致跨量纲震荡，空模型维度引发无效重绘。 |
