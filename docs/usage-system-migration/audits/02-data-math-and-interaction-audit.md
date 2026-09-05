# 用量监控控制台数据真实性、数学模型与交互行为深度审计报告

## 审计概览与缺陷统计

- 审查范围：
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts`
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.test.ts`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx`
  - `apps/crish-desktop/src/components/settings/usage/UsageSummaryHero.tsx`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx`
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx`
  - `crates/conex-db/src/usage_analytics.rs`
  - `apps/crish-desktop/src/components/settings/usage/usageChartModel.ts`
- 缺陷统计：
  - P0（破坏核心功能与数据真实性）：2 项
  - P1（破坏渲染精度与状态一致性）：2 项
  - P2（数学精度漂移与几何边界缺陷）：4 项
  - P3（排版变形与视觉契约漂移）：4 项

---

## 缺陷清单

### 缺陷 ISSUE-01：百分比归一化启发式阈值截断漏洞致小比例模型数据虚增 100 倍且图表溢出
- **严重度**：P0
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts:39-47`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:47-51`
- **缺陷确凿证据**：
  ```typescript
  // usageSpline.ts:39-47
  export function normalizeModelRatio(rawVal: number): number {
    if (typeof rawVal !== 'number' || !Number.isFinite(rawVal) || rawVal <= 0) {
      return 0.0;
    }
    if (rawVal > 1.0) {
      return Math.min(1.0, rawVal / 100.0);
    }
    return rawVal;
  }
  ```
  ```typescript
  // ModelDistributionSection.tsx:47-51
  const rawRatio = m.percentage > 0 ? m.percentage : (totalTokens > 0 ? m.tokens / totalTokens : 0);
  const normRatio = normalizeModelRatio(rawRatio);
  const dash = normRatio * CIRCUMFERENCE;
  ```
- **数学证明与反例**：
  1. 后端 `usage_analytics.rs:494-498` 对 `percentage` 的定义恒为百分制数值（$0.0 \sim 100.0$）：
     $$\text{percentage} = \frac{\text{tokens}}{\text{grand\_total\_tokens}} \times 100.0$$
  2. 当存在用量较小的真实模型时，其占比极易落在 $\le 1.0\%$ 区间内（例如用户共产生 10,000 Tokens，其中 `gpt-4o` 产生 50 Tokens，其 `m.percentage` 为 $0.5$）。
  3. 函数在接收 $rawVal = 0.5$ 时，由于 $0.5 > 1.0$ 为 `false`，直接进入 `return rawVal`，返回归一化比例 $0.5$（即代表 $50.0\%$）！
  4. 最终展示后果：
     - `formatPercentage(0.5)` 输出 `50.0%`，数据相比实际真实占比 $0.5\%$ **虚假放大了 100 倍**；
     - SVG 饼图切片 `dash = 0.5 * CIRCUMFERENCE = 219.91`，本应占圆环 $0.5\%$ 细缝的微小模型，在界面上霸占了**整整半个圆环（180 度）**；
     - 若另一模型占 $99.5\%$（归一化为 $0.995$），二者比例之和达 $0.995 + 0.5 = 1.495 = 149.5\%$，SVG 弧线在周长处发生反向越界重叠并遮盖前序切片。
- **修复加固建议**：
  废除基于 `rawVal > 1.0` 的二分启发式猜测逻辑。前端 contract 明确定义 `percentage` 的基准量纲（统一为 `0~100` 或 `0~1`）。若入参来自后端的 `m.percentage`，必须严格执行 `rawVal / 100.0`，禁止对小于等于 1 的百分数值漏做归一化。

---

### 缺陷 ISSUE-02：本地数据库零记录状态下后端硬编码伪造数据违背真实性
- **严重度**：P0
- **涉及文件与行号**：
  - `crates/conex-db/src/usage_analytics.rs:519-545`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:203-218`
- **缺陷确凿证据**：
  ```rust
  // usage_analytics.rs:519-528
  let top_model = models
      .first()
      .map(|m| m.model.clone())
      .unwrap_or_else(|| "deepseek-v4-flash".to_string());

  let top_project = project_counts
      .into_iter()
      .max_by_key(|(_, cnt)| *cnt)
      .map(|(p, _)| p)
      .unwrap_or_else(|| "conex".to_string());

  // usage_analytics.rs:531-545
  let mut max_window_sum: u64 = 0;
  let mut best_start_h: usize = 20; // 默认 20:00
  for h in 0..22 {
      let sum = hour_activity[h] + hour_activity[h + 1] + hour_activity[h + 2];
      if sum > max_window_sum {
          max_window_sum = sum;
          best_start_h = h;
      }
  }
  let peak_active_hour_range = match best_start_h {
      0..=5 => "凌晨 00:00 – 05:00".to_string(),
      6..=11 => "上午 09:00 – 12:00".to_string(),
      12..=17 => "下午 14:00 – 17:00".to_string(),
      _ => "晚间 20:00 – 23:00".to_string(),
  };
  ```
- **证据与现场复现**：
  1. 当用户首次安装应用、新工作区无记录或刚执行完“清空用量历史”时，数据库记录数为 0。
  2. 此时 `models` 向量为空，`top_model` 被 `unwrap_or_else` 伪造成 `"deepseek-v4-flash"`；
  3. `project_counts` 为空哈希表，`top_project` 被伪造成 `"conex"`；
  4. `hour_activity` 数组 24 小时全为 0，循环体内条件 `sum > max_window_sum`（$0 > 0$）永远不成立，`best_start_h` 维持默认值 `20`，导致 `peak_active_hour_range` 被伪造为 `"晚间 20:00 – 23:00"`；
  5. 前端在空库状态下渲染出：“最常用的模型：deepseek-v4-flash”、“最常工作的项目：conex”、“最活跃的时间：晚间 20:00 – 23:00”。直接伪造用户使用行为画像，属于严重的数据真实性破坏。
- **修复加固建议**：
  当 `total_messages == 0` 或 `grand_total_tokens == 0` 时，`top_model`、`top_project`、`peak_active_hour_range` 必须返回空值或结构化空态标记（如 `""`、`None` 或 `"—"`），前端统一呈现“无记录”。

---

### 缺陷 ISSUE-03：X 轴 24h 抽稀算法在滑动时钟窗口下发生相邻刻度物理叠字碰撞
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts:80-95`
- **缺陷确凿证据**：
  ```typescript
  // usageSpline.ts:80-95
  const targetIndices = new Set<number>();
  targetIndices.add(0);
  targetIndices.add(n - 1);

  if (range === '24h' && n >= 24) {
    for (let i = 0; i < n - 1; i++) {
      const lbl = points[i]!.label;
      if (
        lbl.endsWith('00:00') ||
        lbl.endsWith('06:00') ||
        lbl.endsWith('12:00') ||
        lbl.endsWith('18:00')
      ) {
        targetIndices.add(i);
      }
    }
  }
  ```
- **数学证明与反例**：
  1. 设用户在本地时间 `16:20` 打开页面，近 24 小时时钟分桶序列共 24 点：
     - `points[0]` 标签为 `"17:00"`（昨日）
     - `points[1]` 标签为 `"18:00"`
     - `points[23]` 标签为 `"16:00"`（今日）
  2. `targetIndices.add(0)` 强制将索引 0 加入刻度集合。
  3. 循环遍历至 `i = 1` 时，`points[1].label` 为 `"18:00"`，命中 `lbl.endsWith('18:00')`，触发 `targetIndices.add(1)`。
  4. 此时集合中并存相邻索引 `[0, 1]`。
  5. 物理几何坐标推导：
     - 容器基准宽度为 $760\text{px}$，绘图区横向跨度为 $xStart = 40\text{px}, xEnd = 750\text{px}$。
     - 刻度 0：$x_0 = 40\text{px}$，`leftPercent = 5.26%`，`transform: translateX(0%)`。文字宽度约为 $35\text{px}$，覆盖区间为 $[40\text{px}, 75\text{px}]$。
     - 刻度 1：$posRatio = \frac{1}{23} \approx 0.04348$，$x_1 = 40 + 0.04348 \times 710 = 70.87\text{px}$，`leftPercent = 9.32%`，`transform: translateX(-50%)`。其水平居中于 $70.87\text{px}$，文字覆盖区间为 $[70.87 - 17.5, 70.87 + 17.5] = [53.37\text{px}, 88.37\text{px}]$。
     - 两个文本在横向区间 $[53.37\text{px}, 75.0\text{px}]$ 产生长达 **$21.63\text{px}$ 的直接重叠相交**，文字发生难以辨识的混叠乱象。
  6. 同理，当终点前一小时落在静态锚点时，索引 $n-2$ 与 $n-1$ 亦会在右边缘发生重叠碰撞。
- **修复加固建议**：
  刻度抽稀严禁使用静态绝对整点比对。应基于等分几何距离（步长 $\approx \frac{n-1}{4}$），或者在抽取候选点后加入物理防碰撞步长守卫：$\Delta \text{index} \ge 3$，凡与边界点距离过近的候选点必须剔除。

---

### 缺陷 ISSUE-04：热力图状态与主控制台异步脱节导致清空/刷新历史时产生幽灵数据残留
- **严重度**：P1
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx:67-84, 148, 157-160`
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.tsx:37-45`
- **缺陷确凿证据**：
  ```tsx
  // SettingsUsageTab.tsx:76-80
  const cleared = await clearUsageHistory();
  if (cleared) {
    showToast('用量历史已清空');
    void loadData(globalRange); // 仅刷新 dashboardData
  }

  // ActivityMatrixHeatmap.tsx:33-45
  const [matrixRange, setMatrixRange] = useState<'24h' | '7d' | '30d'>('30d');
  const [matrixData, setMatrixData] = useState<ActivityMatrixDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getActivityMatrix(matrixRange).then((data) => {
      if (!cancelled) setMatrixData(data);
    });
    return () => { cancelled = true; };
  }, [matrixRange]);
  ```
- **证据与现象复现**：
  1. `ActivityMatrixHeatmap` 的时序热力数据 `matrixData` 采用内部隔离 state，其 `useEffect` 的触发依赖项仅有自身私有的 `matrixRange`。
  2. 用户在控制台底部点击“清空历史”或“刷新数据”时，触发的是父级 `SettingsUsageTab` 的 `loadData`，该函数只请求了 `usage_get_dashboard_data`。
  3. `ActivityMatrixHeatmap` 组件未接收任何重载指令，其 `matrixRange` 未变化，热力图内部的 `useEffect` **完全不会触发**。
  4. 现场表现：顶部英雄卡片、趋势图与模型占比均归零，但下方的活跃度矩阵依然完好保留着历史清空前的色块与调用记录，数据视图严重精神分裂。
- **修复加固建议**：
  在 `ActivityMatrixHeatmapProps` 中引入 `refreshSignal: number` 或 `onRefresh` 统一调度机制，使父级在执行清空或全局刷新时能强制同步触发表格与热力图两路重拉。

---

### 缺陷 ISSUE-05：热力图分级映射公式存在对数端点退化（Level 4 成为测度为零的孤立极点）
- **严重度**：P2
- **涉及文件与行号**：
  - `crates/conex-db/src/usage_analytics.rs:760-770`
- **缺陷确凿证据**：
  ```rust
  // usage_analytics.rs:763-768
  let ln_val = (1.0 + cell.tokens as f64).ln();
  let ln_min = (1.0 + min_nonzero as f64).ln();
  let ln_max = (1.0 + max_tokens as f64).ln();
  let ratio = ((ln_val - ln_min) / (ln_max - ln_min + 1e-6)).clamp(0.0, 1.0);
  let lvl = 1 + (ratio * 3.0).floor() as u8;
  cell.level = lvl.clamp(1, 4);
  ```
- **数学证明与反例**：
  1. `ratio` 的取值区间严格位于 $[0.0, 1.0]$。
  2. 观察映射函数 $f(ratio) = 1 + \lfloor ratio \times 3.0 \rfloor$：
     - 当 $ratio \in [0, 1/3)$ 时，$\lfloor ratio \times 3 \rfloor = 0 \implies lvl = 1$（覆盖区间长度 $33.3\%$）；
     - 当 $ratio \in [1/3, 2/3)$ 时，$\lfloor ratio \times 3 \rfloor = 1 \implies lvl = 2$（覆盖区间长度 $33.3\%$）；
     - 当 $ratio \in [2/3, 1.0)$ 时，$\lfloor ratio \times 3 \rfloor = 2 \implies lvl = 3$（覆盖区间长度 $33.3\%$）；
     - 当且仅当 $ratio = 1.0$ 时，$\lfloor 1.0 \times 3 \rfloor = 3 \implies lvl = 4$（覆盖区间为一个**无长度的单点集 $\{1.0\}$**）。
  3. **反例**：假设某单元格的 Token 消耗占全周期峰值的 $99.9\%$（如 `max_tokens = 100,000`，该单元格为 `99,900`），此时 $ratio \approx 0.9999$：
     $$lvl = 1 + \lfloor 0.9999 \times 3.0 \rfloor = 1 + 2 = 3$$
     即使其实际用量高达峰值的 $99.9\%$，依然只能拿到倒数第二级的 Level 3，Level 4 在实际渲染中几乎完全灭绝。
- **修复加固建议**：
  调整为标准的 4 等分对数分箱算法：
  ```rust
  let lvl = 1 + ((ratio * 4.0).floor() as u8).min(3);
  ```
  使 Level 1、2、3、4 各自均衡拥有 $25\%$ 的比例跨度。

---

### 缺陷 ISSUE-06：SVG 饼图切片在累加过程中缺失剩余圆周闭环钳位保护
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:41-61`
- **缺陷确凿证据**：
  ```typescript
  // ModelDistributionSection.tsx:41-52
  let accumulated = 0;
  return models
    .slice(0, 5)
    .filter((m): m is UsageModelBreakdownItem => Boolean(m))
    .map((m, idx) => {
      const rawRatio = m.percentage > 0 ? m.percentage : (totalTokens > 0 ? m.tokens / totalTokens : 0);
      const normRatio = normalizeModelRatio(rawRatio);
      const dash = normRatio * CIRCUMFERENCE;
      const offset = -accumulated;
      accumulated += dash;
      ...
  ```
- **数学证明与反例**：
  1. 常数 $CIRCUMFERENCE = 2 \times \pi \times 70 \approx 439.82297$。
  2. 当由于浮点加法精度舍入，或者后端传来的百分比项由于四舍五入后之和略微大于 100%（例如三项分别为 $33.34\%, 33.33\%, 33.34\%$，累加值为 $100.01\%$）时：
     $$accumulated + dash > CIRCUMFERENCE$$
  3. 在 SVG `<circle>` 元素上，当 `strokeDashoffset` 为负值且偏移距离与虚线长度之和突破圆周全长时，SVG 引擎会将超出部分回绕绘制至 $0^\circ$ 起点处，造成最后一个切片的末端反向重叠在首个切片起始处，产生脏锯齿与色彩污染。
  4. 代码中未对 `dash` 进行剩余弧长防护：未限制 `Math.min(dash, Math.max(0, CIRCUMFERENCE - accumulated))`。
- **修复加固建议**：
  在计算 `dash` 时强制执行剩余周长截断：
  ```typescript
  const remaining = Math.max(0, CIRCUMFERENCE - accumulated);
  const dash = Math.min(normRatio * CIRCUMFERENCE, remaining);
  ```

---

### 缺陷 ISSUE-07：存量快照迁移器按 30 天静态假定折算时间戳致使真实日期产生 1~2 天系统性漂移
- **严重度**：P2
- **涉及文件与行号**：
  - `crates/conex-db/src/usage_analytics.rs:288-290`
- **缺陷确凿证据**：
  ```rust
  // usage_analytics.rs:288-290
  let approx_days = (y as i64 - 1970) * 365 + ((y as i64 - 1969) / 4) + ((m as i64 - 1) * 30) + (d as i64 - 1);
  let timestamp = approx_days * 86_400_000 + 12 * 3_600_000;
  ```
- **数学反例与逻辑证明**：
  1. 迁移器在解析旧版 LocalStorage 的日期串（如 `"2026-03-01"`）时，使用 `((m - 1) * 30)` 粗暴替代月份天数。
  2. **反例 1**：日期为 `"2026-03-01"`：
     - 公历实际累计天数：1月（31天）+ 2月（28天）= 59 天。
     - 公式计算：$(3 - 1) \times 30 = 60$ 天！计算值比实际多出整整 1 天。
  3. **反例 2**：日期为 `"2026-08-01"`：
     - 公历实际累计天数：31+28+31+30+31+30+31 = 212 天。
     - 公式计算：$7 \times 30 = 210$ 天！计算值比实际少 2 天。
  4. 本模块 136-148 行已具备完整的高精度 Howard Hinnant 天数转换算法，此处却自相矛盾地采用了粗糙经验公式，导致用户导入的存量数据在日历图和分桶走势上全部落入错误的星期与日期桶。
- **修复加固建议**：
  使用标准的公历逆算逻辑（逆 Howard Hinnant 算法）精确计算从 1970-01-01 起算的天数，彻底废除 `* 30` 估算。

---

### 缺陷 ISSUE-08：折线图悬浮卡片初次测量受脱水（offsetWidth: 0）影响致视口右边缘截断
- **严重度**：P2
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:108-122`
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.module.css:126-143`
- **缺陷确凿证据**：
  ```typescript
  // UsageTrendChart.tsx:108-122
  const tooltipStyle = useMemo(() => {
    if (hoverIdx === null || !containerRef.current || computedSeries.length === 0) {
      return { display: 'none' };
    }
    const containerW = containerRef.current.clientWidth || 760;
    const idealX = (computedSeries[0]?.points[hoverIdx]?.x ?? xStart) / 760 * containerW;
    const cardW = tooltipRef.current?.offsetWidth || 160;
    const clampedX = clampViewportX(idealX, cardW, containerW, 6);

    return {
      left: `${clampedX}px`,
      transform: 'translateX(-50%)',
      display: 'flex',
    };
  }, [hoverIdx, computedSeries]);
  ```
- **证据与现场分析**：
  1. 未 hover 时，卡片处于 `display: 'none'` 状态。在标准浏览器中，隐藏节点的 `offsetWidth` 恒为 `0`。
  2. 鼠标首次滑入右边缘采样点时，React 在渲染周期中评估 `useMemo`，此时 DOM 尚未解除 `display: none`，读取 `tooltipRef.current.offsetWidth` 得到 `0`，表达式 `0 || 160` 回退到假定值 `160px`。
  3. 当图表处于多模型维度时，卡片内含完整模型名与数值，实际宽度普遍在 `260px ~ 320px`。
  4. 几何计算：容器宽 $760\text{px}$，右边缘点 $idealX = 740\text{px}$。由于 `cardW` 被错认为 $160\text{px}$，`clampViewportX` 将中心点限制在 $760 - 80 - 6 = 674\text{px}$。然而卡片实际半宽为 $150\text{px}$，其实际右边界为 $674 + 150 = 824\text{px}$，**直接向右突围穿透容器 64 像素**，文字被裁剪。
  5. `useMemo` 依赖项中缺少 DOM 尺寸变更监听，卡片位置不会根据实际内容自适应重新校准。
- **修复加固建议**：
  改用 `visibility: hidden` 替代 `display: none` 维持 DOM 几何占位以获取真实 `offsetWidth`，或采用 CSS 纯样式钳位（例如 `left: clamp(...)`）。

---

### 缺陷 ISSUE-09：CSS Grid 缺失 `min-width: 0` 导致超长模型名称破坏排版撑爆容器
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ActivityMatrixHeatmap.module.css:174-187, 206-213`
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.module.css:103-118`
- **缺陷确凿证据**：
  ```css
  /* ActivityMatrixHeatmap.module.css:174-187 */
  .activityStatsGrid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px 20px;
  }

  .actStatItem {
    display: flex;
    flex-direction: column;
    gap: 4px;
    /* 缺失 min-width: 0 */
  }

  .actStatValCode {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ```
- **证据与现象分析**：
  1. 依据 W3C CSS Grid 规范，Grid Item 的默认最小宽度为 `min-width: auto`。
  2. 当子元素 `.actStatValCode` 声明 `white-space: nowrap` 时，若容器未声明 `min-width: 0`，其最小内容宽度（`min-content`）将被锁定为整串未换行文字的完整宽度。
  3. 当模型名称极长（例如 `deepseek-ai/DeepSeek-V3-LongContext-Expanded-Turbo`，字符数 $> 40$）时，`text-overflow: ellipsis` **彻底失效**，第三列网格强行横向拉宽，打穿右侧内边距并造成卡片整体横向形变溢出。
  4. `ModelDistributionSection.module.css` 中的 `.legendMiniItem` 同样缺失宽度收缩控制与省略截断，长模型名会产生多行断裂折行。
- **修复加固建议**：
  在 `.actStatItem` 及其子元素上显式声明 `min-width: 0;`；在 `.legendMiniItem` 及其标签上施加 `max-width: 140px; text-overflow: ellipsis;`。

---

### 缺陷 ISSUE-10：跨图表组件间模型调色板语义断层导致同屏色彩冲突
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.tsx:22-30`
  - `apps/crish-desktop/src/components/settings/usage/usageChartModel.ts:45-51, 96, 129`
- **缺陷确凿证据**：
  ```typescript
  // ModelDistributionSection.tsx:22-30 (语义绑定)
  if (lower.includes('deepseek')) return PALETTE[0];
  if (lower.includes('claude')) return PALETTE[1];
  if (lower.includes('minimax')) return PALETTE[2];
  if (lower.includes('kimi')) return PALETTE[3];

  // usageChartModel.ts:96, 129 (数组物理索引盲选)
  color: PALETTE[idx % PALETTE.length] ?? PALETTE[0]
  ```
- **证据与视觉违和**：
  1. 若用户近 7 天主力模型仅有 `claude-3-7-sonnet`，其在列表首位（`idx = 0`）。
  2. 下方“模型用量”胶囊列表与饼图中，Claude 识别命中关键词 `claude`，分配紫色（`PALETTE[1]`）；
  3. 上方“吞吐趋势”折线图中，Claude 属于第一序列（`idx = 0`），直接使用 `PALETTE[0]`（主品牌深蓝）；
  4. 同一页面上下相邻的两个图表，指涉同一模型却呈现截然不同的两种主色，违背单一视觉真理源（SSOT）规范。
- **修复加固建议**：
  将 `getModelColor` 纯函数提升为共享公共工具，趋势图序列色彩构建与饼图完全共用语义调色策略。

---

### 缺陷 ISSUE-11：`formatTokens` 在 0.99995 亿临界区间输出伪科学单位“10000 万”
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/usageSpline.ts:17-24`
- **缺陷确凿证据**：
  ```typescript
  // usageSpline.ts:17-24
  if (v >= 100_000_000) {
    const yi = v / 100_000_000;
    return `${yi >= 10 ? yi.toFixed(1) : yi.toFixed(2)} 亿`;
  }
  if (v >= 10_000) {
    const w = v / 10_000;
    return `${w >= 100 ? w.toFixed(0) : w >= 10 ? w.toFixed(1) : w.toFixed(2)} 万`;
  }
  ```
- **数学反例**：
  1. 取临界点数值 $v = 99,995,000$：
  2. 由于 $99,995,000 < 100,000,000$，未能进入“亿”级别判断，落入“万”级别分支。
  3. 计算 $w = \frac{99,995,000}{10,000} = 9999.5$。
  4. 由于 $9999.5 \ge 100$，执行 `w.toFixed(0)`，四舍五入得到字符串 `"10000"`。
  5. 最终函数输出结果为 `"10000 万"`，而非正常的 `"1.00 亿"`。
- **修复加固建议**：
  在四舍五入后增加进位检测：若 `toFixed(0)` 的结果达到 $10000$，自动晋级为下一量纲（`1.00 亿`）。

---

### 缺陷 ISSUE-12：趋势折线图内部基于采样点长度盲猜时间范围架构隐患
- **严重度**：P3
- **涉及文件与行号**：
  - `apps/crish-desktop/src/components/settings/usage/UsageTrendChart.tsx:62-66`
- **缺陷确凿证据**：
  ```typescript
  // UsageTrendChart.tsx:62-66
  const rangeGuess: '24h' | '7d' | '30d' = useMemo(() => {
    if (points.length <= 8) return '7d';
    if (points.length <= 25) return '24h';
    return '30d';
  }, [points.length]);
  ```
- **证据与设计违背**：
  1. 父级 `SettingsUsageTab` 明确持有 `globalRange` 权威状态，但在向 `UsageTrendChart` 传递 props 时却省略了 `range`。
  2. 子组件依赖点数长度进行魔术数字二分猜测：
     - 若未来采样频率改变或由于接口抖动导致 24h 返回 8 个分段，子组件将误判为 7d，从而错误调用 7d 的刻度逻辑；
     - 违反显式单向数据流原则，属于架构坏味道。
- **修复加固建议**：
  在 `UsageTrendChartProps` 中显式要求传入 `range: '24h' | '7d' | '30d'`，彻底移除 `rangeGuess`。

---

## 验证与验收基线

1. **零记录空态验收**：清空数据库后，全景看板禁止出现任何预设的非空字符串模型、项目或时段，均须呈现规范的 Clean Empty State。
2. **比例守卫验收**：补充单元测试用例 `normalizeModelRatio(0.5)` 必须严格断言为 `0.005`，`formatPercentage(0.5)` 必须严格断言为 `0.5%`，杜绝 100 倍暴涨。
3. **X 轴几何验收**：在 24h 滑动窗口下，所有刻度标签的横向几何跨度必须保证相距 $\ge 60\text{px}$，杜绝任意重叠。
4. **生命周期同步验收**：清空历史或刷新控制台时，热力图矩阵与上方趋势图必须同步重拉并归零。
