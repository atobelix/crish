// tests/perf/suite/runner.mjs
// 基准套件调度器（A6 §3：矩阵调度 + 档位判定 + 报告聚合 + 退出码）。
//
// 用法：
//   node tests/perf/suite/runner.mjs                    默认 PERF_TIER=ci
//   PERF_TIER=nightly node tests/perf/suite/runner.mjs  nightly 全矩阵
//   node tests/perf/suite/runner.mjs --tier local       本机档
//   node tests/perf/suite/runner.mjs --scenario scroll-smooth
//                                                      单场景复跑
//   node tests/perf/suite/runner.mjs --dry-run          校验注册表/预算/计划（不启动浏览器）
//   node tests/perf/suite/runner.mjs --node-only        数据层降级（store 纯函数，浏览器专属项未采集）
//
// 档位（A6 §3.3，命名继承 VITEST_PERF_TIER）：
// - ci：headless；矩阵 ci 子集 4 组合 + scroll-smooth + 选区/补全专项；
//   判定 = 中位数 + 长任务计数 + 0 容忍结构指标；帧率降档 ≥30fps 硬门槛；
// - nightly：GPU 有头；全矩阵 16 + 内存 3 轮 + 表格流式 + L2 trace；全档阈值；
// - local：同 nightly 可裁剪（--scenario 过滤 / --quick 走 ci 子集）。
//
// 防抖（A6 §3.4）：环境指纹（UA/核数/内存/CDP SystemInfo GPU 判定）写入报告
// 头部；3σ 离群剔除（lib/stats.sigmaReject）；场景间强制 GC + 5s 冷却；
// 渲染后端敏感指标（M1b）按 tier 分档阈值。
//
// 退出码：0 = 全部通过（含 tuned=false 告警）；1 = 存在 FAIL/ERROR。
// 产物：reports/suite-report-<date>.json（阈值命中明细，报告即失败归属证据）。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { BUDGETS, CI_SUBSET, TIER_PARAMS, budgetFor, listUntuned, RAMP_PX } from './budgets.mjs';
import {
  ensureServer,
  createCdpSessions,
  collectEnvironment,
  gcCool,
  launchBrowser,
  resolveBaseUrl,
  resolveTier,
} from './lib/env.mjs';
import { instantiatePageFuncs } from './lib/pagesrc.mjs';
import scrollSmooth from './scenarios/scroll-smooth.mjs';
import { matrixScenarios, ciMatrixIds } from './scenarios/stream-scenarios.mjs';
import selectionDirect from './scenarios/selection-direct.mjs';
import completion from './scenarios/completion.mjs';
import memoryCycle from './scenarios/memory-cycle.mjs';
import tableStream from './scenarios/table-stream.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'reports');

/** 场景注册表（全档位；档位过滤在 buildScenarioList） */
const ALL_SCENARIOS = [scrollSmooth, ...matrixScenarios, selectionDirect, completion, memoryCycle, tableStream];

/**
 * 按档位构建执行清单：
 * - ci：scroll-smooth + 矩阵 ci 子集 4 + 选区/补全专项（内存/表格为 nightly）；
 * - nightly/local：全矩阵 16 + 内存循环 + 表格流式（M5c/M6 专属）。
 */
function buildScenarioList(tier) {
  const list = [scrollSmooth];
  const ciMatrix = new Set(ciMatrixIds());
  for (const sc of matrixScenarios) {
    if (tier === 'ci' ? ciMatrix.has(sc.id) : true) list.push(sc);
  }
  list.push(selectionDirect, completion);
  if (tier !== 'ci') list.push(memoryCycle, tableStream);
  return list;
}

/** 预算完整性校验（dry-run / 启动前置）：M1-M6 关键字段必须存在 */
function validateBudgets() {
  const required = {
    M1a: ['jsP95Ms'],
    M1b: ['layoutPaintP95Ms'],
    M1c: ['longTaskFailAt', 'longTaskWarnAt'],
    M2a: ['relDetachTolPx', 'maxJumpErrPx', 'jumpCount'],
    M2b: ['anchorRowErrorP95Rows', 'scrollHeightErrorPct'],
    M2c: ['relDetachTolPx', 'jumpCount'],
    M3: ['selectionLostCount'],
    M4: ['remountedRows', 'addedNodesSlack'],
    M5a: ['heapGrowthMB'],
    M5b: ['heapPeakMB'],
    M5c: ['steadyGrowthPct'],
    M6a: ['perTableSettles'],
    M6b: ['layoutCountRatio'],
  };
  const missing = [];
  for (const [id, fields] of Object.entries(required)) {
    if (!BUDGETS[id]) {
      missing.push(`${id}（整项缺失）`);
      continue;
    }
    for (const f of fields) {
      if (BUDGETS[id][f] === undefined) missing.push(`${id}.${f}`);
    }
  }
  return missing;
}

/** M6b 基线对照：取 plain 无表格场景的 LayoutCount/秒（首个非空）作基线 */
function resolveTableBaseline(results) {
  for (const r of results) {
    if (r.id === 'scroll-smooth' || r.id === 'matrix-std-plain-none') {
      const v = r.metrics?.layoutPerSec;
      if (v !== null && v !== undefined && isFinite(v) && v > 0) return v;
    }
  }
  return null;
}

/** M6b ratio 判定（runner 汇总层；tuned=false → 仅告警） */
function buildTableRatioCheck(results) {
  const table = results.find((r) => r.id === 'table-stream');
  if (!table || !table.ok) return null;
  const baseline = resolveTableBaseline(results);
  const ratioBudget = budgetFor('M6b', 'layoutCountRatio', table.tier);
  const tablePerSec = table.metrics?.layoutPerSec ?? table.extra?.layoutPerSec;
  if (tablePerSec === null || tablePerSec === undefined || !isFinite(tablePerSec)) {
    return { id: 'M6b', name: 'layoutRatio（表格 LayoutCount/秒）', actual: null, budget: ratioBudget.value, pass: null, reportOnly: false, tuned: false, na: true, note: 'CDP LayoutCount 不可用' };
  }
  if (baseline === null) {
    return {
      id: 'M6b',
      name: 'layoutRatio（表格/基线 LayoutCount/秒）',
      actual: null,
      budget: ratioBudget.value,
      pass: null,
      reportOnly: false,
      tuned: false,
      na: true,
      note: `首跑无 plain 基线（表格 ${tablePerSec.toFixed(1)}/s）——定档后回写 budgets（A6 §5.2 定档协议）`,
    };
  }
  const ratio = tablePerSec / baseline;
  return {
    id: 'M6b',
    name: 'layoutRatio（表格/基线 LayoutCount/秒）',
    actual: Number(ratio.toFixed(2)),
    budget: ratioBudget.value,
    pass: ratio <= ratioBudget.value,
    reportOnly: false,
    tuned: false, // 首采定档：越界仅告警
    na: false,
    note: `表格 ${tablePerSec.toFixed(1)}/s vs 基线 ${baseline.toFixed(1)}/s`,
  };
}

/** dry-run：校验预算完整性 + 场景注册 + 打印执行计划（验收入口，不启动浏览器） */
async function runDryRun(tier) {
  const missing = validateBudgets();
  const plan = buildScenarioList(tier);
  console.log('========== 基准套件 dry-run（不启动浏览器） ==========');
  console.log(`档位: ${tier}（${TIER_PARAMS[tier].label}）`);
  console.log(`预算完整性（M1-M6）: ${missing.length === 0 ? 'OK' : '缺失 → ' + missing.join(', ')}`);
  console.log(`未定档项（首采定档，A6 §5.2）: ${listUntuned().map((u) => u.id).join(', ') || '无'}`);
  console.log('执行计划:');
  for (const sc of plan) console.log(`  - ${sc.id.padEnd(32)} ${sc.title}`);
  console.log(`合计 ${plan.length} 个场景；0 容忍硬门槛: ${['M2a', 'M2b', 'M2c', 'M3', 'M4'].join('/')}（无放行协议）`);
  console.log('====================================================');
  if (missing.length > 0) process.exit(1);
  process.exit(0);
}

/** node 降级模式：store 层纯函数基准（浏览器专属项标记未采集，A6 §5.1） */
async function runNodeMode() {
  const { createServer } = await import('vite');
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  try {
    const { useEditorStore } = await server.ssrLoadModule('/src/core/EditorStore.ts');
    const get = () => useEditorStore.getState();
    const genText = (n) => {
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = 'L' + i + '_'.repeat(20) + i;
      return arr.join('\n');
    };
    const loadDoc = async (n, timeoutMs) => {
      const t0 = performance.now();
      get().setText(genText(n));
      while (get().lines.length < n) {
        if (performance.now() - t0 > timeoutMs) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      return { ms: performance.now() - t0, loaded: get().lines.length };
    };
    await loadDoc(50_000, 120_000);
    const median = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const appendSamples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      get().appendText('W');
      appendSamples.push(performance.now() - t0);
    }
    const off = get().lineOffsets.getOffset(25_000) + 5;
    get().setCursorPos(off);
    const storeSamples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      get().insertText('中');
      storeSamples.push(performance.now() - t0);
      get().setCursorPos(off);
    }
    return {
      environment: {
        platform: os.platform(),
        nodeVersion: process.version,
        cpus: os.cpus().length,
        arch: os.arch(),
        mode: 'node-only',
      },
      metrics: {
        load50kMs: Number((await loadDoc(50_000, 120_000)).ms.toFixed(1)),
        appendMedianMs: Number(median(appendSamples).toFixed(3)),
        insertAt25000MedianMs: Number(median(storeSamples).toFixed(3)),
      },
      notes: ['node 降级模式：仅 store 层纯函数基准；浏览器专属项（M1-M6 帧/跳动/选区/内存）未采集'],
    };
  } finally {
    await server.close();
  }
}

/** 浏览器模式主流程 */
async function runBrowserMode(tier, baseUrl, onlyScenario) {
  const { serverOk, devChild } = await ensureServer(baseUrl);
  if (!serverOk) {
    throw new Error(`dev server 不可用（${baseUrl} 未监听且无法自动拉起），请先运行 npm run dev`);
  }
  const browser = await launchBrowser(tier);
  const fns = instantiatePageFuncs();
  const results = [];
  let environment = null;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log(`[suite][pageerror] ${err.message}`));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__CRISH_SESSION_STORE__ !== 'undefined', null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__CRISH_METRICS__.getLineCount() > 0, null, { timeout: 60_000 });
    await page.waitForTimeout(1500);

    const { pageCdp, browserCdp } = await createCdpSessions(browser, page);
    const cdp = pageCdp; // 页面级 session：Performance 计数器 / 强制 GC / trace
    environment = await collectEnvironment(page, baseUrl, pageCdp, browserCdp);
    console.log(
      `[suite] 环境：${environment.ua.slice(0, 60)}... | GPU=${environment.gpu ? (environment.gpu.available ? '有头 GPU' : 'SwiftShader 软件渲染') : 'n/a'}`
    );

    const plan = buildScenarioList(tier).filter((s) => !onlyScenario || s.id === onlyScenario);
    if (plan.length === 0) {
      throw new Error(`场景过滤后为空：--scenario=${onlyScenario}`);
    }
    console.log(`[suite] 执行计划（${tier} 档）：${plan.map((s) => s.id).join(' → ')}`);

    for (const sc of plan) {
      await gcCool(cdp, `场景 ${sc.id}`);
      console.log(`\n[suite] === 场景 ${sc.id} ===`);
      const t0 = Date.now();
      const entry = { id: sc.id, title: sc.title, tier, elapsedMs: 0, status: 'RUN', checks: [], notes: [], ok: false };
      try {
        const res = await sc.run({
          tier,
          params: TIER_PARAMS[tier],
          fns,
          page,
          cdp,
          log: (msg) => console.log(msg),
        });
        entry.checks = res.checks || [];
        entry.notes = res.notes || [];
        entry.metrics = res.metrics || {};
        entry.extra = res.extra || null;
        entry.ok = true;
        const fails = entry.checks.filter((c) => c.pass === false && !c.reportOnly && !c.na);
        const untunedFails = fails.filter((c) => c.tuned === false);
        const hardFails = fails.filter((c) => c.tuned !== false);
        entry.status = hardFails.length ? 'FAIL' : untunedFails.length ? 'WARN' : 'PASS';
        entry.summary = {
          hardFails: hardFails.map((c) => c.name),
          untunedFails: untunedFails.map((c) => c.name),
        };
        for (const f of hardFails) console.log(`  [FAIL] ${f.metric} ${f.name}（实际 ${f.actual}，预算 ${f.budget}）`);
        for (const f of untunedFails) console.log(`  [WARN][首采定档] ${f.metric} ${f.name}（实际 ${f.actual}，设计值 ${f.budget}）`);
        console.log(`  => ${entry.status}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      } catch (err) {
        entry.status = 'ERROR';
        entry.error = `${err.message}`;
        console.log(`  => ERROR：${err.message}`);
      }
      entry.elapsedMs = Date.now() - t0;
      results.push(entry);
    }

    // M6b 基线对照（runner 汇总层）
    const tableEntry = results.find((r) => r.id === 'table-stream' && r.ok);
    if (tableEntry) {
      const ratioCheck = buildTableRatioCheck(results);
      if (ratioCheck && !ratioCheck.na) {
        tableEntry.checks.push(ratioCheck);
        if (ratioCheck.pass === false) {
          tableEntry.status = tableEntry.status === 'FAIL' ? 'FAIL' : 'WARN';
          console.log(`  [WARN][首采定档] ${ratioCheck.name}（${ratioCheck.note}）`);
        }
      }
    }
    return { results, environment };
  } finally {
    await browser.close();
    if (devChild) devChild.kill();
  }
}

/** 汇总判定（退出码依据：FAIL/ERROR > 0 → 1） */
function summarize(results, tier, mode, environment) {
  const statusCount = { PASS: 0, WARN: 0, FAIL: 0, ERROR: 0 };
  for (const r of results) statusCount[r.status] = (statusCount[r.status] || 0) + 1;
  const exitCode = statusCount.FAIL + statusCount.ERROR > 0 ? 1 : 0;
  return {
    schema: 'conex-perf-suite/v1',
    collectedAt: new Date().toISOString(),
    tier,
    mode,
    params: TIER_PARAMS[tier],
    commandLine: process.argv.slice(2),
    environment,
    untuned: listUntuned(),
    scenarios: results,
    summary: { ...statusCount, total: results.length, exitCode },
  };
}

/** 报告落盘（reports/suite-report-<date>.json）+ 控制台汇总 */
function writeReport(report) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/:/g, '-');
  const file = path.join(OUT_DIR, `suite-report-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return file;
}

/** 主流程 */
async function main() {
  const args = process.argv.slice(2);
  const tier = resolveTier(args);
  const baseUrl = resolveBaseUrl();
  const onlyScenario = (() => {
    const i = args.indexOf('--scenario');
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  })();
  const dryRun = args.includes('--dry-run');
  const nodeOnly = args.includes('--node-only');

  if (dryRun) await runDryRun(tier);

  let report;
  if (nodeOnly) {
    console.log(`[suite] node 降级模式（PERF_TIER=${tier}，浏览器专属指标未采集）`);
    const data = await runNodeMode();
    report = summarize([], tier, 'node-only', data.environment);
    report.nodeMetrics = data.metrics;
    report.notes = data.notes;
  } else {
    console.log(`[suite] 基准套件启动：PERF_TIER=${tier}（${TIER_PARAMS[tier].label}） base=${baseUrl}`);
    console.log(`[suite] 防抖：3σ 剔除 + 场景间强制 GC + 5s 冷却；环境指纹写入报告头部`);
    const { results, environment } = await runBrowserMode(tier, baseUrl, onlyScenario);
    report = summarize(results, tier, 'browser', environment);
  }

  const file = writeReport(report);
  console.log(`\n========== 基准套件汇总（${report.tier} / ${report.mode}） ==========`);
  for (const r of report.scenarios) {
    console.log(`  ${r.status.padEnd(6)} ${r.id.padEnd(32)} ${(r.elapsedMs / 1000).toFixed(1)}s${r.summary && r.summary.hardFails.length ? ' | FAIL: ' + r.summary.hardFails.join('; ') : ''}`);
  }
  console.log(`档位判定: PASS=${report.summary.PASS} WARN=${report.summary.WARN} FAIL=${report.summary.FAIL} ERROR=${report.summary.ERROR}`);
  console.log(`未定档项（首采定档）: ${report.untuned.map((u) => u.id).join(', ') || '无'}`);
  console.log(`结果已写入 ${file}`);
  console.log(`退出码: ${report.summary.exitCode}（0=通过，1=存在 FAIL/ERROR）`);
  process.exit(report.summary.exitCode);
}

main().catch((err) => {
  console.error(`[suite] 基准套件失败：${err.message}`);
  process.exit(1);
});
