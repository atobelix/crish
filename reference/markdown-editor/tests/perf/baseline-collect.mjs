// tests/perf/baseline-collect.mjs
// R0 性能基线采集脚本（修复前量化对照）
//
// 背景：为「百万行文档 + 500 token/s 流式 + 60/120/140fps」目标采集当前引擎基线数据，
// 并证实一个已知性能问题：appendText 每次全量浅拷贝 lines 数组（O(全文)）。
//
// 口径（对齐 docs/analysis/01-性能帧率路线.md 第五节）：
// - 所有计时均在页面内 performance.now() 环绕完成，避免 Playwright 外部计时污染；
// - 中位数口径：每组样本至少 5 次，报告中位数（抗 GC/JIT 噪声）；
// - 帧间隔：页面内连续 rAF 打点，报告 P50/P95 与 >16.7ms 掉帧比例。
//
// 用法：
//   node tests/perf/baseline-collect.mjs              浏览器模式（默认）
//   node tests/perf/baseline-collect.mjs --node-only  强制 node 降级模式（仅 store 层纯函数基准）
//   node tests/perf/baseline-collect.mjs --no-browser 跳过浏览器探测，直接走降级
//
// 环境变量：
//   PERF_BASE_URL  覆盖 dev server 地址（默认 http://localhost:5173）
//
// 浏览器模式前置条件：
// - 5173 已存在 dev server，或本脚本自动拉起 `npm run dev`（vite）；
// - Playwright chromium 已安装（npx playwright install chromium）。
//
// 降级模式：vite ssrLoadModule 直接在 node 进程内加载 EditorStore.ts（不依赖浏览器），
// 只跑 store 层纯函数基准；全链路击键 / 滚动帧 / 光标移动项标记为未采集。
//
// 产物：baseline-20260809.json（本脚本写入）+ README.md（手工维护结果表）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_JSON = path.join(__dirname, 'baseline-20260809.json');
const BASE_URL = process.env.PERF_BASE_URL || 'http://localhost:5173';

const nodeOnly = process.argv.includes('--node-only');
const skipBrowser = process.argv.includes('--no-browser');

// ---- 基准参数 -------------------------------------------------------------
const DOC_SIZES = [10_000, 100_000, 500_000, 1_000_000]; // append 拷贝曲线四档
const TYPING_DOC_LINES = 500_000; // 中部编辑基准文档规模（50 万行）
const TYPING_LINE_INDEX = 250_000; // 第 25 万行
const TYPING_SAMPLES = 5; // 每组样本数（中位数口径）
const ARROW_COUNT = 100; // ArrowLeft 连续次数
const SCROLL_DURATION_MS = 3000; // 滚动帧采样时长

// 分档加载超时（毫秒）：10 万/100 万行分块加载在修复前较慢，给足余量
const LOAD_TIMEOUT_BY_SIZE = { 10000: 60_000, 100000: 90_000, 500000: 120_000, 1000000: 240_000 };

// ---- 通用统计工具 ---------------------------------------------------------
function median(arr) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(arr, p) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

// 对一组原始样本做统计汇总，返回 { samples, medianMs }
function summarizeSamples(raw) {
  const samples = raw.map((v) => Number(v.toFixed(3)));
  return { samples, medianMs: Number(median(raw).toFixed(3)) };
}

// ---- 工具：检查 5173 是否可用 ----------------------------------------------
async function checkServer(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 工具：拉起 vite dev server --------------------------------------------
async function spawnDevServer() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['run', 'dev'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  // 轮询等待 5173 就绪（上限 40 秒）
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await checkServer(BASE_URL)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('自动启动 vite 失败：40 秒内 5173 未就绪');
}

// ---- 页面端工具代码（在页面上下文执行，Playwright 序列化为独立函数）--------
// 注意：Playwright evaluate 只支持「函数 + 单参数」，页面函数一律单对象参数解构，
// 且必须自包含（不引用外层作用域变量）。

// 加载文档并计时：生成文本不计时，setText 调用 + 分块完成计时
// 注意：页面函数必须自包含，pageGenText/pageWaitLines 内联于此
async function pageLoadDoc({ n, timeoutMs }) {
  const store = window.__CRISH_SESSION_STORE__;
  const genT0 = performance.now();
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = 'L' + i + '_'.repeat(20);
  const text = arr.join('\n');
  const genMs = performance.now() - genT0;
  const t0 = performance.now();
  store.getState().setText(text);
  const syncMs = performance.now() - t0;
  const waitT0 = performance.now();
  let waited;
  while (true) {
    const got = store.getState().lines.length;
    if (got >= n) {
      waited = { ok: true, got, ms: performance.now() - waitT0 };
      break;
    }
    if (performance.now() - waitT0 > timeoutMs) {
      waited = { ok: false, got, ms: performance.now() - waitT0 };
      break;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  return { genMs, syncMs, totalMs: waited.ms, loadedLines: waited.got, ok: waited.ok };
}

// appendText 拷贝量实测：数组引用检查 + 三段耗时（浅拷贝 / clone / 端到端）
async function pageAppendBench({ samples }) {
  const store = window.__CRISH_SESSION_STORE__;
  const get = () => store.getState();

  // 引用检查：append 前后 lines 数组是否为同一引用？首元素是否共享？
  const refBefore = get().lines;
  const el0Before = refBefore[0];
  const lenBefore = refBefore.length;
  get().appendText('W'); // 预热（JIT），不入样本
  const refAfter = get().lines;
  const arrayRefChanged = refBefore !== refAfter; // true => 每次 append 都生成新数组（全量浅拷贝）
  const firstLineShared = refAfter[0] === el0Before; // true => 元素共享，确认为浅拷贝
  const lenDelta = get().lines.length - lenBefore;

  // 纯数组浅拷贝耗时（[...lines]，隔离 O(全文) 拷贝本体）
  const spreadSamples = [];
  for (let i = 0; i < samples; i++) {
    const lines = get().lines;
    const t0 = performance.now();
    const copy = [...lines];
    void copy;
    spreadSamples.push(performance.now() - t0);
  }

  // LineOffsetTree.clone() 耗时（问题 3 的全量深拷贝，O(全文)）
  const cloneSamples = [];
  for (let i = 0; i < samples; i++) {
    const tree = get().lineOffsets;
    const t0 = performance.now();
    tree.clone();
    cloneSamples.push(performance.now() - t0);
  }

  // appendText 端到端耗时（含浅拷贝 + clone + codeBlockState 拷贝 + fence 维护）
  const appendSamples = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    get().appendText('W');
    appendSamples.push(performance.now() - t0);
  }

  return {
    lineCount: get().lines.length,
    arrayRefChanged,
    firstLineShared,
    lenDelta,
    spreadSamples,
    cloneSamples,
    appendSamples,
  };
}

// store 层 insertText 基准（纯数据层，不含 React / 测量）
async function pageTypingStore({ lineIndex, samples }) {
  const store = window.__CRISH_SESSION_STORE__;
  const get = () => store.getState();
  const off = get().lineOffsets.getOffset(lineIndex) + 5;
  get().setCursorPos(off);
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    get().insertText('中');
    raw.push(performance.now() - t0);
    get().setCursorPos(off); // 复位光标
  }
  return { offsetUsed: off, samples: raw };
}

// 全链路输入延迟：native value setter + input 事件 → insertText → React 提交 → 光标层测量
async function pageTypingFullchain({ lineIndex, samples }) {
  const store = window.__CRISH_SESSION_STORE__;
  const get = () => store.getState();
  // 真正的滚动容器是 .editor-scroll-container（parentRef），.engine-container 只是定位包装层
  const scroller = document.querySelector('.editor-scroll-container');
  // 滚动到文档中部，使第 25 万行进入视口（光标测量依赖可见行）
  scroller.scrollTop = scroller.scrollHeight / 2;
  // 等待目标行挂载 + 隐藏 textarea 就绪
  let ta = null;
  for (let i = 0; i < 400; i++) {
    const rowMounted = scroller.querySelector('[data-index="' + lineIndex + '"]');
    ta = document.querySelector('textarea');
    if (rowMounted && ta) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!ta) return { offsetUsed: -1, samples: [], error: 'textarea 未挂载（光标测量失败）' };
  await new Promise((r) => requestAnimationFrame(r));
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;

  const off = get().lineOffsets.getOffset(lineIndex) + 5;
  const raw = [];
  for (let i = 0; i < samples; i++) {
    get().setCursorPos(off);
    await new Promise((r) => requestAnimationFrame(r)); // 等光标层定位
    const before = get().cursorPos;
    const t0 = performance.now();
    nativeSetter.call(ta, '中');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    let t1 = performance.now();
    // React 19 离散事件同步刷新；兜底轮询等待状态落定
    if (get().cursorPos === before) {
      const deadline = t1 + 100;
      while (get().cursorPos === before && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 0));
      }
      t1 = performance.now();
    }
    raw.push(t1 - t0);
  }
  return { offsetUsed: off, samples: raw, error: null };
}

// 光标移动延迟：ArrowLeft 连续 N 次，每次按键的 JS 处理耗时
async function pageArrowLeft({ lineIndex, count }) {
  const store = window.__CRISH_SESSION_STORE__;
  const get = () => store.getState();
  const scroller = document.querySelector('.editor-scroll-container');
  // 先滚动到目标行所在窗口，保证光标测量路径真实执行（含 DOM 全扫 + rect）
  scroller.scrollTop = scroller.scrollHeight / 2;
  let ta = null;
  for (let i = 0; i < 400; i++) {
    const rowMounted = scroller.querySelector('[data-index="' + lineIndex + '"]');
    ta = document.querySelector('textarea');
    if (rowMounted && ta) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!ta) return { offsetUsed: -1, samples: [], error: 'textarea 未挂载，箭头基准跳过' };
  ta.focus();
  const off = get().lineOffsets.getOffset(lineIndex) + 15;
  get().setCursorPos(off);
  await new Promise((r) => requestAnimationFrame(r));
  const raw = [];
  let before = get().cursorPos;
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    let t1 = performance.now();
    // 状态未落定时轮询兜底（React 异步批处理情况）
    if (get().cursorPos === before) {
      const deadline = t1 + 50;
      while (get().cursorPos === before && performance.now() < deadline) {}
      t1 = performance.now();
    }
    before = get().cursorPos;
    raw.push(t1 - t0);
  }
  return { offsetUsed: off, samples: raw, error: null };
}

// 快速滚动帧间隔：rAF 连续打点，期间每帧强制大幅跳变滚动（制造每帧重排压力）
async function pageScrollFrames({ durationMs }) {
  const scroller = document.querySelector('.editor-scroll-container');
  const maxTop = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  const thrashBefore = window.__CRISH_METRICS__.layoutThrashCount;
  const intervals = [];
  let last = null;
  let phase = false;
  let frames = 0;
  const start = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const now = performance.now();
      if (last !== null) intervals.push(now - last);
      last = now;
      phase = !phase;
      scroller.scrollTop = phase ? 0 : maxTop;
      frames++;
      if (now - start < durationMs) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  return {
    intervals,
    frames,
    layoutThrashDelta: window.__CRISH_METRICS__.layoutThrashCount - thrashBefore,
  };
}

// ---- 浏览器模式 ------------------------------------------------------------
async function runBrowserMode() {
  const { chromium } = await import('playwright');

  let serverOk = await checkServer(BASE_URL);
  let devChild = null;
  if (!serverOk) {
    console.log(`[perf] 5173 不可用，尝试自动启动 vite...`);
    try {
      devChild = await spawnDevServer();
      serverOk = true;
    } catch (err) {
      console.log(`[perf] 自动启动失败：${err.message}`);
    }
  }
  if (!serverOk) {
    throw new Error('dev server 不可用（5173 未监听且无法自动拉起），请先运行 npm run dev');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log(`[perf][pageerror] ${err.message}`));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__CRISH_SESSION_STORE__ !== 'undefined', null, { timeout: 30_000 });
    // 等待应用初始文档（StrictMode 双 setText）落定
    await page.waitForFunction(() => window.__CRISH_METRICS__.getLineCount() > 0, null, { timeout: 60_000 });
    await page.waitForTimeout(1500);

    const environment = await page.evaluate(() => ({
      ua: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      language: navigator.language,
    }));

    const metrics = {};

    // 1) append 拷贝曲线（1 万/10 万/50 万档；1M 档与加载计时共用一次加载）
    const perSize = [];
    for (const size of DOC_SIZES.filter((s) => s < 1_000_000)) {
      const load = await page.evaluate(pageLoadDoc, { n: size, timeoutMs: LOAD_TIMEOUT_BY_SIZE[size] });
      if (!load.ok) console.log(`[perf] 警告：${size} 行加载超时（${load.loadedLines} 行）`);
      const bench = await page.evaluate(pageAppendBench, { samples: TYPING_SAMPLES });
      perSize.push({
        size,
        loadMs: Number(load.totalMs.toFixed(1)),
        loadedLines: load.loadedLines,
        arrayRefChanged: bench.arrayRefChanged,
        firstLineShared: bench.firstLineShared,
        lenDelta: bench.lenDelta,
        spreadCopyMs: summarizeSamples(bench.spreadSamples),
        offsetsCloneMs: summarizeSamples(bench.cloneSamples),
        appendTotalMs: summarizeSamples(bench.appendSamples),
      });
      console.log(`[perf] append 档位 ${size} 行完成（加载 ${load.totalMs.toFixed(0)}ms，中位 append ${summarizeSamples(bench.appendSamples).medianMs}ms）`);
    }
    metrics.appendCopyCurve = { sizes: DOC_SIZES.filter((s) => s < 1_000_000), perSize };

    // 2) 中部编辑击键延迟（当前文档即 50 万行）：store 层 + 全链路
    const typingStore = await page.evaluate(pageTypingStore, { lineIndex: TYPING_LINE_INDEX, samples: TYPING_SAMPLES });
    const typingFull = await page.evaluate(pageTypingFullchain, { lineIndex: TYPING_LINE_INDEX, samples: TYPING_SAMPLES });
    metrics.typingAtMiddle = {
      docLines: TYPING_DOC_LINES,
      lineIndex: TYPING_LINE_INDEX,
      storeLayerMs: summarizeSamples(typingStore.samples),
      fullChainMs: summarizeSamples(typingFull.samples),
      offsetUsed: typingStore.offsetUsed,
    };
    if (typingFull.error) console.log(`[perf] 警告：全链路击键 ${typingFull.error}`);
    console.log(`[perf] 中部击键：store 层中位 ${metrics.typingAtMiddle.storeLayerMs.medianMs}ms，全链路中位 ${metrics.typingAtMiddle.fullChainMs.medianMs}ms`);

    // 3) 光标移动延迟：ArrowLeft 连续 100 次
    const arrow = await page.evaluate(pageArrowLeft, { lineIndex: TYPING_LINE_INDEX, count: ARROW_COUNT });
    if (arrow.error) {
      console.log(`[perf] 警告：${arrow.error}`);
    }
    metrics.arrowLeft = {
      count: arrow.samples.length,
      offsetUsed: arrow.offsetUsed,
      avgMs: Number((sum(arrow.samples) / arrow.samples.length).toFixed(3)),
      p50Ms: Number(pct(arrow.samples, 0.5).toFixed(3)),
      p95Ms: Number(pct(arrow.samples, 0.95).toFixed(3)),
      minMs: Number(Math.min(...arrow.samples).toFixed(3)),
      maxMs: Number(Math.max(...arrow.samples).toFixed(3)),
      samples: arrow.samples.map((v) => Number(v.toFixed(3))),
    };
    if (arrow.samples.length > 0) {
      console.log(`[perf] ArrowLeft ×${arrow.samples.length}：均值 ${metrics.arrowLeft.avgMs}ms/键，P95 ${metrics.arrowLeft.p95Ms}ms`);
    }

    // 4) 百万行：加载计时（数据层完成）→ append 曲线 1M 档 → 滚动帧采样
    const load1M = await page.evaluate(pageLoadDoc, { n: 1_000_000, timeoutMs: LOAD_TIMEOUT_BY_SIZE[1000000] });
    metrics.load1MLines = {
      ok: load1M.ok,
      elapsedMs: Number(load1M.totalMs.toFixed(1)),
      syncMs: Number(load1M.syncMs.toFixed(2)),
      genMs: Number(load1M.genMs.toFixed(1)),
      loadedLines: load1M.loadedLines,
    };
    console.log(`[perf] 百万行加载 ${load1M.totalMs.toFixed(0)}ms（同步 ${load1M.syncMs.toFixed(1)}ms + 分块 ${(load1M.totalMs - load1M.syncMs).toFixed(0)}ms）`);
    if (load1M.ok) {
      const bench1M = await page.evaluate(pageAppendBench, { samples: TYPING_SAMPLES });
      perSize.push({
        size: 1_000_000,
        loadMs: Number(load1M.totalMs.toFixed(1)),
        loadedLines: load1M.loadedLines,
        arrayRefChanged: bench1M.arrayRefChanged,
        firstLineShared: bench1M.firstLineShared,
        lenDelta: bench1M.lenDelta,
        spreadCopyMs: summarizeSamples(bench1M.spreadSamples),
        offsetsCloneMs: summarizeSamples(bench1M.cloneSamples),
        appendTotalMs: summarizeSamples(bench1M.appendSamples),
      });
      metrics.appendCopyCurve.sizes = DOC_SIZES;
    }

    // 5) 快速滚动帧间隔（1M 行文档上）
    const scroll = await page.evaluate(pageScrollFrames, { durationMs: SCROLL_DURATION_MS });
    const intervals = scroll.intervals;
    metrics.scrollFrames = {
      docLines: 1_000_000,
      durationMs: SCROLL_DURATION_MS,
      frameCount: scroll.frames,
      nominalFrameMs: Number(pct(intervals, 0.05).toFixed(2)),
      intervalP50Ms: Number(pct(intervals, 0.5).toFixed(2)),
      intervalP95Ms: Number(pct(intervals, 0.95).toFixed(2)),
      intervalP99Ms: Number(pct(intervals, 0.99).toFixed(2)),
      meanMs: Number((sum(intervals) / intervals.length).toFixed(2)),
      framesOver16_7: intervals.filter((v) => v > 16.7).length,
      layoutThrashDelta: scroll.layoutThrashDelta,
    };
    console.log(`[perf] 滚动帧：P50 ${metrics.scrollFrames.intervalP50Ms}ms / P95 ${metrics.scrollFrames.intervalP95Ms}ms，layoutThrash +${scroll.layoutThrashDelta}`);

    return {
      environment,
      metrics,
    };
  } finally {
    await browser.close();
    if (devChild) devChild.kill();
  }
}

// ---- node 降级模式（仅 store 层纯函数基准）----------------------------------
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

    // 生成 n 行纯文本（与浏览器模式同款内容）
    function genText(n) {
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = 'L' + i + '_'.repeat(20);
      return arr.join('\n');
    }

    // 分块加载完成轮询（node 无 requestIdleCallback，走 setTimeout(10ms) 分支）
    async function loadDoc(n, timeoutMs) {
      const t0 = performance.now();
      get().setText(genText(n));
      while (get().lines.length < n) {
        if (performance.now() - t0 > timeoutMs) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      return { ms: performance.now() - t0, loaded: get().lines.length };
    }

    const environment = {
      os: `${os.platform()} ${os.release()}`,
      node: process.version,
      cpus: os.cpus().length,
      arch: os.arch(),
    };

    const metrics = {};

    // 1) append 拷贝曲线（四档）
    const perSize = [];
    for (const size of DOC_SIZES) {
      const load = await loadDoc(size, LOAD_TIMEOUT_BY_SIZE[size]);
      const refBefore = get().lines;
      const el0Before = refBefore[0];
      const lenBefore = refBefore.length;
      get().appendText('W'); // 预热
      const refAfter = get().lines;

      const spreadSamples = [];
      for (let i = 0; i < TYPING_SAMPLES; i++) {
        const lines = get().lines;
        const t0 = performance.now();
        void [...lines];
        spreadSamples.push(performance.now() - t0);
      }
      const cloneSamples = [];
      for (let i = 0; i < TYPING_SAMPLES; i++) {
        const tree = get().lineOffsets;
        const t0 = performance.now();
        tree.clone();
        cloneSamples.push(performance.now() - t0);
      }
      const appendSamples = [];
      for (let i = 0; i < TYPING_SAMPLES; i++) {
        const t0 = performance.now();
        get().appendText('W');
        appendSamples.push(performance.now() - t0);
      }

      perSize.push({
        size,
        loadMs: Number(load.ms.toFixed(1)),
        loadedLines: load.loaded,
        arrayRefChanged: refBefore !== refAfter,
        firstLineShared: refAfter[0] === el0Before,
        lenDelta: get().lines.length - lenBefore,
        spreadCopyMs: summarizeSamples(spreadSamples),
        offsetsCloneMs: summarizeSamples(cloneSamples),
        appendTotalMs: summarizeSamples(appendSamples),
      });
      console.log(`[perf][node] append 档位 ${size} 行完成（加载 ${load.ms.toFixed(0)}ms）`);
    }
    metrics.appendCopyCurve = { sizes: DOC_SIZES, perSize };

    // 2) store 层 insertText 基准（50 万行第 25 万行）
    await loadDoc(TYPING_DOC_LINES, LOAD_TIMEOUT_BY_SIZE[500000]);
    const off = get().lineOffsets.getOffset(TYPING_LINE_INDEX) + 5;
    get().setCursorPos(off);
    const storeSamples = [];
    for (let i = 0; i < TYPING_SAMPLES; i++) {
      const t0 = performance.now();
      get().insertText('中');
      storeSamples.push(performance.now() - t0);
      get().setCursorPos(off);
    }
    metrics.typingAtMiddle = {
      docLines: TYPING_DOC_LINES,
      lineIndex: TYPING_LINE_INDEX,
      storeLayerMs: summarizeSamples(storeSamples),
      fullChainMs: null, // 无浏览器环境，未采集
      offsetUsed: off,
    };

    // 3) 百万行加载
    const load1M = await loadDoc(1_000_000, LOAD_TIMEOUT_BY_SIZE[1000000]);
    metrics.load1MLines = {
      ok: load1M.loaded >= 1_000_000,
      elapsedMs: Number(load1M.ms.toFixed(1)),
      loadedLines: load1M.loaded,
    };

    // 4) 浏览器专属项置空
    metrics.arrowLeft = null;
    metrics.scrollFrames = null;

    return { environment, metrics };
  } finally {
    await server.close();
  }
}

// ---- 主流程 -----------------------------------------------------------------
async function main() {
  let mode = 'browser';
  let data = null;
  let fallbackError = null;

  try {
    if (nodeOnly || skipBrowser) throw new Error('显式指定降级模式');
    data = await runBrowserMode();
  } catch (err) {
    fallbackError = err.message;
    console.log(`[perf] 浏览器模式失败（${err.message}），降级为 node store 层基准...`);
    mode = 'node';
    data = await runNodeMode();
  }

  const notes = [];
  if (mode === 'node') {
    notes.push('浏览器模式不可用，仅采集 store 层纯函数基准；全链路击键 / 滚动帧 / 光标移动未采集');
    if (fallbackError) notes.push(`降级原因：${fallbackError}`);
  } else {
    notes.push('计时全部在页面内 performance.now() 完成，规避 Playwright 外部计时污染');
  }
  notes.push('append 曲线各档为 5 次采样中位数；纯文本文档（无 fence/表格），隔离数据层成本');

  const report = {
    schema: 'conex-r0-perf-baseline/v1',
    collectedAt: new Date().toISOString(),
    mode,
    environment: {
      platform: os.platform(),
      nodeVersion: process.version,
      serverBase: BASE_URL,
      ...data.environment,
    },
    metrics: data.metrics,
    notes,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n[perf] 结果已写入 ${OUT_JSON}`);

  // 汇总打印（供回报使用）
  const m = report.metrics;
  console.log('\n========== R0 基线采集汇总 ==========');
  if (m.load1MLines) {
    const sync = m.load1MLines.syncMs !== undefined ? `, 同步 ${m.load1MLines.syncMs} ms` : '';
    console.log(`百万行加载: ${m.load1MLines.elapsedMs} ms (ok=${m.load1MLines.ok}${sync})`);
  }
  if (m.typingAtMiddle && m.typingAtMiddle.storeLayerMs) {
    const full = m.typingAtMiddle.fullChainMs
      ? `; 全链路中位 ${m.typingAtMiddle.fullChainMs.medianMs} ms`
      : '; 全链路未采集';
    console.log(`中部击键(store 层): 中位 ${m.typingAtMiddle.storeLayerMs.medianMs} ms${full}`);
  }
  if (m.appendCopyCurve) {
    console.log('append 拷贝曲线（行数 -> spread浅拷贝/clone/append端到端 中位 ms）:');
    for (const p of m.appendCopyCurve.perSize) {
      console.log(`  ${String(p.size).padStart(8)} -> ${p.spreadCopyMs.medianMs} / ${p.offsetsCloneMs.medianMs} / ${p.appendTotalMs.medianMs}  (数组引用变化=${p.arrayRefChanged}, 首元素共享=${p.firstLineShared})`);
    }
  }
  if (m.arrowLeft && m.arrowLeft.samples && m.arrowLeft.samples.length > 0) {
    console.log(`ArrowLeft×${m.arrowLeft.count}: 均值 ${m.arrowLeft.avgMs} ms/键, P95 ${m.arrowLeft.p95Ms} ms`);
  }
  if (m.scrollFrames) {
    console.log(`滚动帧: P50 ${m.scrollFrames.intervalP50Ms} ms / P95 ${m.scrollFrames.intervalP95Ms} ms, >16.7ms ${m.scrollFrames.framesOver16_7}/${m.scrollFrames.frameCount}, layoutThrash +${m.scrollFrames.layoutThrashDelta}`);
  }
  console.log('====================================');
  return report;
}

main().catch((err) => {
  console.error(`[perf] 采集失败：${err.message}`);
  process.exit(1);
});
