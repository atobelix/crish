// tests/perf/suite/scenarios/selection-direct.mjs
// 场景：直刷期间选区完整性（M3，0 容忍——A6 §2.3）。
//
// 口径：
// - 建立真实 DOM 选区（选中可见行内一段文本，参考模型 = 选中文本切片）；
// - 流式纯文本注入驱动直刷路径（dirty 行命令式写 textContent）；
// - 页面探针每帧比对 document.getSelection()：rangeCount / 锚点归属 /
//   所选文本 = 参考模型切片；任一不一致 = 一次「选区中断」事件；
// - directFlushChunkCount = 注入期间末行文本增长事件数（直刷 chunk 近似）；
// - 引擎登记点双通道：window.__CRISH_METRICS__.recordSelectionLost 存在则
//   读取差值（engineProbe='wired'），否则 pending 标注（metrics.ts 尚未
//   接线——A6 §4.1 落地期登记点，本套件先行以页面探针判定）。
// 判定：selectionLostCount = 0（任何丢失即 FAIL，0 容忍无放行协议）。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

import { budgetFor, TIER_PARAMS } from '../budgets.mjs';

function check(metric, name, actual, budgetEntry, opts = {}) {
  const { value, reportOnly, tuned } = budgetEntry || { value: null, reportOnly: false, tuned: true };
  const na = actual === null || actual === undefined || Number.isNaN(actual) || value === null;
  return {
    metric,
    name,
    actual: na ? null : Number(Number(actual).toFixed(4)),
    budget: value,
    pass: na ? null : actual <= value,
    reportOnly: !!reportOnly,
    tuned: tuned !== false,
    na,
    ...opts,
  };
}

export default {
  id: 'selection-direct',
  title: '直刷期间选区完整性（M3，0 容忍）',
  tiers: ['ci', 'nightly', 'local'],
  async run(ctx) {
    const { page, fns, tier } = ctx;
    const P = TIER_PARAMS[tier];
    const log = (msg) => ctx.log(`[selection-direct] ${msg}`);
    const checks = [];
    const notes = [];

    log('建立选区并注入直刷流（6s，500tps）...');
    const r = await page.evaluate(fns.pageSelectionProbe, {
      durationMs: 6000,
      tps: 500,
      selLine: 97,
      selLen: 12,
    });

    // 探针失效（选区未建立）时如实上报，不虚报 0 丢失
    if (r.error) {
      checks.push({
        metric: 'M3',
        name: '选区探针可用性',
        actual: 0,
        budget: 1,
        pass: false,
        reportOnly: false,
        tuned: true,
        na: false,
      });
      notes.push(`探针失效：${r.error}`);
    } else {
      const lost = r.selectionLostCount;
      checks.push(
        // ---- M3 主判定：选区中断数，0 容忍 ----
        check('M3', 'selectionLostCount（选区中断数，0 容忍）', lost, budgetFor('M3', 'selectionLostCount', tier), {
          pass: lost === 0,
        }),
        check('M3', 'lossRate（丢失率 = 中断数/直刷 chunk 数，报告项）', r.lossRate, budgetFor('M3', 'selectionLostCount', tier), { reportOnly: true })
      );
      if (r.engineProbe === 'wired') {
        checks.push(
          check('M3', 'engineSelectionLost（引擎登记点差值，双通道）', r.engineSelectionLost, budgetFor('M3', 'selectionLostCount', tier), {
            pass: r.engineSelectionLost === 0,
          })
        );
      } else {
        notes.push('引擎登记点 recordSelectionLost 未接线（pending）；本轮以页面探针口径判定');
      }
      notes.push(`参考选区文本「${String(r.refText || '').slice(0, 16)}…」，直刷 chunk 近似 ${r.directFlushChunkCount} 次，文本一致性=${r.textMatch}`);
    }

    log(`完成：selectionLost=${r.selectionLostCount} 直刷chunk=${r.directFlushChunkCount} engineProbe=${r.engineProbe}`);
    return { checks, notes, metrics: r };
  },
};
