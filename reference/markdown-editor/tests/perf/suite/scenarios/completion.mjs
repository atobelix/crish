// tests/perf/suite/scenarios/completion.mjs
// 场景：补全闪烁检测（M4，0 容忍——A6 §2.4，N1 软渲染视觉稳定化验收面）。
//
// 口径：
// - 流式收口（= streamEnd 语义，flushStreamTail）前一帧快照窗口内每行
//   [data-index] → element 节点身份；
// - 收口后两帧再快照；remountedCount = 存量行中 oldEl !== newEl 数
//   （理想 0——同一节点仅样式/类切换，零 DOM 重建）；
// - MutationObserver 统计收口窗口 addedNodes 总数，与「流式新增行数」
//   比对（允许新行挂载，禁止存量行重建；slack=2 吸收 observer 合并噪声）。
// 判定：remountedCount = 0；addedNodes ≤ 新增行数 + slack（0 容忍语义）。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

import { budgetFor } from '../budgets.mjs';

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
  id: 'completion',
  title: '补全闪烁（M4，完成态切换存量行节点身份，0 容忍）',
  tiers: ['ci', 'nightly', 'local'],
  async run(ctx) {
    const { page, fns } = ctx;
    const log = (msg) => ctx.log(`[completion] ${msg}`);
    const checks = [];
    const notes = [];

    log('流式注入 4s 后收口，比对完成帧节点身份...');
    const r = await page.evaluate(fns.pageCompletionProbe, {
      injectMs: 4000,
      tps: 500,
      initLines: 2000,
    });

    if (r.error) {
      checks.push({
        metric: 'M4',
        name: '补全探针可用性',
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

    const slack = budgetFor('M4', 'addedNodesSlack', ctx.tier).value;
    checks.push(
      // ---- M4 主判定：存量行重建数，0 容忍 ----
      check('M4', 'remountedCount（存量行节点身份变化数，0 容忍）', r.remountedCount, budgetFor('M4', 'remountedRows', ctx.tier), {
        pass: r.remountedCount === 0,
      }),
      // ---- 完成帧新增节点：允许流式新行，禁止存量行重建 ----
      check('M4', 'addedNodesVsRows（完成帧新增节点 - 实际新增行数）', r.addedNodesTotal - r.addedRows, { value: slack, reportOnly: false, tuned: true }, {
        pass: r.addedNodesTotal <= r.addedRows + slack,
      })
    );
    if (r.remountedCount > 0) {
      notes.push(`重建行索引（前 10）：${r.remountedIndexes.join(', ')}`);
    }
    notes.push(`收口窗口新增节点 ${r.addedNodesTotal}（流式新行 ${r.addedRows}），文本一致性=${r.textMatch}`);

    log(`完成：remounted=${r.remountedCount} addedNodes=${r.addedNodesTotal} addedRows=${r.addedRows}`);
    return { checks, notes, metrics: r };
  },
};
