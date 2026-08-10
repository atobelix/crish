// tests/perf/suite/scenarios/stream-scenarios.mjs
// 场景矩阵（A6 §3.2）：2 行高 × 4 密度 × 2 滚动注入 = 16 组合。
// - 行高轴：std 标准 28px / mixed 混合（标题 40px + 正文 28px）；
// - 密度轴：plain 纯文本 / fence10 / fence30 / math5（fence/公式重放成本）；
// - 滚动注入轴：none 平滑滚动（M1 + M2a + M2b）/ inject 流式 500tps +
//   匀速滚动并发（M1 + M2c + chunk 成本 + 文本一致性）。
// ci 档只跑 CI_SUBSET 4 组合（A6 §3.2 指定的敏感维度各一档）；
// nightly/local 全 16 组合。
// 判定全部读 budgets.mjs；na（未采集）不判 FAIL。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

import { BUDGETS, CI_SUBSET, MATRIX_DENSITY, MATRIX_INJECT, MATRIX_ROWS, RAMP_PX, TIER_PARAMS, budgetFor } from '../budgets.mjs';
import { summarize } from '../lib/stats.mjs';
import { cdpDelta, getCdpCounters } from '../lib/env.mjs';

/** 构建判定条目（na=未采集不判 FAIL；pass 可被调用方覆盖） */
function check(metric, name, actual, budgetEntry, opts = {}) {
  const { value, reportOnly, tuned } = budgetEntry || { value: null, reportOnly: false, tuned: true };
  const na = actual === null || actual === undefined || Number.isNaN(actual) || value === null;
  return {
    metric,
    name,
    actual: na ? null : Number(Number(actual).toFixed(2)),
    budget: value,
    pass: na ? null : actual <= value,
    reportOnly: !!reportOnly,
    tuned: tuned !== false,
    na,
    ...opts,
  };
}

/** 矩阵组合场景工厂（笛卡尔积 2×4×2 = 16 组合） */
function createMatrixScenario(row, density, inject) {
  const id = `matrix-${row.id}-${density.id}-${inject.id}`;
  const scenarioName = `${row.label} × ${density.label} × ${inject.label}`;
  return {
    id,
    title: `矩阵：${scenarioName}`,
    tiers: ['ci', 'nightly', 'local'],
    async run(ctx) {
      const { page, fns, cdp, tier } = ctx;
      const P = TIER_PARAMS[tier];
      const log = (msg) => ctx.log(`[${id}] ${msg}`);
      const checks = [];
      const notes = [];

      // 1) 文档构造（行高轴 + 密度轴）
      log('构造文档...');
      const build = await page.evaluate(fns.pageBuildDoc, {
        lines: P.matrixLines,
        mixed: row.mixed ? 1 : 0,
        density: density.id,
        timeoutMs: 180_000,
      });
      if (!build.ok) {
        return {
          metrics: { build },
          checks: [{ metric: 'SETUP', name: '文档加载', actual: build.loadedLines, budget: P.matrixLines, pass: false, reportOnly: false, tuned: true, na: false }],
          notes: [`文档加载失败：${build.loadedLines}/${P.matrixLines} 行（${build.ms}ms）`],
        };
      }

      // 预热归一（防抖第 5 条思想）：加载后先触底再回中——首次滚动触发
      // 的全量测量/物化/解析（fence 重放等）落在采样窗口外，防止首帧
      // 长任务污染帧率与 M1c 判定（R6 flushStreamTail 归一教训同源）。
      log('预热（触底→回中）...');
      await page.evaluate(() => {
        const sc = document.querySelector('.editor-scroll-container');
        if (sc) sc.scrollTop = sc.scrollHeight;
        return new Promise((r) => {
          let n = 0;
          const t = () => { n++; if (n < 3) requestAnimationFrame(t); else r(); };
          requestAnimationFrame(t);
        });
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const sc = document.querySelector('.editor-scroll-container');
        if (sc) sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.3);
        return new Promise((r) => {
          let n = 0;
          const t = () => { n++; if (n < 3) requestAnimationFrame(t); else r(); };
          requestAnimationFrame(t);
        });
      });
      await page.waitForTimeout(300);

      // 2) CDP 计数器基准（M1b L1）
      const cdpBefore = cdp ? await getCdpCounters(cdp) : null;

      // 3) 无注入组合：平滑滚动 ramp（M1 + M2a）；注入组合：流式 + 滚动并发（M1 + M2c）
      let r;
      if (!inject.inject) {
        r = await page.evaluate(fns.pageRampScroll, {
          durationMs: P.rampDurationMs,
          rampPx: RAMP_PX,
          relTolPx: budgetFor('M2a', 'relDetachTolPx', tier).value,
          jumpTolPx: budgetFor('M2a', 'maxJumpErrPx', tier).value,
          scrollStartRatio: 0.3,
        });
      } else {
        log(`流式注入 ${(P.matrixInjectMs / 1000).toFixed(0)}s + 匀速滚动并发...`);
        r = await page.evaluate(fns.pageStream, {
          scenario: density.scenario,
          initText: '',
          durationMs: P.matrixInjectMs,
          tps: 500,
          rampPx: RAMP_PX,
          relTolPx: budgetFor('M2c', 'relDetachTolPx', tier).value,
          jumpTolPx: budgetFor('M2c', 'maxJumpErrPx', tier).value,
        });
      }
      const cdpAfter = cdp ? await getCdpCounters(cdp) : null;
      const delta = cdp ? cdpDelta(cdpBefore, cdpAfter) : null;
      const layoutPaintPerFrame =
        delta && r.frames.count > 0
          ? (delta.LayoutDuration + delta.RecalcStyleDuration + delta.PaintDuration) / r.frames.count
          : null;

      // 4) M2b 滚动条/内容一致性（std 判误差，mixed 判单调性 + 误差 na）
      let m2b = null;
      if (!inject.inject) {
        m2b = await page.evaluate(fns.pageM2bConsistency, {
          rowHeight: build.rowHeight,
          mixed: row.mixed ? 1 : 0,
        });
      }

      // 5) 统计与判定
      const jsSum = summarize(r.jsPhaseMs);
      const frameP95 = r.frames.p95;
      const frameHardBudget = tier === 'ci' ? 33.3 : 16.6; // ci 降档 30fps 硬门槛
      const ltCount = r.longTasks.count;
      const detach = r.ramp ? r.ramp.relDetachCount : null;
      const detachMax = r.ramp ? r.ramp.maxRelErrPx : null;

      checks.push(
        // ---- M1 帧内分布 + 帧率硬门槛（全部组合）----
        check('M1a', 'jsP95Ms（帧内 JS 段 P95）', jsSum.p95Ms, budgetFor('M1a', 'jsP95Ms', tier)),
        check('M1b', 'layoutPaintPerFrameMs（L1 CDP）', layoutPaintPerFrame, budgetFor('M1b', 'layoutPaintP95Ms', tier)),
        check('M1-fps', 'frameP95Ms（帧率硬门槛）', frameP95, { value: frameHardBudget, reportOnly: false, tuned: true }, { pass: frameP95 < frameHardBudget }),
        check('M1c', 'longTaskCount（≥2 判 FAIL）', ltCount, budgetFor('M1c', 'longTaskFailAt', tier), { pass: ltCount < 2 })
      );
      if (inject.inject) {
        // ---- 注入组合：M2c 直刷期间滚动（0 容忍）+ chunk + 文本一致 + 堆报告项 ----
        checks.push(
          check('M2c', 'relDetachCount（流式+滚动并发相对脱节，0 容忍）', detach, budgetFor('M2c', 'relDetachTolPx', tier), {
            pass: detach === 0,
          }),
          check('M2c', 'maxRelErrPx（最大脱节，报告项）', detachMax, budgetFor('M2c', 'relDetachTolPx', tier), { reportOnly: true }),
          check('M2c', 'jumpCount（绝对突变帧数，报告项）', r.ramp.jumpCount, budgetFor('M2c', 'jumpCount', tier), { reportOnly: true }),
          check('M2c', 'freezeFrames（停顿帧数，报告项）', r.ramp.freezeFrames, budgetFor('M2a', 'freezeReportAt', tier), { reportOnly: true }),
          check('M1-stream', 'chunkP95Ms（chunk 成本 ≤1ms）', r.chunkMs.p95, { value: 1, reportOnly: false, tuned: true }),
          check('M1-stream', 'textMatch（文本模型一致）', r.textMatch ? 1 : 0, { value: 1, reportOnly: false, tuned: true }, { pass: r.textMatch }),
          check('M5-报告', 'heapGrowthMB（60s 注入堆增长，报告项）', r.heap.endMB !== null && r.heap.startMB !== null ? r.heap.endMB - r.heap.startMB : null, { value: 60, reportOnly: true, tuned: true })
        );
        if (!r.consistency) {
          checks.push({ metric: 'M1-stream', name: 'verifyConsistency', actual: 0, budget: 1, pass: false, reportOnly: false, tuned: true, na: false });
        }
      } else {
        // ---- 无注入组合：M2a 相对脱节（全密度/行高覆盖跳动敏感性）----
        checks.push(
          check('M2a', 'relDetachCount（平滑滚动相对脱节，0 容忍）', detach, budgetFor('M2a', 'relDetachTolPx', tier), {
            pass: detach === 0,
          }),
          check('M2a', 'maxRelErrPx（最大脱节，报告项）', detachMax, budgetFor('M2a', 'relDetachTolPx', tier), { reportOnly: true }),
          check('M2a', 'maxJumpErrPx（最大绝对突变，报告项）', r.ramp.maxJumpErrPx, budgetFor('M2a', 'maxJumpErrPx', tier), { reportOnly: true }),
          check('M2a', 'jumpCount（绝对突变帧数，报告项）', r.ramp.jumpCount, budgetFor('M2a', 'jumpCount', tier), { reportOnly: true }),
          check('M2a', 'freezeFrames（停顿帧数，报告项）', r.ramp.freezeFrames, budgetFor('M2a', 'freezeReportAt', tier), { reportOnly: true })
        );
        // ---- M2b：std 判锚点误差（线性模型）；mixed 判单调性（误差 na）----
        if (m2b) {
          if (!row.mixed) {
            checks.push(
              check('M2b', 'anchorRowErrorP95（锚点行误差 ≤1 行）', m2b.anchorRowErrorP95, budgetFor('M2b', 'anchorRowErrorP95Rows', tier)),
              check('M2b', 'scrollHeightErrorPct（滚动条总高误差 ≤1%）', m2b.scrollHeightErrorPct, budgetFor('M2b', 'scrollHeightErrorPct', tier))
            );
          } else {
            notes.push(`混合行高：线性模型不适用，锚点误差标记 na；判首行索引单调性（单调=${m2b.monotonic}）`);
            checks.push(check('M2b', 'anchorRowErrorP95（混合行高 na）', null, budgetFor('M2b', 'anchorRowErrorP95Rows', tier)));
          }
          if (m2b.monotonic === false) {
            checks.push({ metric: 'M2b', name: '首行索引单调性', actual: 0, budget: 1, pass: false, reportOnly: false, tuned: true, na: false });
          }
        }
      }

      log(`完成：detach=${detach === null ? 'n/a' : detach} jsP95=${jsSum.p95Ms}ms fpsP95=${frameP95}ms 长任务=${ltCount}${inject.inject ? ` chunkP95=${r.chunkMs.p95}ms 文本一致=${r.textMatch}` : ''}`);
      if (tier === 'ci' && !inject.inject && frameP95 >= 33.3 && density.id !== 'plain') {
        notes.push('ci 档 headless 软渲染下 fence/公式重放首轮成本（R6 已记载软件渲染惩罚）；nightly GPU 档为达标判定位，本组合 ci 判定语义 = 回归趋势基线（对比首跑快照，不绝对达标）');
      }
      return {
        checks,
        notes,
        metrics: {
          id,
          build,
          detach,
          jsP95Ms: jsSum.p95Ms,
          frameP95,
          layoutPaintPerFrame,
          layoutPerSec: delta && delta.LayoutCount !== undefined ? delta.LayoutCount / ((inject.inject ? P.matrixInjectMs : P.rampDurationMs) / 1000) : null,
          longTasks: r.longTasks,
          inject: inject.inject
            ? {
                injectedTokens: r.injectedTokens,
                chunkP95Ms: r.chunkMs.p95,
                textMatch: r.textMatch,
                consistency: r.consistency,
                heap: r.heap,
                ramp: r.ramp,
              }
            : null,
          m2b,
        },
      };
    },
  };
}

/** 矩阵场景全表（16 组合；runner 按 tier 与 CI_SUBSET 过滤执行） */
export const matrixScenarios = (() => {
  const out = [];
  for (const row of MATRIX_ROWS) {
    for (const density of MATRIX_DENSITY) {
      for (const inject of MATRIX_INJECT) {
        out.push(createMatrixScenario(row, density, inject));
      }
    }
  }
  return out;
})();

/** ci 档矩阵子集（A6 §3.2 指定 4 组合；返回完整场景 id） */
export function ciMatrixIds() {
  return CI_SUBSET.map((id) => `matrix-${id}`);
}

/** 全部矩阵组合 id（nightly/local 全跑） */
export function allMatrixIds() {
  return matrixScenarios.map((s) => s.id);
}
