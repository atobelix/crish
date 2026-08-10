// tests/perf/suite/budgets.mjs
// 阈值常量总表（A6 §2.7 指标清单 + §5.2 校准表落地；「改一处」原则：
// 所有档位判定统一读本模块，任何阈值修订只改这里并附理由）。
//
// 结构约定：
// - 每项 { 指标ID: { 阈值字段, 分档（ci/nightly/local 相同则不重复写）,
//                    rationale: 依据, tuned: 是否已定档 } }；
// - tuned=false 表示「首跑采集定档」项（M6）：设计推定值仅登记，首跑后
//   按实测回写并附理由（A6 §5.2/§6 定档协议：禁止静默放宽）；
// - 0 容忍类（M2a/M2b/M2c/M3/M4）为硬门槛：无宽容阈值、无放行协议
//   （A6 §2.2-2.4 目标语义，A6 §3.3 阈值放行协议：0 容忍类无放行）。
//
// 校准依据（A6 §5.2 校准表）：
// - M1a 帧内 JS P95 ≤4ms：R2 profile 击键全链路 JS ~4ms；R6 全链路 1.0ms；
// - M1b layout+paint：ci headless ≤20ms（R6 滚动总帧 21.8ms 扣除 JS 的
//   软件渲染惩罚）；nightly GPU ≤12ms（R6 流式总帧 P95 10.2-14.6ms 扣除 JS）；
// - M1c 长任务：R6 实测 1×99ms；口径「0 warn / ≥2 fail」；
// - M5a/M5b：R6 实测 +26.9~+43.1MB / ≤163.9MB，余量 +40% / +56%；
// - M5c：G9 heap-growth 口径（3 轮循环稳态增量 ≤5%），首次新口径；
// - M2a 相对脱节容差：relTolPx=2（亚像素+取整容差，远小于半行 14px）；
//   绝对突变 jumpTolPx=8（< 半行高 28/2，视觉不可感；作报告项而非判定项，
//   review-P3 维度 4：headless 丢帧时绝对突变双峰 120/240 必然触发，
//   判定主指标为 anchorDelta vs actualDelta 相对脱节，0 容忍）；
// - M2b：anchorRowError P95 ≤1 行；scrollHeightError ≤1%（01 §5.2 P1）；
// - M6a ≤2 次定型修正 / M6b LayoutCount ≤ 基线×2：设计推定值（首采定档）。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

/** 帧间隔保底预算（60fps；对齐既有 FRAME_BUDGET_MS 口径） */
export const FRAME_BUDGET_MS = 16.6;

/** 掉帧判定阈值（既有口径：>16.7ms 计一次掉帧） */
export const FRAME_OVER_MS = 16.7;

/** M2a/M2c 匀速 ramp 步进（px/帧 @60Hz，等价 7200px/s 滚动速度） */
export const RAMP_PX = 120;

/** 0 容忍硬门槛指标清单（A6 §3.3：0 容忍类无放行协议） */
export const ZERO_TOLERANCE_METRICS = ['M2a', 'M2b', 'M2c', 'M3', 'M4'];

/** 场景矩阵轴取值（A6 §3.2：2 行高 × 4 密度 × 2 滚动注入 = 16 组合） */
export const MATRIX_ROWS = [
  { id: 'std', label: '标准行高 28px', mixed: false },
  { id: 'mixed', label: '混合行高（标题 40px + 正文 28px）', mixed: true },
];
export const MATRIX_DENSITY = [
  { id: 'plain', label: '纯文本', scenario: 'plain' },
  { id: 'fence10', label: 'fence 10%', scenario: 'fence10' },
  { id: 'fence30', label: 'fence 30%', scenario: 'fence30' },
  { id: 'math5', label: '公式 5%', scenario: 'math5' },
];
export const MATRIX_INJECT = [
  { id: 'none', label: '无滚动注入', inject: false },
  { id: 'inject', label: '滚动中注入（500tps 流式 + 匀速滚动并发）', inject: true },
];

/**
 * ci 子集 4 组合（A6 §3.2：覆盖四个敏感维度各一档）：
 * - std-plain-none     基础帧率 + M2a/M2b（标准行高线性模型可用）
 * - std-plain-inject   M2c 直刷期间滚动（跳动关键轴）
 * - mixed-fence30-none 行高模型 + fence 重放成本
 * - std-math5-inject   公式渲染 + 滚动并发
 */
export const CI_SUBSET = [
  'std-plain-none',
  'std-plain-inject',
  'mixed-fence30-none',
  'std-math5-inject',
];

/**
 * 指标预算总表。每个预算项结构：
 * { tier: { ... }, rationale: string, tuned?: boolean, reportOnly?: boolean }
 * - 不写 tier 分档 = 三档同值；
 * - reportOnly=true：报告项（证据链），不参与 PASS/FAIL 判定。
 */
export const BUDGETS = {
  // ---- M1 帧内分布（A6 §2.1）----
  M1a: {
    // 帧内 JS 段 P95（rAF 打点近似，含 React 提交与被迫同步 layout）
    jsP95Ms: { ci: 4, nightly: 4, local: 4 },
    rationale: 'R2 profile 击键全链路 JS ~4ms；R6 全链路 1.0ms（01 §4.2 预算已达标）',
    tuned: true,
  },
  M1b: {
    // 帧内 layout+paint P95：渲染后端分档（headless 软件渲染惩罚 vs GPU）
    layoutPaintP95Ms: { ci: 20, nightly: 12, local: 12 },
    rationale: 'ci=headless 20ms（R6 滚动总帧 21.8ms 扣除 JS）；nightly=GPU 12ms（R6 流式实测）',
    tuned: true,
  },
  M1c: {
    // 长任务计数（滚动 3s）：0 次 warn、≥2 次 fail（A6 §2.7 口径）
    longTaskWarnAt: 0,
    longTaskFailAt: { ci: 2, nightly: 2, local: 2 },
    rationale: 'R6 实测 1×99ms；对齐 03 §9.2 G8 long-task 口径',
    tuned: true,
  },

  // ---- M2 滚动跳动（A6 §2.2；0 容忍硬门槛）----
  M2a: {
    // 相对脱节：|anchorDelta - actualDelta| > 2px 的帧数，0 容忍
    relDetachTolPx: { ci: 2, nightly: 2, local: 2 },
    // 绝对突变（报告项，不判 FAIL——headless 丢帧双峰 120/240 必然触发，
    // review-P3 维度 4：判定主指标为相对脱节）
    maxJumpErrPx: { ci: 8, nightly: 8, local: 8, reportOnly: true },
    jumpCount: { ci: 0, nightly: 0, local: 0, reportOnly: true },
    freezeReportAt: { ci: 2, nightly: 2, local: 2, reportOnly: true },
    rationale: '新指标 0 容忍：跳动 = 内容与滚动条脱节（anchorDelta vs actualDelta）',
    tuned: true,
  },
  M2b: {
    // 20 位置采样：锚点行误差 P95 ≤ 1 行；滚动条总高误差 ≤ 1%
    anchorRowErrorP95Rows: { ci: 1, nightly: 1, local: 1 },
    scrollHeightErrorPct: { ci: 1, nightly: 1, local: 1 },
    rationale: '01 §5.2 P1 指标落地；标准行高线性模型，混合行高组合跳过（null 标注）',
    tuned: true,
  },
  M2c: {
    // 直刷期间滚动（流式 + 匀速滚动并发）：相对脱节 0 容忍
    relDetachTolPx: { ci: 2, nightly: 2, local: 2 },
    maxJumpErrPx: { ci: 8, nightly: 8, local: 8, reportOnly: true },
    jumpCount: { ci: 0, nightly: 0, local: 0, reportOnly: true },
    rationale: '新指标 0 容忍：直刷 flush 不得产生可感跳动（A6 §2.2 M2c）',
    tuned: true,
  },

  // ---- M3 选区丢失率（A6 §2.3；0 容忍）----
  M3: {
    selectionLostCount: { ci: 0, nightly: 0, local: 0 },
    rationale: '0 容忍：直刷写 textContent 不得中断用户选区（A6 §2.3）',
    tuned: true,
  },

  // ---- M4 补全闪烁（A6 §2.4；0 容忍）----
  M4: {
    remountedRows: { ci: 0, nightly: 0, local: 0 },
    // 完成帧新增节点 ≤ 实际新增行数 + 2（允许流式新行挂载，禁止存量行重建）
    addedNodesSlack: { ci: 2, nightly: 2, local: 2 },
    rationale: '0 容忍：软渲染 → 完成态切换存量行零重建（N1 验收面）',
    tuned: true,
  },

  // ---- M5 内存曲线（A6 §2.5）----
  M5a: {
    // 60s 注入堆增长（起止差）
    heapGrowthMB: { ci: 60, nightly: 60, local: 60 },
    rationale: 'R6 实测 +26.9~+43.1MB，余量 +40%',
    tuned: true,
  },
  M5b: {
    // 堆峰值
    heapPeakMB: { ci: 256, nightly: 256, local: 256 },
    rationale: 'R6 实测 ≤163.9MB，余量 +56%',
    tuned: true,
  },
  M5c: {
    // 3 轮循环 GC 后稳态增量（nightly 专属；ci 单轮曲线不判此项）
    steadyGrowthPct: { ci: null, nightly: 5, local: 5 },
    rationale: 'G9 heap-growth 口径（3 轮循环稳态增量 ≤5%）；首次新口径',
    tuned: true,
    nightlyOnly: true,
  },

  // ---- M6 表格流式（A6 §2.6；首跑采集定档）----
  M6a: {
    // 单表列宽定型修正次数（首次定型后每次 setColumnWidth/setTableWidths 修正 +1）
    perTableSettles: { ci: 2, nightly: 2, local: 2 },
    rationale: '设计推定值（首挂载 + 至多 1 次修正）；无历史数据，首次采集定档',
    tuned: false, // 首跑后按实测回写（A6 §5.2/§6 定档协议）
  },
  M6b: {
    // 表格 reflow：LayoutCount/秒 ≤ 无表格对照基线 × 2
    layoutCountRatio: { ci: 2, nightly: 2, local: 2 },
    rationale: '设计推定值；基线取同档 plain 无表格场景的 LayoutCount/秒',
    tuned: false,
  },
};

/**
 * 场景运行参数（按档位裁剪；A6 §3.3 预估时长 ci ~5 分钟、nightly 25-30 分钟）：
 * - 矩阵文档行数：ci 3 万（快）、nightly 10 万；
 * - 矩阵注入时长：ci 10s、nightly 60s（500tps 口径对齐 R3-D）；
 * - M5 曲线：ci 单轮 20s（只判 M5a/M5b）、nightly 3 轮 30s（判 M5c）。
 */
export const TIER_PARAMS = {
  ci: {
    matrixLines: 30_000,
    matrixInjectMs: 10_000,
    rampDurationMs: 3_000,
    memoryRounds: 1,
    memoryInjectMs: 20_000,
    tableDurationMs: 15_000,
    label: 'headless 快档（中位数 + 长任务 + 0 容忍结构指标）',
  },
  nightly: {
    matrixLines: 100_000,
    matrixInjectMs: 60_000,
    rampDurationMs: 3_000,
    memoryRounds: 3,
    memoryInjectMs: 30_000,
    tableDurationMs: 20_000,
    label: 'GPU 全矩阵（全档阈值 + L2 trace + 3 轮泄漏门禁）',
  },
  local: {
    matrixLines: 30_000,
    matrixInjectMs: 10_000,
    rampDurationMs: 3_000,
    memoryRounds: 1,
    memoryInjectMs: 20_000,
    tableDurationMs: 15_000,
    label: '本机开发档（--quick 走 ci 子集，默认同 ci 规模）',
  },
};

/**
 * 预算查询辅助：取某指标某档位的阈值。
 * 返回 { value, reportOnly, tuned }；tier 分档字段缺失时取任意档同值。
 */
export function budgetFor(metricId, field, tier) {
  const entry = BUDGETS[metricId];
  if (!entry || entry[field] === undefined) return null;
  const spec = entry[field];
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    const value = spec[tier] !== undefined ? spec[tier] : spec.reportOnly !== undefined ? null : null;
    return {
      value,
      reportOnly: !!spec.reportOnly,
      tuned: entry.tuned !== false,
      rationale: entry.rationale,
      tierSpec: spec,
    };
  }
  return { value: spec, reportOnly: false, tuned: entry.tuned !== false, rationale: entry.rationale, tierSpec: null };
}

/**
 * 定档清单导出（README/报告展示用）：列出所有 tuned=false 的项——
 * 首跑定档诚实标注（A6 §5.2：无历史数据项先登记后收窄）。
 */
export function listUntuned() {
  const out = [];
  for (const [id, entry] of Object.entries(BUDGETS)) {
    if (entry.tuned === false) {
      out.push({ id, rationale: entry.rationale });
    }
  }
  return out;
}
