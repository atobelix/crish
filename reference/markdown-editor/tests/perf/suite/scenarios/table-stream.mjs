// tests/perf/suite/scenarios/table-stream.mjs
// 场景：表格流式列宽定型（M6——A6 §2.6；首跑采集定档）。
//
// 口径：
// - 计数来源 = 引擎登记点（W3-3 接线：window.__CRISH_TABLE_SETTLE__，
//   MarkdownEngine 三处 setTableWidths 调用点 recordTableWidthSettle）；
//   旧构建（无钩子）回退页面内包装 window.__CRISH_TABLE_STORE__ 的
//   setColumnWidth / setTableWidths（zustand setState 替换 action，原
//   闭包行为不变——纯页面侧计数兜底）；
// - perTableSettles = 每表调用次数 - 1（首次定型 = 首挂载，之后每次修正
//   计一次「定型修正」）；
// - 表格 DOM 宽度变化次数（MutationObserver attribute style）；
// - 注入期间每 2s 滚动到文档中部（首个表格块保持在视口附近）；
// - M6b 表格 reflow：LayoutCount/秒 由 runner 在场景前后 CDP 计数器差
//   得出，与同档 plain 无表格基线比对（ratio ≤ 基线×2；基线缺失或首跑
//   时按设计值登记——tuned=false 诚实标注「首采定档」）。
// 判定：M6a perTableSettles ≤ 2（设计推定值，首跑后按实测回写 budgets 附
// 理由）；M6b layoutRatio ≤ 2（同前）。tuned=false 项失败仅告警不判 FAIL。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

import { budgetFor, TIER_PARAMS } from '../budgets.mjs';
import { cdpDelta, getCdpCounters } from '../lib/env.mjs';

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
  id: 'table-stream',
  title: '表格流式列宽定型（M6a/M6b，首采定档）',
  tiers: ['nightly', 'local'],
  async run(ctx) {
    const { page, fns, cdp, tier } = ctx;
    const P = TIER_PARAMS[tier];
    const log = (msg) => ctx.log(`[table-stream] ${msg}`);
    const checks = [];
    const notes = [];

    // 1) CDP 计数器基准（M6b LayoutCount 窗口增量）
    const cdpBefore = cdp ? await getCdpCounters(cdp) : null;

    // 2) 表格流式注入（M6a 包装计数 + widthChanges）
    log(`表格流式注入 ${(P.tableDurationMs / 1000).toFixed(0)}s（500tps，表格行流）...`);
    const r = await page.evaluate(fns.pageTableStream, {
      durationMs: P.tableDurationMs,
      tps: 500,
      initLines: 200,
    });
    const cdpAfter = cdp ? await getCdpCounters(cdp) : null;
    const delta = cdp ? cdpDelta(cdpBefore, cdpAfter) : null;

    if (r.error) {
      checks.push({
        metric: 'M6a',
        name: '表格探针可用性',
        actual: 0,
        budget: 1,
        pass: false,
        reportOnly: false,
        tuned: true,
        na: false,
      });
      notes.push(`探针失效：${r.error}`);
      return { checks, notes, metrics: r };
    }

    // 3) M6b：LayoutCount/秒（CDP 窗口增量）；基线对照由 runner 汇总
    //    plain 无表格场景（scroll-smooth）的 layoutPerSec 得出，首跑无基线
    //    时登记设计值（ratio 按 2 计，tuned=false 仅告警）。
    const elapsedSec = delta && delta.TaskDuration !== undefined ? cdpAfter.TaskDuration - (cdpBefore?.TaskDuration || 0) : null;
    const layoutPerSec = delta && elapsedSec > 0 ? delta.LayoutCount / elapsedSec : null;

    if (r.tableCount === 0) {
      // 无表格锁宽登记（流式注入未产出结构定型的表格段，或引擎登记点/
      // 包装计数均未触发）——按「未采集」登记 na 不判 FAIL（诚实标注，
      // 复跑定位是注入形态问题还是引擎登记缺失）。
      checks.push(
        {
          metric: 'M6a',
          name: 'maxTableSettles（引擎定型登记未接线）',
          actual: null,
          budget: null,
          pass: null,
          reportOnly: false,
          tuned: false,
          na: true,
        },
        {
          metric: 'M6a',
          name: 'tableCount（流式表格块数，报告项）',
          actual: 0,
          budget: 1,
          pass: null,
          reportOnly: true,
          tuned: true,
          na: true,
        },
        check('M6b', 'layoutCountPerSec（流式表格 LayoutCount/秒）', layoutPerSec, { value: 1, reportOnly: true, tuned: false })
      );
      notes.push('未采集到表格列宽定型登记（计数来源：引擎登记点 __CRISH_TABLE_SETTLE__ / 旧构建包装兜底）——表格行可能未被解析为表格段，或锁宽登记未触发；na 不判 FAIL');
    } else {
      checks.push(
        // ---- M6a：单表定型修正 ≤ 2（首采定档：tuned=false 失败仅告警）----
        check('M6a', 'maxTableSettles（单表定型修正上限）', r.maxTableSettles, budgetFor('M6a', 'perTableSettles', tier)),
        check('M6a', 'tableCount（流式表格块数，报告项）', r.tableCount, { value: 1, reportOnly: true, tuned: true }),
        check('M6a', 'widthChanges（表格 DOM 宽度变化 >1px 次数，报告项）', r.widthChanges, { value: 1, reportOnly: true, tuned: true }),
        // ---- M6b：表格 reflow（LayoutCount/秒；基线 ratio 判定由 runner 汇总）----
        check('M6b', 'layoutCountPerSec（流式表格 LayoutCount/秒）', layoutPerSec, { value: 1, reportOnly: true, tuned: false })
      );
      if (!r.textMatch) {
        checks.push({ metric: 'M6a', name: 'verifyConsistency', actual: 0, budget: 1, pass: false, reportOnly: false, tuned: true, na: false });
      }
      notes.push(`表格块 ${r.tableCount} 个，单表修正上限 ${r.maxTableSettles} 次，表格 DOM 宽度变化 ${r.widthChanges} 次`);
    }

    log(`完成：tableCount=${r.tableCount} maxSettles=${r.maxTableSettles} widthChanges=${r.widthChanges}`);
    return {
      checks,
      notes,
      metrics: { ...r, layoutPerSec, perTableSettlesRaw: r.perTableSettles },
      extra: { layoutPerSec },
    };
  },
};
