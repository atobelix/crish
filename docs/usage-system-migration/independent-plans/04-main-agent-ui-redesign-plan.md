# 用量监控控制台界面与交互系统级重构方案（主 Agent 案）

> **文档定位**：`docs/usage-system-migration/independent-plans/04-main-agent-ui-redesign-plan.md`  
> **关联依据**：用户现场 3 张真机截图反馈、工程既有设计资产库（`components/ui/` 与 `components/settings/SettingsUI.tsx`）、`AGENTS.md` 架构红线。

---

## 一、用户现场批评与六大核心缺陷根因诊断

对照用户上传的 3 张现场真机截图与严厉指导，现将六大核心问题的根本原因与解决方针确立如下：

### 1. 虚假数据问题（已彻底清退，确立零伪造红线）
- **现象**：用户今天未发起过任何对话，界面却凭空展示了 12.9 万 Token、¥3.17 预估金额以及 4 个模型的时序分布。
- **根因**：此前在开发联调阶段，测试脚本向本地真实 SQLite 数据库（`apps/agent-workbench/sessions.db` 的 `usage_records` 表）注入了 26 条带有 `sess-test-*` 前缀的假数据。
- **治理**：
  - 本地数据库中 26 条假数据已全部物理执行 `DELETE` 清理完毕，当前记录数为真实 0；
  - 确立**“有就是有，没有就是没有，绝不伪造数据”**铁律；
  - 各模块全面接入真实、高质感的**标准空态（Clean Empty State）**。

### 2. 用户自研原子组件未对接（图三标号 ① 和 ②）
- **现象**：顶栏时间切换、折线图走势维度切换、热力图时间切换，全部使用裸 `div` 拼装 `Button` 手写伪分段样式。
- **根因**：忽略了工程中已有的具有同心大圆角、物理贝塞尔滑块动画、WAI-ARIA RadioGroup 规范的原子组件 `SegmentedControl.tsx`。
- **治理**：全量清退手写伪分段，无缝对接用户做好的 `SegmentedControl`（`size="sm"` 与 `size="xs"`）。

### 3. 折线走势图 X 轴时间刻度严重拥挤叠字（图三标号 ③）
- **现象**：在 24 小时模式下，整整 24 个“HH:00”标签挤在单行，变成 `09:0010:0011:00...` 无法辨识的长串字符。
- **根因**：无脑遍历 `points.map` 渲染全部 24 个 `<span>`，未做任何时序刻度抽稀。
- **治理**：引入**均匀抽稀算法**，24h 仅保留 4~6 个代表性锚点（如 00:00、06:00、12:00、18:00 及当前最新时间），其余刻度自适应隐藏，彻底消灭叠字。

### 4. 私造样式类物理删除与卡片不对齐
- **现象**：`_heroSubtext`、`_labelDot`、`_labelDotCost` 等私造样式类散落；左卡片是 4 项紧凑网格小字，右卡片是 1 行纯文本，左右高度、字阶、基线完全脱节。
- **治理**：
  - 用户明确指令：**“发给你的那些类都是要删除的”**，物理删除上述全部类名；
  - 全面使用系统统一的 `SettingsCard`（来自 `components/settings/SettingsUI.tsx`）标准容器；
  - 左右卡片做严格对称重构（指标名、大数字+单位基线对齐、底部 3 列等宽栅格子项信息）。

### 5. 模型用量百分比 3573.3% 荒谬 Bug 与胶囊条对齐（图二）
- **现象**：百分比显示为 `3573.3%`，圆环 SVG 变成实心粗红圈；hover 柱状图时其他条目变成死灰、圆环发生粗暴膨胀。
- **根因**：后端 Rust 返回的 `percentage` 已经是乘了 100 的数值（如 `35.73`），前端 `formatPercentage` 又乘了一次 100，二次放大 100 倍。
- **治理**：
  - 修复比率二次放大 Bug，归一化在 `0~1` 范围；
  - 100% 对齐用户图二右侧的标准高质感胶囊列表设计；
  - 拔除粗暴的 `opacity: 0.6`，采用微光提亮与平滑弧度高亮，根治脏灰与抖动。

### 6. 三个带图标按钮对齐与 Token 纯净化
- **现象**：“配置单价”、“刷新数据”、“清空历史”按钮图标和文字没对齐；清空历史在 `:hover` 里硬编码 `rgba(220, 38, 38, 0.08)`。
- **根因**：将 `<Lucide.* />` 作为 children 传入且外加手写类覆盖，破坏了 `Button` 内部的 flex 居中机制；未复用系统标准的 `variant="danger"`。
- **治理**：统一使用 `<Button variant="secondary" / "ghost" / "danger" size="sm" icon={<Lucide.* />} >`，由组件内部标准 Tokens 与容器统一步距与居中。

### 7. 活动热力图排版与 Tooltip（图一）
- **现象**：左侧 Y 轴 `width: 32px` 导致文字强制折行重叠；单元格悬浮手写绝对坐标与浮层。
- **治理**：放宽 Y 轴至充足宽度，采用“主标（凌晨）+ 微标（00-06）”宽松排版；单元格 100% 对接系统标准 `<Tooltip content="...">`。

---

## 二、逐组件架构重构蓝图与规范对接

### 1. `SettingsUsageTab.tsx`（页面顶层与按钮对齐）

#### 布局架构升级
- 顶部标题与工具栏：
  ```tsx
  <SettingsPage
    title="用量"
    meta={
      <SettingsHeadTools>
        <SegmentedControl
          size="sm"
          value={globalRange}
          onChange={(val) => setGlobalRange(val as '24h' | '7d' | '30d')}
          options={[
            { value: '24h', label: '近 24 小时' },
            { value: '7d', label: '近 7 日' },
            { value: '30d', label: '近 30 日' },
          ]}
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<Lucide.DollarSign size={14} />}
          onClick={() => setPricesModalOpen(true)}
        >
          配置单价
        </Button>
      </SettingsHeadTools>
    }
  >
  ```
- 底栏操作按钮纯净化：
  ```tsx
  <div className={styles.actionsBar}>
    <Button
      variant="ghost"
      size="sm"
      icon={<Lucide.RefreshCw size={13} />}
      onClick={() => void loadData(globalRange)}
    >
      刷新数据
    </Button>
    {hasUsageData && (
      <Button
        variant="danger"
        size="sm"
        icon={<Lucide.Trash2 size={13} />}
        onClick={() => void handleClearHistory()}
      >
        清空历史
      </Button>
    )}
  </div>
  ```

---

### 2. `UsageSummaryHero.tsx`（私造类彻底删除与绝对对称重塑）

#### 彻底删除的样式类
- `_heroSubtext_15ppp_64` ➜ 彻底删除
- `_labelDot_15ppp_31` ➜ 彻底删除
- `_labelDotCost_15ppp_42` ➜ 彻底删除
- `_labelDotTokens` ➜ 彻底删除

#### 左右严格对称结构
左右两个卡片统一包裹在系统的 `<SettingsCard>` 内，内部为纯对称的 3 层结构：
1. **Header（标头层）**：
   - 左：`总用量` + `<Tooltip content="统计周期内输入、输出与缓存读取 Token 累加总量">`
   - 右：`预估金额` + `<Tooltip content="依据官方标准费率或自定义单价折算的预估费用">`
2. **Metric（数值层）**：
   - 左：大号数值 `formatTokens(totalTokens)` + 浅灰单位 `tokens`（基线对齐）
   - 右：大号数值 `formatCost(totalCost, currencySymbol)` + 浅灰单位 `CNY / USD`（基线对齐）
3. **Details（对称子项栅格）**：
   左右均采用严格的 3 列等宽栅格（Grid 3 Columns），对齐行高与字阶：
   - 左卡片：
     - `输入: formatTokens(totalInput)`
     - `输出: formatTokens(totalOutput)`
     - `缓存: formatTokens(totalCacheRead)`
   - 右卡片：
     - `币种: currency`
     - `日均: formatCost(dailyAverageCost)`
     - `标准: 官方标准费率`

---

### 3. `UsageTrendChart.tsx`（X 轴刻度抽稀与维度切换）

#### 1. 维度切换接入系统 `SegmentedControl`
```tsx
<SegmentedControl
  size="xs"
  value={dimension}
  onChange={(val) => setDimension(val as 'overview' | 'models' | 'cost')}
  options={[
    { value: 'overview', label: '吞吐总览' },
    { value: 'models', label: '模型对比' },
    { value: 'cost', label: '费用走势' },
  ]}
/>
```

#### 2. X 轴时序刻度均匀抽稀算法
```ts
/** 依据总点数与时间跨度智能决定刻度是否显现 */
export function isTickVisible(index: number, total: number, range: string): boolean {
  if (total <= 7) return true;
  if (range === '24h') {
    // 24 小时：00:00, 06:00, 12:00, 18:00 及最新当前时间
    return index % 6 === 0 || index === total - 1;
  }
  if (range === '30d') {
    // 30 天：每 6 天一个刻度及最新当前日期
    return index % 6 === 0 || index === total - 1;
  }
  return true;
}
```
在 JSX 中：
```tsx
<div className={styles.chartXAxis}>
  {points.map((pt, i) => {
    const visible = isTickVisible(i, points.length, globalRange);
    return (
      <span
        key={`xlbl_${pt.timestamp}_${i}`}
        className={`${styles.axisTick} ${i === points.length - 1 ? styles.tickNow : ''}`}
        style={{ visibility: visible ? 'visible' : 'hidden' }}
      >
        {pt.label}
      </span>
    );
  })}
</div>
```
- 保留原有 flex 等宽占位以保证吸附十字线 100% 几何对齐；
- 对非采样点使用 `visibility: hidden` 留空，彻底根除叠字乱码！

#### 3. 走势图空态处理
当 `maxTokens === 0 && maxCost === 0` 时，绘制一条干净贴合底部的基线，并在图表正中央呈现浅灰微提示：“暂无用量时序数据”，图例与坐标系骨架保持优雅完整。

---

### 4. `ModelDistributionSection.tsx`（对齐图二右侧规范）

#### 1. 百分比归一化修复
```ts
// 修复 100 倍暴涨 Bug
const ratio = m.percentage > 0 
  ? m.percentage / 100 
  : (totalTokens > 0 ? m.tokens / totalTokens : 0);
const formattedPct = `${(ratio * 100).toFixed(1)}%`;
```

#### 2. 100% 对齐图二右侧的高质感胶囊列表
- 每一条模型条目：
  - 容器尺寸：固定高度 34px，同心圆角 6px，内边距 `0 12px`；
  - 进度底色：`background: color.bg`，宽度精确对应 `ratio * 100%`；
  - 左侧：深色实体纯色点（8px 圆角纯色点） + 模型名（如 `deepseek-v4-flash`），字重 500；
  - 右侧：Token 数（如 `12.7 万`） + 百分比（如 `44.5%`），等宽字体 `tabular-nums`。
- 交互纯净化：
  - **彻底移除 `opacity: 0.6`**（不再让未 hover 的条目变成死灰）；
  - hover 当前项时：仅对当前项施加柔和微光浮起与轻量背景提亮；
  - 环形图弧度仅做高光提示，不改变 strokeWidth，杜绝抖动。

---

### 5. `ActivityMatrixHeatmap.tsx`（Y 轴排版与 Tooltip 归一）

#### 1. 跨度切换接入系统 `SegmentedControl`
```tsx
<SegmentedControl
  size="xs"
  value={matrixRange}
  onChange={(val) => setMatrixRange(val as '24h' | '7d' | '30d')}
  options={[
    { value: '24h', label: '24 小时' },
    { value: '7d', label: '7 天' },
    { value: '30d', label: '30 天' },
  ]}
/>
```

#### 2. 左侧 Y 轴行标题宽松排版
- 将 `activityYAxis` 宽度调整为自适应（`min-width: 56px`）；
- 结构分为两行，避免横向折叠：
  ```tsx
  <div className={styles.yAxisItem}>
    <span className={styles.yAxisMain}>凌晨</span>
    <span className={styles.yAxisSub}>00-06</span>
  </div>
  ```
- 样式声明 `white-space: nowrap`，字阶清晰、垂直居中，绝不重叠。

#### 3. 彻底接入系统 `<Tooltip>`
- 彻底拔除手写的 `getBoundingClientRect` 与 `activeTooltip` 绝对定位浮层；
- 每一个单元格统一使用系统标准 `<Tooltip>`：
  ```tsx
  <Tooltip
    content={
      cell.calls > 0
        ? `${cell.colLabel} ${cell.rowLabel} · ${cell.calls} 次调用 · ${formatTokens(cell.tokens)} tokens`
        : `${cell.colLabel} ${cell.rowLabel} · 无活动`
    }
  >
    <div
      className={`${styles.activityCell} ${getLvlClass(cell.level)}`}
      role="gridcell"
      aria-label={`${cell.colLabel} ${cell.rowLabel}`}
    />
  </Tooltip>
  ```

---

## 三、真实数据闭环与空态验证计划

1. **零伪造断言**：在清空假数据的真实数据库下，启动应用，确认用量控制台所有模块均进入标准空态，无报错、无虚假数值；
2. **门禁断言**：
   - 运行 `node scripts/check-frontend-convergence.mjs` 确认 0 裸标签、0 原生 title、0 违规；
   - 运行 `npm run check:line-counts` 确保单文件行数合规；
   - 运行 `npm run typecheck` 保证类型 0 错误；
3. **视觉走查断言**：
   - 图标与文字 100% 垂直对齐；
   - X 轴刻度呼吸舒展，无文字挤压重叠；
   - 左右两张卡片绝对对称，私造类名全部清退；
   - 模型用量胶囊条对齐图二右侧规范，百分比总和为 100%。
