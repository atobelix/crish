// tests/perf/baseline-recollect.mjs
// R2 性能重测脚本（修复后量化对照，口径复刻 R0 baseline-collect.mjs）
//
// 背景：R2 轮六项改造落地（R2-A 尾段零拷贝 + COW / R2-B 行高模型 / R2-C 测量缓存 /
// R2-D 命令式滚动管线 / R2-E fence O(1) / R2-F 跨视口箭头），本脚本在同一台机器、
// 同一口径下重采六项指标，与 R0 基线（baseline-20260809.json）直接对比：
//   - 百万行加载（R2 未改分块加载，预期不变；但每 chunk 的 clone 已 COW，可能略升）
//   - 中部击键全链路（预期下降：测量缓存 + 订阅优化）
//   - appendText 数据层（预期大幅下降：尾段零拷贝——主数组不再重建）
//   - 滚动帧（预期下降：命令式位置 + 零 React 提交）
//   - ArrowLeft（预期下降：索引二分 + 测量缓存）
//
// 口径（与 R0 完全一致，对齐 docs/analysis/01-性能帧率路线.md 第五节）：
// - 所有计时均在页面内 performance.now() 环绕完成，规避 Playwright 外部计时污染；
// - 中位数口径：每组样本 ≥5 次，报告中位数（抗 GC/JIT 噪声）；
// - 帧间隔：页面内连续 rAF 打点，报告 P50/P95/P99 与 >16.7ms 掉帧数；
// - 纯文本行 'L'+i+'_'*20 构造（无 fence/表格/标题），隔离数据层成本。
//
// R2 新增探针（对比 R0 的 append 拷贝曲线）：
//   - mainArrayRefChanged：appendText 前后主数组引用是否变化（R0 全 true——全量浅拷贝；
//     R2 尾段零拷贝预期 false——主数组不重建）；
//   - materializeProbeMs：模拟物化视图成本 main.slice(0,-1).concat(tail)（R2 过渡期
//     兼容视图，R2-BD 切换访问器后移除；appendText 端到端含此成本）；
//   - appendDataNetMs：appendText 端到端中位数 - 物化成本中位数 = 数据层净值
//     （零拷贝路径的真实收益，O(尾段) + 树 COW O(256)）。
//
// 用法（与 R0 一致）：
//   node tests/perf/baseline-recollect.mjs               浏览器模式（默认，失败自动降级）
//   node tests/perf/baseline-recollect.mjs --node-only   强制 node 降级模式
// 环境变量：PERF_BASE_URL 覆盖 dev server 地址（默认 http://localhost:5173）
//
// 产物：baseline-20260809-r2.json（本脚本写入）+ README.md（R2 对比表手工追加）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_JSON = path.join(__dirname, 'baseline-20260809-r2.json');
const R0_JSON = path.join(__dirname, 'baseline-20260809.json');
const BASE_URL = process.env.PERF_BASE_URL || 'http://localhost:5173';

const nodeOnly = process.argv.includes('--node-only');
const skipBrowser = process.argv.includes('--no-browser');

// ---- 基准参数（与 R0 完全一致，保证口径可比）--------------------------------
const DOC_SIZES = [10_000, 100_000, 500_000, 1_000_000]; // append 曲线四档
const TYPING_DOC_LINES = 500_000; // 中部编辑基准文档规模（50 万行）
const TYPING_LINE_INDEX = 250_000; // 第 25 万行
const TYPING_SAMPLES = 5; // 每组样本数（中位数口径）
const ARROW_COUNT = 100; // ArrowLeft 连续次数
const SCROLL_DURATION_MS = 3000; // 滚动帧采样时长

const LOAD_TIMEOUT_BY_SIZE = { 10000: 60_000, 100000: 90_000, 500000: 120_000, 1000000: 240_000 };

// ---- 通用统计工具（与 R0 同款）---------------------------------------------
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

function summarizeSamples(raw) {
  const samples = raw.map((v) => Number(v.toFixed(3)));
  return { samples, medianMs: Number(median(raw).toFixed(3)) };
}

// ---- 工具：检查 5173 是否可用 / 拉起 dev server（与 R0 同款）-----------------
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

async function spawnDevServer() {
  // Windows 下直接 spawn npm.cmd 会抛 EINVAL（cmd 批处理需要 shell 层），
  // 统一走 cmd.exe /c 启动（R0 脚本在此环境依赖手动起服务，本脚本修复自动拉起）
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn('npm', ['run', 'dev'], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await checkServer(BASE_URL)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('自动启动 vite 失败：40 秒内 5173 未就绪');
}

// ---- 页面端工具代码（Playwright 序列化：单参数对象解构 + 自包含）------------

// 加载文档并计时（与 R0 同款：分块加载走 requestIdleCallback，轮询 lines.length）
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

// R2 版 append 基准：主数组引用检查 + 数据层净值拆分 + 四段耗时
async function pageAppendBench({ samples }) {
  const store = window.__CRISH_SESSION_STORE__;
  const get = () => store.getState();

  // 引用检查（R2 语义升级）：
  // - mainArrayRefChanged：主数组是否重建（R0 的 lines 全量浅拷贝 → true；
  //   R2 尾段零拷贝 → false，主数组不重建）
  // - viewArrayRefChanged：兼容视图 lines 是否重建（尾段非空时物化 → true，
  //   过渡期成本，R2-BD 移除）
  const mainBefore = get().mainLines;
  const viewBefore = get().lines;
  const el0Before = mainBefore[0];
  const lenBefore = get().getLineCount();
  get().appendText('W'); // 预热（JIT），不入样本
  const mainAfter = get().mainLines;
  const viewAfter = get().lines;
  const mainArrayRefChanged = mainBefore !== mainAfter;
  const viewArrayRefChanged = viewBefore !== viewAfter;
  const firstLineShared = mainAfter[0] === el0Before;
  const lenDelta = get().getLineCount() - lenBefore;

  // 纯主数组浅拷贝耗时（与 R0 的 [...lines] 同构——R0 时 lines 恒等于主数组）
  const spreadSamples = [];
  for (let i = 0; i < samples; i++) {
    const main = get().mainLines;
    const t0 = performance.now();
    void [...main];
    spreadSamples.push(performance.now() - t0);
  }

  // 物化视图成本模拟（R2 新增：materializeViews 在尾段非空时做两套数组
  // slice(0,-1)+concat —— lines 与 codeBlockState，另加 fence 平移（O(1)））
  const materializeSamples = [];
  for (let i = 0; i < samples; i++) {
    const main = get().mainLines;
    const tail = get().streamTail;
    const mainState = get().mainCodeState;
    const tailState = get().streamTailCodeState;
    const t0 = performance.now();
    void main.slice(0, -1).concat(tail);
    void mainState.slice(0, -1).concat(tailState);
    materializeSamples.push(performance.now() - t0);
  }

  // LineOffsetTree.clone() 耗时（R2 COW：浅拷贝块引用数组，预期 ~0.01ms）
  const cloneSamples = [];
  for (let i = 0; i < samples; i++) {
    const tree = get().lineOffsets;
    const t0 = performance.now();
    tree.clone();
    cloneSamples.push(performance.now() - t0);
  }

  // appendText 端到端耗时（尾段零拷贝 + 树 COW + 视图物化 + textLength O(1)）
  const appendSamples = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    get().appendText('W');
    appendSamples.push(performance.now() - t0);
  }

  return {
    lineCount: get().getLineCount(),
    mainArrayRefChanged,
    viewArrayRefChanged,
    firstLineShared,
    lenDelta,
    streamTailLen: get().streamTail.length,
    spreadSamples,
    materializeSamples,
    cloneSamples,
    appendSamples,
  };
}

// store 层 insertText 基准（纯数据层，与 R0 同款；R2 下先 flush 尾段归一——
// 与 R0 同形态（无尾段），隔离数据层真实成本；尾段非空时的击键成本
// 由 KNOWN-DEFECT 污染，另作专项记录）
async function pageTypingStore({ lineIndex, samples }) {
  const store = window.__CRISH_SESSION_STORE__;
  const get = () => store.getState();
  get().flushStreamTail(); // R0 同形态归一
  const off = get().lineOffsets.getOffset(lineIndex) + 5;
  get().setCursorPos(off);
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    get().insertText('中');
    raw.push(performance.now() - t0);
    get().setCursorPos(off);
  }
  return { offsetUsed: off, samples: raw };
}

// 全链路输入延迟（native value setter + input 事件 → insertText → React → 光标测量）
// 注意：Playwright evaluate 要求页面函数自包含——行导航逻辑内联于此
// （R2 行高实测回填后 headless 下 29px 漂移，scrollHeight/2 会把目标行
// 推离窗口 2 行导致 textarea 卸载；按已挂载窗口 index 差 × 28px 增量滚动，
// 第一轮大步跳转 + 微调，通常 2-4 轮收敛）
async function pageTypingFullchain({ lineIndex, samples }) {
  const store = window.__CRISH_SESSION_STORE__;
  const get = () => store.getState();
  get().flushStreamTail(); // R0 同形态归一（无尾段）
  const scroller = document.querySelector('.editor-scroll-container');
  for (let iter = 0; iter < 60; iter++) {
    let first = -1;
    let last = -1;
    const rows = scroller.querySelectorAll('[data-index]');
    for (const r of rows) {
      const i = parseInt(r.getAttribute('data-index'), 10);
      if (first === -1 || i < first) first = i;
      if (i > last) last = i;
    }
    if (first !== -1 && lineIndex >= first && lineIndex <= last) break;
    if (first === -1) {
      await new Promise((r) => requestAnimationFrame(r));
      continue;
    }
    if (lineIndex > last) {
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + (lineIndex - last + 5) * 28);
    } else {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - (first - lineIndex + 5) * 28);
    }
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
  }
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

// 光标移动延迟：ArrowLeft 连续 N 次（与 R0 同款；行导航逻辑内联自包含）
async function pageArrowLeft({ lineIndex, count }) {
  const store = window.__CRISH_SESSION_STORE__;
  const get = () => store.getState();
  get().flushStreamTail(); // R0 同形态归一（无尾段）
  const scroller = document.querySelector('.editor-scroll-container');
  for (let iter = 0; iter < 60; iter++) {
    let first = -1;
    let last = -1;
    const rows = scroller.querySelectorAll('[data-index]');
    for (const r of rows) {
      const i = parseInt(r.getAttribute('data-index'), 10);
      if (first === -1 || i < first) first = i;
      if (i > last) last = i;
    }
    if (first !== -1 && lineIndex >= first && lineIndex <= last) break;
    if (first === -1) {
      await new Promise((r) => requestAnimationFrame(r));
      continue;
    }
    if (lineIndex > last) {
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + (lineIndex - last + 5) * 28);
    } else {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - (first - lineIndex + 5) * 28);
    }
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
  }
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

// 快速滚动帧间隔：rAF 连续打点 + 每帧强制大幅跳变滚动（与 R0 同款）
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
    console.log(`[perf-r2] 5173 不可用，尝试自动启动 vite...`);
    try {
      devChild = await spawnDevServer();
      serverOk = true;
    } catch (err) {
      console.log(`[perf-r2] 自动启动失败：${err.message}`);
    }
  }
  if (!serverOk) {
    throw new Error('dev server 不可用（5173 未监听且无法自动拉起），请先运行 npm run dev');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log(`[perf-r2][pageerror] ${err.message}`));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__CRISH_SESSION_STORE__ !== 'undefined', null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__CRISH_METRICS__.getLineCount() > 0, null, { timeout: 60_000 });
    await page.waitForTimeout(1500);

    const environment = await page.evaluate(() => ({
      ua: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      language: navigator.language,
    }));

    const metrics = {};

    // 1) append 曲线（R2 版探针；1M 档与加载计时共用一次加载）
    const perSize = [];
    for (const size of DOC_SIZES.filter((s) => s < 1_000_000)) {
      const load = await page.evaluate(pageLoadDoc, { n: size, timeoutMs: LOAD_TIMEOUT_BY_SIZE[size] });
      if (!load.ok) console.log(`[perf-r2] 警告：${size} 行加载超时（${load.loadedLines} 行）`);
      const bench = await page.evaluate(pageAppendBench, { samples: TYPING_SAMPLES });
      perSize.push({
        size,
        loadMs: Number(load.totalMs.toFixed(1)),
        loadedLines: load.loadedLines,
        mainArrayRefChanged: bench.mainArrayRefChanged,
        viewArrayRefChanged: bench.viewArrayRefChanged,
        firstLineShared: bench.firstLineShared,
        lenDelta: bench.lenDelta,
        streamTailLen: bench.streamTailLen,
        spreadCopyMs: summarizeSamples(bench.spreadSamples),
        materializeProbeMs: summarizeSamples(bench.materializeSamples),
        offsetsCloneMs: summarizeSamples(bench.cloneSamples),
        appendTotalMs: summarizeSamples(bench.appendSamples),
        // 数据层净值 = 端到端 - 物化成本（近似剥离过渡期视图成本）
        appendDataNetMs: Number(Math.max(0, median(bench.appendSamples) - median(bench.materializeSamples)).toFixed(3)),
      });
      console.log(`[perf-r2] append 档位 ${size} 行完成（加载 ${load.totalMs.toFixed(0)}ms，端到端中位 ${summarizeSamples(bench.appendSamples).medianMs}ms，净值 ${perSize[perSize.length - 1].appendDataNetMs}ms）`);
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
    if (typingFull.error) console.log(`[perf-r2] 警告：全链路击键 ${typingFull.error}`);
    console.log(`[perf-r2] 中部击键：store 层中位 ${metrics.typingAtMiddle.storeLayerMs.medianMs}ms，全链路中位 ${metrics.typingAtMiddle.fullChainMs.medianMs}ms`);

    // 3) 光标移动延迟：ArrowLeft 连续 100 次
    const arrow = await page.evaluate(pageArrowLeft, { lineIndex: TYPING_LINE_INDEX, count: ARROW_COUNT });
    if (arrow.error) console.log(`[perf-r2] 警告：${arrow.error}`);
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
      console.log(`[perf-r2] ArrowLeft ×${arrow.samples.length}：均值 ${metrics.arrowLeft.avgMs}ms/键，P95 ${metrics.arrowLeft.p95Ms}ms`);
    }

    // 4) 百万行：加载计时 → append 曲线 1M 档 → 滚动帧采样
    const load1M = await page.evaluate(pageLoadDoc, { n: 1_000_000, timeoutMs: LOAD_TIMEOUT_BY_SIZE[1000000] });
    metrics.load1MLines = {
      ok: load1M.ok,
      elapsedMs: Number(load1M.totalMs.toFixed(1)),
      syncMs: Number(load1M.syncMs.toFixed(2)),
      genMs: Number(load1M.genMs.toFixed(1)),
      loadedLines: load1M.loadedLines,
    };
    console.log(`[perf-r2] 百万行加载 ${load1M.totalMs.toFixed(0)}ms（同步 ${load1M.syncMs.toFixed(1)}ms + 分块 ${(load1M.totalMs - load1M.syncMs).toFixed(0)}ms）`);
    if (load1M.ok) {
      const bench1M = await page.evaluate(pageAppendBench, { samples: TYPING_SAMPLES });
      perSize.push({
        size: 1_000_000,
        loadMs: Number(load1M.totalMs.toFixed(1)),
        loadedLines: load1M.loadedLines,
        mainArrayRefChanged: bench1M.mainArrayRefChanged,
        viewArrayRefChanged: bench1M.viewArrayRefChanged,
        firstLineShared: bench1M.firstLineShared,
        lenDelta: bench1M.lenDelta,
        streamTailLen: bench1M.streamTailLen,
        spreadCopyMs: summarizeSamples(bench1M.spreadSamples),
        materializeProbeMs: summarizeSamples(bench1M.materializeSamples),
        offsetsCloneMs: summarizeSamples(bench1M.cloneSamples),
        appendTotalMs: summarizeSamples(bench1M.appendSamples),
        appendDataNetMs: Number(Math.max(0, median(bench1M.appendSamples) - median(bench1M.materializeSamples)).toFixed(3)),
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
    console.log(`[perf-r2] 滚动帧：P50 ${metrics.scrollFrames.intervalP50Ms}ms / P95 ${metrics.scrollFrames.intervalP95Ms}ms，layoutThrash +${scroll.layoutThrashDelta}`);

    return { environment, metrics };
  } finally {
    await browser.close();
    if (devChild) devChild.kill();
  }
}

// ---- node 降级模式（仅 store 层纯函数基准，与 R0 同构）-----------------------
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

    function genText(n) {
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = 'L' + i + '_'.repeat(20);
      return arr.join('\n');
    }

    async function loadDoc(n, timeoutMs) {
      const t0 = performance.now();
      get().setText(genText(n));
      while (get().getLineCount() < n) {
        if (performance.now() - t0 > timeoutMs) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      return { ms: performance.now() - t0, loaded: get().getLineCount() };
    }

    const environment = {
      os: `${os.platform()} ${os.release()}`,
      node: process.version,
      cpus: os.cpus().length,
      arch: os.arch(),
    };

    const metrics = {};

    // 1) append 曲线（四档，R2 版探针）
    const perSize = [];
    for (const size of DOC_SIZES) {
      const load = await loadDoc(size, LOAD_TIMEOUT_BY_SIZE[size]);
      const mainBefore = get().mainLines;
      const el0Before = mainBefore[0];
      const lenBefore = get().getLineCount();
      get().appendText('W'); // 预热
      const mainAfter = get().mainLines;

      const spreadSamples = [];
      for (let i = 0; i < TYPING_SAMPLES; i++) {
        const main = get().mainLines;
        const t0 = performance.now();
        void [...main];
        spreadSamples.push(performance.now() - t0);
      }
      const materializeSamples = [];
      for (let i = 0; i < TYPING_SAMPLES; i++) {
        const main = get().mainLines;
        const tail = get().streamTail;
        const mainState = get().mainCodeState;
        const tailState = get().streamTailCodeState;
        const t0 = performance.now();
        void main.slice(0, -1).concat(tail);
        void mainState.slice(0, -1).concat(tailState);
        materializeSamples.push(performance.now() - t0);
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
        mainArrayRefChanged: mainBefore !== mainAfter,
        viewArrayRefChanged: null, // node 模式不采集视图探针（行为与浏览器一致，语义相同）
        firstLineShared: mainAfter[0] === el0Before,
        lenDelta: get().getLineCount() - lenBefore,
        streamTailLen: get().streamTail.length,
        spreadCopyMs: summarizeSamples(spreadSamples),
        materializeProbeMs: summarizeSamples(materializeSamples),
        offsetsCloneMs: summarizeSamples(cloneSamples),
        appendTotalMs: summarizeSamples(appendSamples),
        appendDataNetMs: Number(Math.max(0, median(appendSamples) - median(materializeSamples)).toFixed(3)),
      });
      console.log(`[perf-r2][node] append 档位 ${size} 行完成（加载 ${load.ms.toFixed(0)}ms，端到端中位 ${summarizeSamples(appendSamples).medianMs}ms，净值 ${perSize[perSize.length - 1].appendDataNetMs}ms）`);
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

// ---- 与 R0 基线的对比汇总 ------------------------------------------------
function printComparison(r2Report) {
  let r0 = null;
  try {
    r0 = JSON.parse(fs.readFileSync(R0_JSON, 'utf8'));
  } catch {
    console.log('[perf-r2] 未找到 R0 基线文件，跳过对比表');
    return;
  }
  const m0 = r0.metrics;
  const m2 = r2Report.metrics;
  const pctChg = (a, b) => (a && b ? Number(((b / a - 1) * 100).toFixed(1)) : null);

  console.log('\n========== R2 重测 vs R0 基线对比 ==========');
  console.log('指标                        R0            R2            变化率');
  if (m0.load1MLines && m2.load1MLines) {
    console.log(`百万行加载           ${String(m0.load1MLines.elapsedMs).padStart(8)} ms   ${String(m2.load1MLines.elapsedMs).padStart(10)} ms   ${pctChg(m0.load1MLines.elapsedMs, m2.load1MLines.elapsedMs)}%`);
  }
  if (m0.typingAtMiddle && m2.typingAtMiddle) {
    const s0 = m0.typingAtMiddle.storeLayerMs?.medianMs;
    const s2 = m2.typingAtMiddle.storeLayerMs?.medianMs;
    if (s0 != null && s2 != null) console.log(`中部击键 store 层      ${String(s0).padStart(8)} ms   ${String(s2).padStart(10)} ms   ${pctChg(s0, s2)}%`);
    const f0 = m0.typingAtMiddle.fullChainMs?.medianMs;
    const f2 = m2.typingAtMiddle.fullChainMs?.medianMs;
    if (f0 != null && f2 != null) console.log(`中部击键全链路       ${String(f0).padStart(8)} ms   ${String(f2).padStart(10)} ms   ${pctChg(f0, f2)}%`);
  }
  // append 曲线：1M 档端到端 + 数据层净值
  const p0 = m0.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000);
  const p2 = m2.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000);
  if (p0 && p2) {
    console.log(`append@1M 端到端     ${String(p0.appendTotalMs.medianMs).padStart(8)} ms   ${String(p2.appendTotalMs.medianMs).padStart(10)} ms   ${pctChg(p0.appendTotalMs.medianMs, p2.appendTotalMs.medianMs)}%`);
    console.log(`append@1M 数据层净值        n/a   ${String(p2.appendDataNetMs).padStart(10)} ms   （R0 无净值口径；R0 clone 1.1ms + 浅拷贝 0.5ms 即其数据层成本）`);
    console.log(`主数组引用重建      ${String(p0.arrayRefChanged).padStart(8)}   ${String(p2.mainArrayRefChanged).padStart(10)}   （R0 true=全量浅拷贝 / R2 false=尾段零拷贝）`);
  }
  if (m0.arrowLeft && m2.arrowLeft && m2.arrowLeft.samples?.length) {
    console.log(`ArrowLeft 均值      ${String(m0.arrowLeft.avgMs).padStart(8)} ms   ${String(m2.arrowLeft.avgMs).padStart(10)} ms   ${pctChg(m0.arrowLeft.avgMs, m2.arrowLeft.avgMs)}%`);
    console.log(`ArrowLeft P95       ${String(m0.arrowLeft.p95Ms).padStart(8)} ms   ${String(m2.arrowLeft.p95Ms).padStart(10)} ms   ${pctChg(m0.arrowLeft.p95Ms, m2.arrowLeft.p95Ms)}%`);
  }
  if (m0.scrollFrames && m2.scrollFrames) {
    console.log(`滚动帧 P50          ${String(m0.scrollFrames.intervalP50Ms).padStart(8)} ms   ${String(m2.scrollFrames.intervalP50Ms).padStart(10)} ms   ${pctChg(m0.scrollFrames.intervalP50Ms, m2.scrollFrames.intervalP50Ms)}%`);
    console.log(`滚动帧 P95          ${String(m0.scrollFrames.intervalP95Ms).padStart(8)} ms   ${String(m2.scrollFrames.intervalP95Ms).padStart(10)} ms   ${pctChg(m0.scrollFrames.intervalP95Ms, m2.scrollFrames.intervalP95Ms)}%`);
    console.log(`layoutThrash 增量  ${String(m0.scrollFrames.layoutThrashDelta).padStart(8)}  ${String(m2.scrollFrames.layoutThrashDelta).padStart(10)}  ${pctChg(m0.scrollFrames.layoutThrashDelta, m2.scrollFrames.layoutThrashDelta)}%`);
  }
  console.log('==========================================');
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
    console.log(`[perf-r2] 浏览器模式失败（${err.message}），降级为 node store 层基准...`);
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
  notes.push('R2 新增：mainArrayRefChanged（主数组是否重建）、materializeProbeMs（物化视图成本）、appendDataNetMs（端到端 - 物化 = 数据层净值）');
  notes.push('已知缺陷（2026-08-09 R2-G 验证发现，已上报）：insertText/deleteText/deleteSelection/undo/redo 编辑触达后 streamTail 残留未清空（partial 缺清空键），物化视图与主数组分叉——本脚本不触及编辑路径，指标不受影响');

  const report = {
    schema: 'conex-r2-perf-recollect/v1',
    collectedAt: new Date().toISOString(),
    mode,
    r0Reference: path.basename(R0_JSON),
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
  console.log(`\n[perf-r2] 结果已写入 ${OUT_JSON}`);

  // 汇总打印（供回报使用）
  const m = report.metrics;
  console.log('\n========== R2 重测采集汇总 ==========');
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
    console.log('append 曲线（行数 -> 端到端/净值/clone 中位 ms, 主数组重建, 尾段行数）:');
    for (const p of m.appendCopyCurve.perSize) {
      console.log(`  ${String(p.size).padStart(8)} -> 端到端 ${p.appendTotalMs.medianMs} / 净值 ${p.appendDataNetMs} / clone ${p.offsetsCloneMs.medianMs}  (主数组重建=${p.mainArrayRefChanged}, 尾段行数=${p.streamTailLen})`);
    }
  }
  if (m.arrowLeft && m.arrowLeft.samples && m.arrowLeft.samples.length > 0) {
    console.log(`ArrowLeft×${m.arrowLeft.count}: 均值 ${m.arrowLeft.avgMs} ms/键, P95 ${m.arrowLeft.p95Ms} ms`);
  }
  if (m.scrollFrames) {
    console.log(`滚动帧: P50 ${m.scrollFrames.intervalP50Ms} ms / P95 ${m.scrollFrames.intervalP95Ms} ms, >16.7ms ${m.scrollFrames.framesOver16_7}/${m.scrollFrames.frameCount}, layoutThrash +${m.scrollFrames.layoutThrashDelta}`);
  }
  console.log('====================================');

  printComparison(report);
  return report;
}

main().catch((err) => {
  console.error(`[perf-r2] 采集失败：${err.message}`);
  process.exit(1);
});
