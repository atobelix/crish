// tests/perf/suite/scenarios/scroll-smooth.mjs
// 场景：平滑滚动跳动检测（A6 §2.2 核心关切 + §2.1 M1 帧内分布）。
//
// 覆盖指标：
// - M2a 帧间位移突变（相对脱节口径：anchorDelta vs actualDelta，0 容忍；
//   绝对突变 / freeze 序列为报告项——review-P3 维度 4 修订落地）；
// - M2b 滚动条/内容一致性（20 位置采样：锚点行误差 P95 ≤1 行、
//   scrollHeight 误差 ≤1%；标准行高线性模型）；
// - M1a 帧内 JS P95（rAF 打点近似）；M1b layout+paint P95
//   （CDP 计数器窗口增量 ÷ 帧数，L1 口径；nightly 附加 L2 trace）；
// - M1c 长任务计数（0 warn / ≥2 fail）。
//
// 判定全部读 budgets.mjs（「改一处」原则）；null 采集项标记 na 不判 FAIL。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

import { RAMP_PX, budgetFor, TIER_PARAMS } from '../budgets.mjs';
import { summarize } from '../lib/stats.mjs';
import { cdpDelta, getCdpCounters, traceFramePhases } from '../lib/env.mjs';

/** 构建单个判定条目（na=true 表示未采集，不参与 PASS/FAIL） */
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

export default {
  id: 'scroll-smooth',
  title: '平滑滚动跳动检测（M2a 相对脱节 / M2b 滚动条一致性 / M1 帧内分布）',
  tiers: ['ci', 'nightly', 'local'],
  async run(ctx) {
    const { page, fns, cdp, tier } = ctx;
    const P = TIER_PARAMS[tier];
    const log = (msg) => ctx.log(`[scroll-smooth] ${msg}`);
    const checks = [];
    const notes = [];

    // 1) 加载标准行高纯文本文档（M2b 线性模型前提；实测首行高校准）
    log('加载标准行高纯文本文档...');
    const build = await page.evaluate(fns.pageBuildDoc, {
      lines: P.matrixLines,
      mixed: false,
      density: 'plain',
      timeoutMs: 120_000,
    });
    if (!build.ok) {
      return {
        metrics: { build },
        checks: [{ metric: 'SETUP', name: '文档加载', actual: build.loadedLines, budget: P.matrixLines, pass: false, reportOnly: false, tuned: true, na: false }],
        notes: [`文档加载失败：${build.loadedLines}/${P.matrixLines} 行（${build.ms}ms）`],
      };
    }
    notes.push(`文档加载 ${build.loadedLines} 行 ${build.ms.toFixed(0)}ms，实测行高 ${build.rowHeight}px`);

    // 预热归一（防抖第 5 条思想，与矩阵场景同款）：触底→回中，首次
    // 测量/物化/解析落在采样窗口外
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

    // 2) CDP 计数器基准（M1b L1：窗口增量 ÷ 帧数）
    const cdpBefore = cdp ? await getCdpCounters(cdp) : null;

    // 3) M2a 匀速 ramp 探针（3s；同时采 M1 rAF 帧率 + JS 段 + 长任务）
    log('平滑滚动 ramp 3s...');
    const ramp = await page.evaluate(fns.pageRampScroll, {
      durationMs: P.rampDurationMs,
      rampPx: RAMP_PX,
      relTolPx: budgetFor('M2a', 'relDetachTolPx', tier).value,
      jumpTolPx: budgetFor('M2a', 'maxJumpErrPx', tier).value,
      scrollStartRatio: 0.3,
    });
    const cdpAfter = cdp ? await getCdpCounters(cdp) : null;
    const delta = cdp ? cdpDelta(cdpBefore, cdpAfter) : null;
    const layoutPaintPerFrame =
      delta && ramp.frames.count > 0
        ? (delta.LayoutDuration + delta.RecalcStyleDuration + delta.PaintDuration) / ramp.frames.count
        : null;

    // 4) M2b 20 位置一致性采样
    log('滚动条一致性 20 位置采样...');
    const m2b = await page.evaluate(fns.pageM2bConsistency, {
      rowHeight: build.rowHeight,
      mixed: false,
    });

    // 5) M1b L2 trace（nightly/local 专属；失败内部 warn 降级返回 null）
    let l2 = null;
    if (tier !== 'ci' && cdp) {
      l2 = await traceFramePhases(page, cdp, P.rampDurationMs);
    }

    // 6) 统计汇总
    const jsSum = summarize(ramp.jsPhaseMs);
    const frameP95 = ramp.frames.p95;
    const frameP50 = ramp.frames.p50;
    const frameHardBudget = tier === 'ci' ? 33.3 : 16.6; // ci 降档 30fps 硬门槛（A6 §3.3）
    const ltCount = ramp.longTasks.count;

    // 7) 判定组装
    const m2aRel = budgetFor('M2a', 'relDetachTolPx', tier);
    const m2aJump = budgetFor('M2a', 'maxJumpErrPx', tier);
    checks.push(
      // ---- M2a：相对脱节 0 容忍（判定主指标）----
      check('M2a', 'relDetachCount（相对脱节帧数，0 容忍）', ramp.ramp.relDetachCount, m2aRel, {
        pass: ramp.ramp.relDetachCount === 0,
      }),
      // ---- M2a：绝对突变（报告项，不判 FAIL——headless 丢帧双峰必然触发）----
      check('M2a', 'maxJumpErrPx（最大绝对突变，报告项）', ramp.ramp.maxJumpErrPx, m2aJump, { reportOnly: true }),
      check('M2a', 'jumpCount（绝对突变帧数，报告项）', ramp.ramp.jumpCount, budgetFor('M2a', 'jumpCount', tier), { reportOnly: true }),
      check('M2a', 'freezeFrames（停顿帧数，报告项）', ramp.ramp.freezeFrames, budgetFor('M2a', 'freezeReportAt', tier), { reportOnly: true }),
      // ---- M1a：帧内 JS P95（rAF 打点近似）----
      check('M1a', 'jsP95Ms（帧内 JS 段 P95）', jsSum.p95Ms, budgetFor('M1a', 'jsP95Ms', tier)),
      // ---- M1b：layout+paint（L1 CDP 计数器；nightly 附加 L2 trace）----
      check('M1b', 'layoutPaintPerFrameMs（L1 CDP 窗口增量/帧）', layoutPaintPerFrame, budgetFor('M1b', 'layoutPaintP95Ms', tier)),
      check('M1b', 'layoutPaintP95Ms（L2 trace，nightly）', l2 ? l2.layoutPaintP95Ms : null, budgetFor('M1b', 'layoutPaintP95Ms', tier)),
      check('M1b', 'jsP95Ms（L2 trace，nightly）', l2 ? l2.jsP95Ms : null, budgetFor('M1a', 'jsP95Ms', tier)),
      // ---- M1c：长任务（0 warn / ≥2 fail）----
      check('M1c', 'longTaskCount（≥2 判 FAIL，0-1 warn）', ltCount, budgetFor('M1c', 'longTaskFailAt', tier), {
        pass: ltCount < 2,
      }),
      // ---- 帧率硬门槛（ci 30fps p95<33.3ms / nightly 60fps p95<16.6ms）----
      check('M1-fps', 'frameP95Ms（帧率硬门槛）', frameP95, { value: frameHardBudget, reportOnly: false, tuned: true }, { pass: frameP95 < frameHardBudget }),
      // ---- M2b：滚动条/内容一致性（标准行高线性模型）----
      check('M2b', 'anchorRowErrorP95（锚点行误差 P95 ≤1 行）', m2b.anchorRowErrorP95, budgetFor('M2b', 'anchorRowErrorP95Rows', tier)),
      check('M2b', 'scrollHeightErrorPct（滚动条总高误差 ≤1%）', m2b.scrollHeightErrorPct, budgetFor('M2b', 'scrollHeightErrorPct', tier)),
      check('M2b', 'scrollHeightSpreadPx（20 位置滚动条总高一致，报告项）', m2b.scrollHeightSpreadPx, { value: 1, reportOnly: true, tuned: true })
    );
    if (m2b.monotonic === false) {
      checks.push({ metric: 'M2b', name: '首行索引单调性', actual: false, budget: true, pass: false, reportOnly: false, tuned: true, na: false });
    }
    if (ramp.ramp.freezeFrames >= 2 && ramp.ramp.maxJumpErrPx > budgetFor('M2a', 'maxJumpErrPx', tier).value) {
      notes.push(`跳动证据链：${ramp.ramp.freezeFrames} 帧停顿 + 最大突进 ${ramp.ramp.maxJumpErrPx}px（相对脱节 ${ramp.ramp.relDetachCount} 帧）`);
    }

    log(`完成：relDetach=${ramp.ramp.relDetachCount} jsP95=${jsSum.p95Ms}ms layoutPaint/帧=${layoutPaintPerFrame === null ? 'n/a' : layoutPaintPerFrame.toFixed(2)}ms 长任务=${ltCount}`);
    return {
      checks,
      notes,
      metrics: {
        build,
        ramp: { ...ramp, jsPhaseMs: undefined, intervals: undefined },
        m2b,
        layoutPaintPerFrame,
        layoutPerSec: delta && delta.LayoutCount !== undefined ? delta.LayoutCount / (P.rampDurationMs / 1000) : null,
        l2,
        jsPhaseMs: jsSum,
        frameStats: { p50: frameP50, p95: frameP95, over16_7: ramp.frames.over16_7, over33_3: ramp.frames.over33_3, count: ramp.frames.count },
      },
    };
  },
};
