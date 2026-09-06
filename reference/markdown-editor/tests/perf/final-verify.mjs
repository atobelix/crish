// tests/perf/final-verify.mjs
// R6 终验轮·性能终验复测脚本（R6-B）
//
// 背景：R2 六项改造（尾段零拷贝/行高模型/测量缓存/命令式滚动/fence O(1)/跨视口箭头）
// 之后的 R3（R3-A stop-flush / R3-B1 访问器切换）与 R5 功能轮（实例工厂/渲染注册表等）
// 已落地；R5.5 宿主 streamAppend 接线仍未落地（流式注入继续走 store.appendText
// 回落等价路径，口径与 R3-D 一致）。本脚本在 R0/R2/R3 同机同口径下完成终验复测：
//
//   1. 百万行滚动（R2 后首测）：1M 行快速滚动 rAF P50/P95/P99 + 长任务计数 +
//      layoutThrash（对比 R0 P95 20.9ms / R2 P95 21.8ms；R0 layoutThrash +270 /
//      R2 +180）；
//   2. 500 token/s 流式复测（四场景 A 纯文本 / B 代码 fence / C 公式 fence /
//      D 编辑+流式）：复用 R3-D stream-inject-500.mjs 源码口径，GPU 有头优先，
//      headless 兜底参考；
//   3. 击键全链路（对比 R0 8.0ms / R2 17.4ms——测量缓存/访问器切换后收益，
//      R2-BD 后 MarkdownEngine 不再订阅物化视图 lines）；
//   4. ArrowLeft 复测（对比 R0 13.8ms/键 P95 17.0 / R2 14.2ms/键 P95 15.7——
//      R2 结论中 getText() 全量 join 瓶颈 R5 功能轮未覆盖，预期持平）；
//   5. 内存稳态：500 token/s 60s 注入后 JS 堆增长（performance.memory，
//      流式场景内 1s 采样 + 起止快照，R3-D 同款探针）；
//   6. 输出最终对比表（R0 → R2 → 终验）：每项变化率 + 60/120/140fps 档位判定。
//
// 判定口径（任务书）：
//   - 60fps 保底：帧间隔 P95 < 16.6ms；
//   - 120fps 冲刺：帧间隔 P50 < 8.33ms；140fps 冲刺：P50 < 7.14ms；
//   - headless 渲染器名义 60Hz，120/140 档标注「渲染器上限，不可达」；
//   - 场景 D 附加文本一致性断言（与页面内参考模型全量一致）。
//
// 用法：
//   node tests/perf/final-verify.mjs                完整终验（headless 交互项 + GPU 流式）
//   node tests/perf/final-verify.mjs --interactive-only  只跑 headless 交互项（滚动/击键/Arrow/加载）
//   node tests/perf/final-verify.mjs --stream-only       只跑 GPU 流式四场景（默认 headed）
//   node tests/perf/final-verify.mjs --stream-headless   流式轮强制 headless（软件渲染参考）
//   node tests/perf/final-verify.mjs --node-only         强制 node 降级模式（store 层回放）
//
// 环境变量：PERF_BASE_URL（dev server 地址，默认 http://localhost:5173）、
//           STREAM_DURATION_MS / STREAM_TPS（流式参数，默认 60000 / 500）。
//
// 产物：final-verify-report.json（本脚本写入）+ README.md（终验表手工追加）。
// 纪律：编码 UTF-8 无 BOM；中文注释；不 commit。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_JSON = path.join(__dirname, 'final-verify-report.json');
const R0_JSON = path.join(__dirname, 'baseline-20260809.json');
const R2_JSON = path.join(__dirname, 'baseline-20260809-r2.json');
const R3_JSON = path.join(__dirname, 'stream-inject-report.json');
const BASE_URL = process.env.PERF_BASE_URL || 'http://localhost:5173';

const interactiveOnly = process.argv.includes('--interactive-only');
const streamOnly = process.argv.includes('--stream-only');
const streamHeadless = process.argv.includes('--stream-headless');
const nodeOnly = process.argv.includes('--node-only');

// ---- 基准参数（与 R0/R2 完全一致，保证口径可比）----------------------------
const TYPING_DOC_LINES = 500_000;   // 中部编辑基准文档规模（50 万行）
const TYPING_LINE_INDEX = 250_000;  // 第 25 万行
const TYPING_SAMPLES = 5;           // 每组样本数（中位数口径）
const ARROW_COUNT = 100;            // ArrowLeft 连续次数
const SCROLL_DURATION_MS = 3000;    // 滚动帧采样时长
const LOAD_TIMEOUT_BY_SIZE = { 500000: 120_000, 1000000: 240_000 };

// ---- 流式参数（与 R3-D 一致；env 可覆盖）-----------------------------------
const TOKENS_PER_SECOND = Number(process.env.STREAM_TPS || 500);
const DURATION_MS = Number(process.env.STREAM_DURATION_MS || 60_000);
const FRAME_BUDGET_MS = 16.6;       // 60fps 保底判定阈值（任务口径）
const EDIT_INTERVAL_MS = 2_000;     // 场景 D 用户编辑间隔

// ---- fps 档位判定 -----------------------------------------------------------
// 60fps 保底：P95 < 16.6ms；120fps：P50 < 8.33ms；140fps：P50 < 7.14ms。
// 返回 { band, label, actualHz }；headless（60Hz 渲染器）下 120/140 不可达。
function fpsBand(p50, p95, nominalHz) {
  const actualHz = p50 ? Number((1000 / p50).toFixed(0)) : null;
  let band;
  if (p95 < FRAME_BUDGET_MS) {
    band = '60fps PASS';
    if (nominalHz >= 120 && p50 < 7.14) band = '140fps';
    else if (nominalHz >= 120 && p50 < 8.33) band = '120fps';
    else if (nominalHz >= 120) band = '60fps PASS（名义 120Hz 未达）';
  } else {
    band = '60fps FAIL';
  }
  if (nominalHz < 120 && p95 < FRAME_BUDGET_MS) band = '60fps PASS（渲染器上限 60Hz，120/140 不可达）';
  return { band, actualHz };
}

// ---- 通用统计工具（与 R0/R2/R3 同款）---------------------------------------
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

// 变化率（新值相对旧值的百分比；旧值缺失返回 null）
function pctChg(oldV, newV) {
  if (oldV == null || newV == null || !isFinite(oldV) || !isFinite(newV)) return null;
  return Number(((newV / oldV - 1) * 100).toFixed(1));
}

// ---- 工具：检查 5173 是否可用 / 拉起 dev server（R3 同款，Windows 修复）------
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

// ---- 页面端函数源码（Playwright evaluate：单参数对象解构 + 自包含）---------
// 以下各函数与 R0/R2 采集脚本同款（口径完全复刻），仅 pageScrollFrames 新增
// PerformanceObserver longtask 计数探针（终验任务 1 要求）。

// 加载文档并计时（R0/R2 同款：setText 同步部分 + 分块完成轮询）
const PAGE_LOAD_DOC_SRC = `
async function pageLoadDoc(args) {
  var store = window.__CRISH_SESSION_STORE__;
  var n = args.n;
  var timeoutMs = args.timeoutMs;
  var genT0 = performance.now();
  var arr = new Array(n);
  for (var i = 0; i < n; i++) arr[i] = 'L' + i + '_'.repeat(20);
  var text = arr.join('\\n');
  var genMs = performance.now() - genT0;
  var t0 = performance.now();
  store.getState().setText(text);
  var syncMs = performance.now() - t0;
  var waitT0 = performance.now();
  var waited;
  while (true) {
    var got = store.getState().lines.length;
    if (got >= n) { waited = { ok: true, got: got, ms: performance.now() - waitT0 }; break; }
    if (performance.now() - waitT0 > timeoutMs) { waited = { ok: false, got: got, ms: performance.now() - waitT0 }; break; }
    await new Promise(function (r) { setTimeout(r, 15); });
  }
  return { genMs: genMs, syncMs: syncMs, totalMs: waited.ms, loadedLines: waited.got, ok: waited.ok };
}
`;

// append@1M 基准（R2 版探针：主数组重建 / 物化成本 / clone / 端到端 / 净值）
// 终验任务：验证 R2-BD 访问器切换后（MarkdownEngine 不再订阅 lines）append 端到端
// 是否回落；materializeViews 仍在 set 热路径（EditorStore.ts:1003），预期物化
// 成本仍存在——实测为准。
const PAGE_APPEND_BENCH_SRC = `
async function pageAppendBench(args) {
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  var samples = args.samples;
  var mainBefore = get().mainLines;
  var el0Before = mainBefore[0];
  var lenBefore = get().getLineCount();
  get().appendText('W');
  var mainAfter = get().mainLines;
  var mainArrayRefChanged = mainBefore !== mainAfter;
  var firstLineShared = mainAfter[0] === el0Before;
  var lenDelta = get().getLineCount() - lenBefore;

  var spreadSamples = [];
  for (var i = 0; i < samples; i++) {
    var main = get().mainLines;
    var t0 = performance.now();
    void [...main];
    spreadSamples.push(performance.now() - t0);
  }
  var materializeSamples = [];
  for (var j = 0; j < samples; j++) {
    var m = get().mainLines;
    var tail = get().streamTail;
    var ms = get().mainCodeState;
    var ts = get().streamTailCodeState;
    var t1 = performance.now();
    void m.slice(0, -1).concat(tail);
    void ms.slice(0, -1).concat(ts);
    materializeSamples.push(performance.now() - t1);
  }
  var cloneSamples = [];
  for (var k = 0; k < samples; k++) {
    var tree = get().lineOffsets;
    var t2 = performance.now();
    tree.clone();
    cloneSamples.push(performance.now() - t2);
  }
  var appendSamples = [];
  for (var q = 0; q < samples; q++) {
    var t3 = performance.now();
    get().appendText('W');
    appendSamples.push(performance.now() - t3);
  }
  return {
    lineCount: get().getLineCount(),
    mainArrayRefChanged: mainArrayRefChanged,
    firstLineShared: firstLineShared,
    lenDelta: lenDelta,
    streamTailLen: get().streamTail.length,
    spreadSamples: spreadSamples,
    materializeSamples: materializeSamples,
    cloneSamples: cloneSamples,
    appendSamples: appendSamples,
  };
}
`;

// store 层 insertText 基准（R2 同款：flushStreamTail 归一为 R0 同形态）
const PAGE_TYPING_STORE_SRC = `
async function pageTypingStore(args) {
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  var lineIndex = args.lineIndex;
  var samples = args.samples;
  get().flushStreamTail();
  var off = get().lineOffsets.getOffset(lineIndex) + 5;
  get().setCursorPos(off);
  var raw = [];
  for (var i = 0; i < samples; i++) {
    var t0 = performance.now();
    get().insertText('中');
    raw.push(performance.now() - t0);
    get().setCursorPos(off);
  }
  return { offsetUsed: off, samples: raw };
}
`;

// 全链路输入延迟（R2 同款：渐进行导航——headless 行高 29px 漂移修复）
const PAGE_TYPING_FULLCHAIN_SRC = `
async function pageTypingFullchain(args) {
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  var lineIndex = args.lineIndex;
  var samples = args.samples;
  get().flushStreamTail();
  var scroller = document.querySelector('.editor-scroll-container');
  for (var iter = 0; iter < 60; iter++) {
    var first = -1;
    var last = -1;
    var rows = scroller.querySelectorAll('[data-index]');
    for (var a = 0; a < rows.length; a++) {
      var i = parseInt(rows[a].getAttribute('data-index'), 10);
      if (first === -1 || i < first) first = i;
      if (i > last) last = i;
    }
    if (first !== -1 && lineIndex >= first && lineIndex <= last) break;
    if (first === -1) { await new Promise(function (r) { requestAnimationFrame(r); }); continue; }
    if (lineIndex > last) {
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + (lineIndex - last + 5) * 28);
    } else {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - (first - lineIndex + 5) * 28);
    }
    await new Promise(function (r) { requestAnimationFrame(r); });
    await new Promise(function (r) { requestAnimationFrame(r); });
  }
  var ta = null;
  for (var b = 0; b < 400; b++) {
    var rowMounted = scroller.querySelector('[data-index="' + lineIndex + '"]');
    ta = document.querySelector('textarea');
    if (rowMounted && ta) break;
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  if (!ta) return { offsetUsed: -1, samples: [], error: 'textarea 未挂载（光标测量失败）' };
  await new Promise(function (r) { requestAnimationFrame(r); });
  var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  var off = get().lineOffsets.getOffset(lineIndex) + 5;
  var raw = [];
  for (var c = 0; c < samples; c++) {
    get().setCursorPos(off);
    await new Promise(function (r) { requestAnimationFrame(r); });
    var before = get().cursorPos;
    var t0 = performance.now();
    nativeSetter.call(ta, '中');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    var t1 = performance.now();
    if (get().cursorPos === before) {
      var deadline = t1 + 100;
      while (get().cursorPos === before && performance.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 0); });
      }
      t1 = performance.now();
    }
    raw.push(t1 - t0);
  }
  return { offsetUsed: off, samples: raw, error: null };
}
`;

// ArrowLeft 连续移动（R2 同款：行导航 + flushStreamTail 归一）
const PAGE_ARROW_LEFT_SRC = `
async function pageArrowLeft(args) {
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  var lineIndex = args.lineIndex;
  var count = args.count;
  get().flushStreamTail();
  var scroller = document.querySelector('.editor-scroll-container');
  for (var iter = 0; iter < 60; iter++) {
    var first = -1;
    var last = -1;
    var rows = scroller.querySelectorAll('[data-index]');
    for (var a = 0; a < rows.length; a++) {
      var i = parseInt(rows[a].getAttribute('data-index'), 10);
      if (first === -1 || i < first) first = i;
      if (i > last) last = i;
    }
    if (first !== -1 && lineIndex >= first && lineIndex <= last) break;
    if (first === -1) { await new Promise(function (r) { requestAnimationFrame(r); }); continue; }
    if (lineIndex > last) {
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + (lineIndex - last + 5) * 28);
    } else {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - (first - lineIndex + 5) * 28);
    }
    await new Promise(function (r) { requestAnimationFrame(r); });
    await new Promise(function (r) { requestAnimationFrame(r); });
  }
  var ta = null;
  for (var b = 0; b < 400; b++) {
    var rowMounted = scroller.querySelector('[data-index="' + lineIndex + '"]');
    ta = document.querySelector('textarea');
    if (rowMounted && ta) break;
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  if (!ta) return { offsetUsed: -1, samples: [], error: 'textarea 未挂载，箭头基准跳过' };
  ta.focus();
  var off = get().lineOffsets.getOffset(lineIndex) + 15;
  get().setCursorPos(off);
  await new Promise(function (r) { requestAnimationFrame(r); });
  var raw = [];
  var before = get().cursorPos;
  for (var c = 0; c < count; c++) {
    var t0 = performance.now();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    var t1 = performance.now();
    if (get().cursorPos === before) {
      var deadline = t1 + 50;
      while (get().cursorPos === before && performance.now() < deadline) {}
      t1 = performance.now();
    }
    before = get().cursorPos;
    raw.push(t1 - t0);
  }
  return { offsetUsed: off, samples: raw, error: null };
}
`;

// 快速滚动帧间隔（R0/R2 同款：每帧 0↔maxTop 强制跳变 + 新增 longtask 计数）
const PAGE_SCROLL_FRAMES_SRC = `
async function pageScrollFrames(args) {
  var scroller = document.querySelector('.editor-scroll-container');
  var durationMs = args.durationMs;
  var maxTop = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  var thrashBefore = window.__CRISH_METRICS__.layoutThrashCount;
  var longTasks = [];
  var ltObserver = null;
  try {
    ltObserver = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) longTasks.push(entries[i].duration);
    });
    ltObserver.observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  var intervals = [];
  var last = null;
  var phase = false;
  var frames = 0;
  var start = performance.now();
  await new Promise(function (resolve) {
    var step = function () {
      var now = performance.now();
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
  if (ltObserver) { try { ltObserver.disconnect(); } catch (e) {} }
  var ltTotal = 0;
  for (var j = 0; j < longTasks.length; j++) ltTotal += longTasks[j];
  return {
    intervals: intervals,
    frames: frames,
    layoutThrashDelta: window.__CRISH_METRICS__.layoutThrashCount - thrashBefore,
    longTasks: { count: longTasks.length, totalMs: Number(ltTotal.toFixed(2)) },
  };
}
`;

// ---- 流式注入源码（R3-D stream-inject-500.mjs 同款，原样复用口径）----------
// token 生成器：确定性迭代器，场景 A 文本 / B 代码 fence / C 公式 fence 段序列
const GEN_SRC = `
function createTokenGen(scenario) {
  var words = ['流式','注入','引擎','渲染','性能','帧率','预算','解析','增量','合并','光标','选区','撤销','重做','虚拟','滚动','测量','回填','样本','缓存','线程','提交','布局','绘制','采样','统计','判定','预算','达标','回落'];
  var CODE_SEG = ['\`\`\`js\\n', 'const a = 1;\\n', 'a + b = 3;\\n', 'console.log(a);\\n', '\`\`\`\\n'];
  var MATH_SEG = ['$$\\n', 'x_i^2 + y_i^2 = r^2\\n', '\\\\sum_{i=1}^n i = n(n+1)/2\\n', '$$\\n'];
  var seg = scenario === 'code' ? CODE_SEG : scenario === 'math' ? MATH_SEG : null;
  var segEvery = scenario === 'code' ? 40 : 60;
  var segPos = seg ? 0 : null;
  var segAt = -1;
  var n = 0;
  var w = 0;
  var nl = 0;
  return function next() {
    var t;
    if (segPos !== null) {
      t = seg[segPos++];
      if (segPos >= seg.length) { segPos = null; }
    } else if (seg && n - segAt >= segEvery) {
      segAt = n;
      segPos = 0;
      t = seg[segPos++];
      if (segPos >= seg.length) { segPos = null; }
    } else {
      t = words[w++ % words.length];
      nl++;
      if (nl >= 8) { t += '\\n'; nl = 0; }
    }
    n++;
    return t;
  };
}
`;

// 场景 D 初始文档（100 行确定性中文文本；编辑点在第 50 行中段）
function genInitText() {
  const arr = [];
  for (let i = 0; i < 100; i++) {
    arr.push('初始文档第' + i + '行：这是用于流式期间用户编辑正确性验证的稳定文本内容。');
  }
  return arr.join('\n');
}

// 页面端流式主函数（R3-D 同款：注入调度 / 内联 StreamBuffer / 长任务 / 堆探针 /
// 参考模型校验 / 收口 flushStreamTail）
const PAGE_STREAM_FN_SRC = `
async function pageRunStream(args) {
  var scenario = args.scenario;
  var initText = args.initText;
  var durationMs = args.durationMs;
  var tps = args.tps;
  var editIntervalMs = args.editIntervalMs;
  var editPos = args.editPos;
  var budgetMs = args.budgetMs;
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };

  var initLines = initText.length === 0 ? 1 : initText.split('\\n').length;
  get().setText(initText);
  var deadline = performance.now() + 10000;
  while (get().getLineCount() !== initLines && performance.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 15); });
  }
  await new Promise(function (r) { requestAnimationFrame(r); });

  var createTokenGen = eval('(' + ${JSON.stringify(GEN_SRC)} + ')');
  var gen = createTokenGen(scenario);
  var modelStream = '';
  var modelEdits = '';
  var tokenCount = 0;

  var buf = '';
  var rafId = null;
  var bufActive = false;
  var chunkMs = [];
  var push = function (t) {
    if (!t) return;
    buf += t;
    if (!bufActive) {
      bufActive = true;
      rafId = requestAnimationFrame(function () {
        var c = buf;
        buf = '';
        bufActive = false;
        rafId = null;
        var t0 = performance.now();
        get().appendText(c);
        chunkMs.push(performance.now() - t0);
      });
    }
  };
  var flushBuf = function () {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    bufActive = false;
    if (buf) {
      var c = buf;
      buf = '';
      var t0 = performance.now();
      get().appendText(c);
      chunkMs.push(performance.now() - t0);
    }
  };

  var longTasks = [];
  var ltObserver = null;
  try {
    ltObserver = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) longTasks.push(entries[i].duration);
    });
    ltObserver.observe({ entryTypes: ['longtask'] });
  } catch (e) {}

  var heapSamples = [];
  var heapTimer = null;
  var heapStartMB = null;
  try {
    heapStartMB = performance.memory.usedJSHeapSize / 1048576;
    heapTimer = setInterval(function () {
      try {
        heapSamples.push(performance.memory.usedJSHeapSize / 1048576);
      } catch (e) {}
    }, 1000);
  } catch (e) {}

  var stopped = false;
  var edits = 0;
  var editTimer = null;
  var t0 = performance.now();
  var stepMs = 1000 / tps;
  var injected = 0;
  var injectTimer = setInterval(function () {
    if (stopped) { clearInterval(injectTimer); return; }
    var now = performance.now();
    var target = Math.floor((now - t0) / stepMs);
    while (injected < target) {
      var t = gen();
      push(t);
      modelStream += t;
      tokenCount++;
      injected++;
    }
    if (now - t0 >= durationMs) {
      stopped = true;
      if (editTimer) clearInterval(editTimer);
      if (heapTimer) clearInterval(heapTimer);
      flushBuf();
    }
  }, 1);

  if (scenario === 'edit') {
    editTimer = setInterval(function () {
      if (stopped) { clearInterval(editTimer); return; }
      edits++;
      var text = 'U' + edits + '。';
      get().setCursorPos(editPos);
      get().insertText(text);
      modelEdits += text;
      editPos += text.length;
    }, editIntervalMs);
  }

  var intervals = [];
  var last = null;
  var frames = 0;
  await new Promise(function (resolve) {
    var frameStep = function () {
      var now = performance.now();
      if (last !== null) intervals.push(now - last);
      last = now;
      frames++;
      if (!stopped) requestAnimationFrame(frameStep);
      else resolve();
    };
    requestAnimationFrame(frameStep);
  });

  flushBuf();
  get().flushStreamTail();
  await new Promise(function (r) { requestAnimationFrame(r); });
  await new Promise(function (r) { setTimeout(r, 50); });

  if (ltObserver) { try { ltObserver.disconnect(); } catch (e) {} }
  if (heapTimer) clearInterval(heapTimer);
  if (editTimer) clearInterval(editTimer);
  clearInterval(injectTimer);

  var s = get();
  var finalText = s.getText();
  var expected = initText.slice(0, editPos - modelEdits.length)
    + modelEdits
    + initText.slice(editPos - modelEdits.length)
    + modelStream;
  var textMatch = finalText === expected;
  var heapEndMB = null;
  var heapPeakMB = heapSamples.length ? Math.max.apply(null, heapSamples) : null;
  try { heapEndMB = performance.memory.usedJSHeapSize / 1048576; } catch (e) {}
  var ltTotalMs = 0;
  var ltMaxMs = 0;
  for (var i = 0; i < longTasks.length; i++) {
    ltTotalMs += longTasks[i];
    if (longTasks[i] > ltMaxMs) ltMaxMs = longTasks[i];
  }
  var sorted = intervals.slice().sort(function (a, b) { return a - b; });
  return {
    scenario: scenario,
    injectedTokens: tokenCount,
    modelStreamChars: modelStream.length,
    edits: edits,
    textLength: s.textLength,
    finalTextChars: finalText.length,
    expectedChars: expected.length,
    textMatch: textMatch,
    consistency: s.verifyConsistency(),
    frames: {
      count: intervals.length,
      p50: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] : NaN,
      p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : NaN,
      p99: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : NaN,
      mean: intervals.length ? intervals.reduce(function (a, b) { return a + b; }, 0) / intervals.length : NaN,
      over16_7: intervals.filter(function (v) { return v > 16.7; }).length,
      over33_3: intervals.filter(function (v) { return v > 33.3; }).length,
    },
    longTasks: {
      count: longTasks.length,
      totalMs: Number(ltTotalMs.toFixed(2)),
      maxMs: Number(ltMaxMs.toFixed(2)),
    },
    heap: {
      startMB: heapStartMB !== null ? Number(heapStartMB.toFixed(1)) : null,
      peakMB: heapPeakMB !== null ? Number(heapPeakMB.toFixed(1)) : null,
      endMB: heapEndMB !== null ? Number(heapEndMB.toFixed(1)) : null,
    },
    chunkMs: {
      count: chunkMs.length,
      p50: (function (a) { if (!a.length) return NaN; var x = a.slice().sort(function (p, q) { return p - q; }); return x[Math.min(x.length - 1, Math.floor(x.length * 0.5))]; })(chunkMs),
      p95: (function (a) { if (!a.length) return NaN; var x = a.slice().sort(function (p, q) { return p - q; }); return x[Math.min(x.length - 1, Math.floor(x.length * 0.95))]; })(chunkMs),
    },
    error: null,
  };
}
`;

// ---- 浏览器模式：headless 交互项（滚动/击键/Arrow/加载/append@1M）------------
async function runInteractiveMode() {
  const { chromium } = await import('playwright');
  let serverOk = await checkServer(BASE_URL);
  let devChild = null;
  if (!serverOk) {
    console.log(`[final] 5173 不可用，尝试自动启动 vite...`);
    try {
      devChild = await spawnDevServer();
      serverOk = true;
    } catch (err) {
      console.log(`[final] 自动启动失败：${err.message}`);
    }
  }
  if (!serverOk) {
    throw new Error('dev server 不可用（5173 未监听且无法自动拉起），请先运行 npm run dev');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log(`[final][pageerror] ${err.message}`));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__CRISH_SESSION_STORE__ !== 'undefined', null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__CRISH_METRICS__.getLineCount() > 1000, null, { timeout: 120_000 });
    await page.waitForTimeout(1500);

    const environment = await page.evaluate(() => ({
      ua: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      language: navigator.language,
    }));

    const metrics = {};
    const fns = {
      pageLoadDoc: new Function(PAGE_LOAD_DOC_SRC + '\nreturn pageLoadDoc;')(),
      pageAppendBench: new Function(PAGE_APPEND_BENCH_SRC + '\nreturn pageAppendBench;')(),
      pageTypingStore: new Function(PAGE_TYPING_STORE_SRC + '\nreturn pageTypingStore;')(),
      pageTypingFullchain: new Function(PAGE_TYPING_FULLCHAIN_SRC + '\nreturn pageTypingFullchain;')(),
      pageArrowLeft: new Function(PAGE_ARROW_LEFT_SRC + '\nreturn pageArrowLeft;')(),
      pageScrollFrames: new Function(PAGE_SCROLL_FRAMES_SRC + '\nreturn pageScrollFrames;')(),
    };

    // 1) 50 万行：加载 → store 层击键 → 全链路击键 → ArrowLeft
    const load500k = await page.evaluate(fns.pageLoadDoc, { n: TYPING_DOC_LINES, timeoutMs: LOAD_TIMEOUT_BY_SIZE[500000] });
    console.log(`[final] 50 万行加载 ${load500k.totalMs.toFixed(0)}ms（ok=${load500k.ok}）`);
    const typingStore = await page.evaluate(fns.pageTypingStore, { lineIndex: TYPING_LINE_INDEX, samples: TYPING_SAMPLES });
    const typingFull = await page.evaluate(fns.pageTypingFullchain, { lineIndex: TYPING_LINE_INDEX, samples: TYPING_SAMPLES });
    if (typingFull.error) console.log(`[final] 警告：全链路击键 ${typingFull.error}`);
    metrics.typingAtMiddle = {
      docLines: TYPING_DOC_LINES,
      lineIndex: TYPING_LINE_INDEX,
      storeLayerMs: summarizeSamples(typingStore.samples),
      fullChainMs: summarizeSamples(typingFull.samples),
      offsetUsed: typingStore.offsetUsed,
    };
    console.log(`[final] 中部击键：store 层中位 ${metrics.typingAtMiddle.storeLayerMs.medianMs}ms，全链路中位 ${metrics.typingAtMiddle.fullChainMs.medianMs}ms`);

    const arrow = await page.evaluate(fns.pageArrowLeft, { lineIndex: TYPING_LINE_INDEX, count: ARROW_COUNT });
    if (arrow.error) console.log(`[final] 警告：${arrow.error}`);
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
      console.log(`[final] ArrowLeft ×${arrow.samples.length}：均值 ${metrics.arrowLeft.avgMs}ms/键，P95 ${metrics.arrowLeft.p95Ms}ms`);
    }

    // 2) 百万行：加载计时 → append@1M 基准 → 滚动帧（longtask + layoutThrash）
    const load1M = await page.evaluate(fns.pageLoadDoc, { n: 1_000_000, timeoutMs: LOAD_TIMEOUT_BY_SIZE[1000000] });
    metrics.load1MLines = {
      ok: load1M.ok,
      elapsedMs: Number(load1M.totalMs.toFixed(1)),
      syncMs: Number(load1M.syncMs.toFixed(2)),
      genMs: Number(load1M.genMs.toFixed(1)),
      loadedLines: load1M.loadedLines,
    };
    console.log(`[final] 百万行加载 ${load1M.totalMs.toFixed(0)}ms（同步 ${load1M.syncMs.toFixed(1)}ms + 分块 ${(load1M.totalMs - load1M.syncMs).toFixed(0)}ms）`);
    if (load1M.ok) {
      const bench1M = await page.evaluate(fns.pageAppendBench, { samples: TYPING_SAMPLES });
      metrics.appendAt1M = {
        mainArrayRefChanged: bench1M.mainArrayRefChanged,
        firstLineShared: bench1M.firstLineShared,
        streamTailLen: bench1M.streamTailLen,
        spreadCopyMs: summarizeSamples(bench1M.spreadSamples),
        materializeProbeMs: summarizeSamples(bench1M.materializeSamples),
        offsetsCloneMs: summarizeSamples(bench1M.cloneSamples),
        appendTotalMs: summarizeSamples(bench1M.appendSamples),
        appendDataNetMs: Number(Math.max(0, median(bench1M.appendSamples) - median(bench1M.materializeSamples)).toFixed(3)),
      };
      console.log(`[final] append@1M：端到端中位 ${metrics.appendAt1M.appendTotalMs.medianMs}ms，物化 ${metrics.appendAt1M.materializeProbeMs.medianMs}ms，净值 ${metrics.appendAt1M.appendDataNetMs}ms，主数组重建=${metrics.appendAt1M.mainArrayRefChanged}`);
    }

    const scroll = await page.evaluate(fns.pageScrollFrames, { durationMs: SCROLL_DURATION_MS });
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
      framesOver33_3: intervals.filter((v) => v > 33.3).length,
      layoutThrashDelta: scroll.layoutThrashDelta,
      longTasks: scroll.longTasks,
    };
    console.log(`[final] 滚动帧：P50 ${metrics.scrollFrames.intervalP50Ms}ms / P95 ${metrics.scrollFrames.intervalP95Ms}ms / P99 ${metrics.scrollFrames.intervalP99Ms}ms，layoutThrash +${scroll.layoutThrashDelta}，长任务 ${scroll.longTasks.count} 次（${scroll.longTasks.totalMs}ms）`);

    return { environment, metrics };
  } finally {
    await browser.close();
    if (devChild) devChild.kill();
  }
}

// ---- 浏览器模式：流式四场景（GPU 有头优先，--stream-headless 强制软件渲染）---
async function runStreamMode() {
  const { chromium } = await import('playwright');
  let serverOk = await checkServer(BASE_URL);
  let devChild = null;
  if (!serverOk) {
    console.log(`[final] 5173 不可用，尝试自动启动 vite...`);
    try {
      devChild = await spawnDevServer();
      serverOk = true;
    } catch (err) {
      console.log(`[final] 自动启动失败：${err.message}`);
    }
  }
  if (!serverOk) {
    throw new Error('dev server 不可用（5173 未监听且无法自动拉起），请先运行 npm run dev');
  }

  const headed = !streamHeadless; // 默认 GPU 有头优先（任务口径）
  const browser = await chromium.launch({ headless: !headed });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log(`[final][pageerror] ${err.message}`));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__CRISH_SESSION_STORE__ !== 'undefined', null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__CRISH_METRICS__.getLineCount() > 1000, null, { timeout: 120_000 });
    await page.waitForTimeout(1500);

    const environment = await page.evaluate(() => ({
      ua: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      language: navigator.language,
    }));

    const scenarios = [
      { key: 'A-plain', scenario: 'plain', initText: '', editPos: 0 },
      { key: 'B-code-fence', scenario: 'code', initText: '', editPos: 0 },
      { key: 'C-math-fence', scenario: 'math', initText: '', editPos: 0 },
      { key: 'D-edit-during-stream', scenario: 'edit', initText: genInitText(), editPos: null },
    ].filter(
      // 单场景重跑（复测用）：STREAM_SCENARIO=C-math-fence 时只跑该场景
      (sc) => !process.env.STREAM_SCENARIO || sc.key === process.env.STREAM_SCENARIO
    );

    const pageRun = new Function(PAGE_STREAM_FN_SRC + '\nreturn pageRunStream;')();
    const results = {};
    for (const sc of scenarios) {
      console.log(`[final] 流式场景 ${sc.key}（${headed ? 'GPU' : 'headless'}）：500 token/s × ${DURATION_MS / 1000}s 开始...`);
      const tRun0 = Date.now();
      const r = await page.evaluate(pageRun, {
        scenario: sc.scenario,
        initText: sc.initText,
        durationMs: DURATION_MS,
        tps: TOKENS_PER_SECOND,
        editIntervalMs: EDIT_INTERVAL_MS,
        editPos: sc.editPos === null ? Math.floor(genInitText().length / 2) : sc.editPos,
        budgetMs: FRAME_BUDGET_MS,
      }, { timeout: 0 });
      const elapsedSec = ((Date.now() - tRun0) / 1000).toFixed(1);
      const f = r.frames;
      const verdict = {
        p95UnderBudget: f.p95 < FRAME_BUDGET_MS,
        textMatch: r.textMatch,
        pass: f.p95 < FRAME_BUDGET_MS && (sc.scenario !== 'edit' || r.textMatch),
      };
      results[sc.key] = { ...r, verdict };
      console.log(
        `[final] 场景 ${sc.key} 完成（${elapsedSec}s）：token=${r.injectedTokens} 帧=${f.count} ` +
        `P50=${f.p50.toFixed(2)}ms P95=${f.p95.toFixed(2)}ms P99=${f.p99.toFixed(2)}ms ` +
        `>16.7ms=${f.over16_7} >33.3ms=${f.over33_3} 长任务=${r.longTasks.count} ` +
        `文本一致=${r.textMatch} 判定=${verdict.pass ? 'PASS' : 'FAIL'}`
      );
    }
    return { environment, results, headed };
  } finally {
    await browser.close();
    if (devChild) devChild.kill();
  }
}

// ---- node 降级模式（store 层回放：append 净值 + 击键 + 流式吞吐）-------------
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

    // 1) append@1M：主数组重建 + 物化 + clone + 端到端 + 净值
    await loadDoc(1_000_000, LOAD_TIMEOUT_BY_SIZE[1000000]);
    const mainBefore = get().mainLines;
    const _lenBefore = get().getLineCount();
    get().appendText('W');
    const mainAfter = get().mainLines;
    const spreadSamples = [];
    const materializeSamples = [];
    const cloneSamples = [];
    const appendSamples = [];
    for (let i = 0; i < TYPING_SAMPLES; i++) {
      const main = get().mainLines;
      const t0 = performance.now();
      void [...main];
      spreadSamples.push(performance.now() - t0);
      const tail = get().streamTail;
      const ms = get().mainCodeState;
      const ts = get().streamTailCodeState;
      const t1 = performance.now();
      void main.slice(0, -1).concat(tail);
      void ms.slice(0, -1).concat(ts);
      materializeSamples.push(performance.now() - t1);
      const tree = get().lineOffsets;
      const t2 = performance.now();
      tree.clone();
      cloneSamples.push(performance.now() - t2);
      const t3 = performance.now();
      get().appendText('W');
      appendSamples.push(performance.now() - t3);
    }
    const metrics = {
      appendAt1M: {
        mainArrayRefChanged: mainBefore !== mainAfter,
        streamTailLen: get().streamTail.length,
        spreadCopyMs: summarizeSamples(spreadSamples),
        materializeProbeMs: summarizeSamples(materializeSamples),
        offsetsCloneMs: summarizeSamples(cloneSamples),
        appendTotalMs: summarizeSamples(appendSamples),
        appendDataNetMs: Number(Math.max(0, median(appendSamples) - median(materializeSamples)).toFixed(3)),
      },
    };

    // 2) store 层击键（50 万行第 25 万行）
    await loadDoc(TYPING_DOC_LINES, LOAD_TIMEOUT_BY_SIZE[500000]);
    get().flushStreamTail();
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
      fullChainMs: null,
      offsetUsed: off,
    };

    // 3) 流式吞吐回放（四场景，8 token/chunk，验证数据层承载 + 文本正确性）
    const createGen = eval('(' + GEN_SRC + ')');
    const chunkSize = 8;
    const runStoreScenario = (scenario, initText, withEdits) => {
      const gen = createGen(scenario);
      const expectedTokens = TOKENS_PER_SECOND * (DURATION_MS / 1000);
      get().setText(initText);
      while (get().getLineCount() !== (initText.length === 0 ? 1 : initText.split('\n').length)) {}
      const editInterval = (EDIT_INTERVAL_MS / 1000) * TOKENS_PER_SECOND;
      const basePos = Math.floor(initText.length / 2);
      let modelEdits = '';
      let edits = 0;
      let modelStream = '';
      const chunkCosts = [];
      let injected = 0;
      const t0 = performance.now();
      while (injected < expectedTokens) {
        let c = '';
        for (let k = 0; k < chunkSize && injected < expectedTokens; k++) {
          const t = gen();
          c += t;
          modelStream += t;
          injected++;
        }
        if (withEdits && injected >= (edits + 1) * editInterval && edits < 30) {
          edits++;
          const text = 'U' + edits + '。';
          get().setCursorPos(basePos + modelEdits.length);
          get().insertText(text);
          modelEdits += text;
        }
        const c0 = performance.now();
        get().appendText(c);
        chunkCosts.push(performance.now() - c0);
      }
      const totalMs = performance.now() - t0;
      get().flushStreamTail();
      const finalText = get().getText();
      const expected = initText.slice(0, basePos) + modelEdits + initText.slice(basePos) + modelStream;
      const sorted = chunkCosts.slice().sort((a, b) => a - b);
      return {
        scenario,
        injectedTokens: injected,
        edits,
        textLength: get().textLength,
        textMatch: finalText === expected,
        consistency: get().verifyConsistency(),
        storeRunMs: Number(totalMs.toFixed(1)),
        chunkMs: {
          count: chunkCosts.length,
          p50: Number((sorted[Math.floor(sorted.length * 0.5)] ?? NaN).toFixed(3)),
          p95: Number((sorted[Math.floor(sorted.length * 0.95)] ?? NaN).toFixed(3)),
        },
      };
    };
    metrics.streamNode = {
      'A-plain': runStoreScenario('plain', '', false),
      'B-code-fence': runStoreScenario('code', '', false),
      'C-math-fence': runStoreScenario('math', '', false),
      'D-edit-during-stream': runStoreScenario('edit', genInitText(), true),
    };
    for (const [k, v] of Object.entries(metrics.streamNode)) {
      console.log(`[final][node] 场景 ${k}：token=${v.injectedTokens} chunkP50=${v.chunkMs.p50}ms chunkP95=${v.chunkMs.p95}ms 总=${v.storeRunMs}ms 文本一致=${v.textMatch}`);
    }

    return { environment, metrics };
  } finally {
    await server.close();
  }
}

// ---- 最终对比表（R0 → R2 → 终验 + 变化率 + fps 档位）------------------------
function printComparison(final) {
  let r0 = null;
  let r2 = null;
  let r3gpu = null;
  try {
    r0 = JSON.parse(fs.readFileSync(R0_JSON, 'utf8'));
  } catch {
    console.log('[final] 未找到 R0 基线文件，跳过对比表');
    return;
  }
  try {
    r2 = JSON.parse(fs.readFileSync(R2_JSON, 'utf8'));
  } catch {
    console.log('[final] 未找到 R2 重测文件，R2 列置空');
  }
  try {
    const r3 = JSON.parse(fs.readFileSync(R3_JSON, 'utf8'));
    // R3 GPU 轮 = runs 中 headed=true 的最新一轮
    r3gpu = (r3.runs || []).filter((x) => x.headed === true).pop() || null;
  } catch {
    console.log('[final] 未找到 R3 报告文件，R3 GPU 流式参考置空');
  }

  const m0 = r0.metrics;
  const m2 = r2 ? r2.metrics : null;
  // final 参数可能是完整 report（含 metrics 字段），也可能是纯 metrics 对象
  const mf = final && final.metrics ? final.metrics : final;

  console.log('\n========== R6 终验最终对比表（R0 → R2 → 终验）==========');
  const row = (name, v0, v2, vf, extra = '') => {
    const f = (v) => (v == null || v === '' ? '—' : String(v));
    console.log(`${name.padEnd(30)} R0=${f(v0).padStart(10)}  R2=${f(v2).padStart(10)}  终验=${f(vf).padStart(10)}  ${extra}`);
  };
  const twoRate = (a, b, c) => {
    const r02 = pctChg(a, b);
    const r2f = pctChg(b, c);
    const r0f = pctChg(a, c);
    let s = '';
    if (r0f !== null) s += `R0→终验 ${r0f}%`;
    if (r2f !== null) s += (s ? ' | ' : '') + `R2→终验 ${r2f}%`;
    return s;
  };

  // 1) 百万行加载
  row('百万行加载 ms', m0?.load1MLines?.elapsedMs, m2?.load1MLines?.elapsedMs, mf?.load1MLines?.elapsedMs, twoRate(m0?.load1MLines?.elapsedMs, m2?.load1MLines?.elapsedMs, mf?.load1MLines?.elapsedMs));
  // 2) append@1M 端到端 / 净值
  row('append@1M 端到端 ms', m0?.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000)?.appendTotalMs?.medianMs, m2?.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000)?.appendTotalMs?.medianMs, mf?.appendAt1M?.appendTotalMs?.medianMs, twoRate(m0?.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000)?.appendTotalMs?.medianMs, m2?.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000)?.appendTotalMs?.medianMs, mf?.appendAt1M?.appendTotalMs?.medianMs));
  row('append@1M 数据层净值 ms', 'n/a(R0:浅拷贝0.5+clone1.1)', m2?.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000)?.appendDataNetMs, mf?.appendAt1M?.appendDataNetMs, 'R2-BD 访问器切换后真实净值');
  row('append@1M 主数组重建', m0?.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000)?.arrayRefChanged, m2?.appendCopyCurve?.perSize?.find((p) => p.size === 1_000_000)?.mainArrayRefChanged, mf?.appendAt1M?.mainArrayRefChanged, 'false = 尾段零拷贝成立');
  // 3) 击键
  row('击键 store 层中位 ms', m0?.typingAtMiddle?.storeLayerMs?.medianMs, m2?.typingAtMiddle?.storeLayerMs?.medianMs, mf?.typingAtMiddle?.storeLayerMs?.medianMs, twoRate(m0?.typingAtMiddle?.storeLayerMs?.medianMs, m2?.typingAtMiddle?.storeLayerMs?.medianMs, mf?.typingAtMiddle?.storeLayerMs?.medianMs));
  row('击键全链路中位 ms', m0?.typingAtMiddle?.fullChainMs?.medianMs, m2?.typingAtMiddle?.fullChainMs?.medianMs, mf?.typingAtMiddle?.fullChainMs?.medianMs, twoRate(m0?.typingAtMiddle?.fullChainMs?.medianMs, m2?.typingAtMiddle?.fullChainMs?.medianMs, mf?.typingAtMiddle?.fullChainMs?.medianMs));
  // 4) ArrowLeft
  row('ArrowLeft 均值 ms/键', m0?.arrowLeft?.avgMs, m2?.arrowLeft?.avgMs, mf?.arrowLeft?.avgMs, twoRate(m0?.arrowLeft?.avgMs, m2?.arrowLeft?.avgMs, mf?.arrowLeft?.avgMs));
  row('ArrowLeft P95 ms/键', m0?.arrowLeft?.p95Ms, m2?.arrowLeft?.p95Ms, mf?.arrowLeft?.p95Ms, twoRate(m0?.arrowLeft?.p95Ms, m2?.arrowLeft?.p95Ms, mf?.arrowLeft?.p95Ms));
  // 5) 滚动帧
  row('滚动帧 P50 ms', m0?.scrollFrames?.intervalP50Ms, m2?.scrollFrames?.intervalP50Ms, mf?.scrollFrames?.intervalP50Ms, twoRate(m0?.scrollFrames?.intervalP50Ms, m2?.scrollFrames?.intervalP50Ms, mf?.scrollFrames?.intervalP50Ms));
  row('滚动帧 P95 ms', m0?.scrollFrames?.intervalP95Ms, m2?.scrollFrames?.intervalP95Ms, mf?.scrollFrames?.intervalP95Ms, twoRate(m0?.scrollFrames?.intervalP95Ms, m2?.scrollFrames?.intervalP95Ms, mf?.scrollFrames?.intervalP95Ms));
  row('滚动帧 P99 ms', m0?.scrollFrames?.intervalP99Ms, m2?.scrollFrames?.intervalP99Ms, mf?.scrollFrames?.intervalP99Ms, '');
  row('滚动 layoutThrash 增量', m0?.scrollFrames?.layoutThrashDelta, m2?.scrollFrames?.layoutThrashDelta, mf?.scrollFrames?.layoutThrashDelta, twoRate(m0?.scrollFrames?.layoutThrashDelta, m2?.scrollFrames?.layoutThrashDelta, mf?.scrollFrames?.layoutThrashDelta));
  row('滚动长任务计数', '未采集(R0)', '未采集(R2)', mf?.scrollFrames?.longTasks ? `${mf.scrollFrames.longTasks.count} 次（${mf.scrollFrames.longTasks.totalMs}ms）` : '—', '终验新增探针');
  // 6) 流式四场景（GPU 轮）对比 R3 GPU
  const sf = mf?.stream || null;
  if (sf && r3gpu) {
    console.log('\n--- 流式四场景（GPU）vs R3 GPU 轮 ---');
    for (const [k, v] of Object.entries(sf.scenarios)) {
      const g = r3gpu.scenarios[k];
      const f2 = v.frames;
      const g2 = g ? g.frames : null;
      const band = fpsBand(f2.p50, f2.p95, 120);
      row(`流式 ${k} P95 ms`, g2 ? g2.p95 : null, null, Number(f2.p95.toFixed(2)), `R3→终验 ${pctChg(g2?.p95, f2.p95) ?? '—'}% | ${band.band}（等效 ${band.actualHz}Hz）`);
      row(`流式 ${k} 长任务`, g ? `${g.longTasks.count} 次` : null, null, `${v.longTasks.count} 次（${v.longTasks.totalMs}ms）`, `文本一致=${v.textMatch}`);
      if (v.heap && v.heap.startMB !== null) {
        const grow = Number((v.heap.endMB - v.heap.startMB).toFixed(1));
        row(`流式 ${k} 堆增长 MB`, null, null, `${v.heap.startMB}→${v.heap.endMB}（+${grow}，峰值${v.heap.peakMB}）`, '60s 注入后 JS 堆稳态');
      }
    }
  }
  console.log('==========================================================');
}

// ---- 主流程：headless 交互项 + GPU 流式（浏览器优先，node 降级兜底）---------
async function main() {
  // --compare-only：不重新采集，仅用已落盘数据产物重打最终对比表
  const compareOnly = process.argv.includes('--compare-only');
  if (compareOnly) {
    if (!fs.existsSync(OUT_JSON)) {
      throw new Error(`--compare-only 需要已有产物 ${path.basename(OUT_JSON)}，请先跑完整采集`);
    }
    const prev = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
    console.log(`[final] 对比模式：复用 ${path.basename(OUT_JSON)}（采集于 ${prev.collectedAt}）`);
    printComparison(prev);
    return prev;
  }

  let mode = 'browser';
  const report = {
    schema: 'conex-r6-final-verify/v1',
    collectedAt: new Date().toISOString(),
    params: {
      typingDocLines: TYPING_DOC_LINES,
      typingLineIndex: TYPING_LINE_INDEX,
      typingSamples: TYPING_SAMPLES,
      arrowCount: ARROW_COUNT,
      scrollDurationMs: SCROLL_DURATION_MS,
      tokensPerSecond: TOKENS_PER_SECOND,
      streamDurationMs: DURATION_MS,
      frameBudgetMs: FRAME_BUDGET_MS,
      editIntervalMs: EDIT_INTERVAL_MS,
    },
    environment: {
      platform: os.platform(),
      nodeVersion: process.version,
      serverBase: BASE_URL,
    },
    metrics: {},
    notes: [],
  };

  const notes = report.notes;
  notes.push('终验口径：交互项（滚动/击键/Arrow/加载）headless 同 R0/R2；流式 GPU 有头优先（R3-D 同款注入源码内嵌复用）');
  notes.push('R3-B1 访问器切换已落地（MarkdownEngine 不再订阅 state.lines）；KNOWN-DEFECT（R2-G）已修复（applyChange 前置 mergeTailInto + 显式清空尾段键）；R5.5 宿主 streamAppend 接线未落地，流式注入仍走 store.appendText 回落等价路径，口径保守');
  notes.push('materializeViews 仍在 set 热路径（EditorStore.ts:1003）：流式期间 tail 非空时每次 setState 仍 O(全文) concat 物化——append 端到端预期含此过渡期成本，实测为准');

  try {
    if (nodeOnly) throw new Error('显式指定降级模式');
    if (!streamOnly) {
      // 阶段 1：headless 交互项
      console.log('\n[final] === 阶段 1：headless 交互项（滚动/击键/Arrow/加载/append@1M）===');
      const interact = await runInteractiveMode();
      report.metrics = { ...report.metrics, ...interact.metrics };
      report.environment = { ...report.environment, ...interact.environment };
      console.log(`[final] 阶段 1 完成：headless（${interact.environment.ua.slice(0, 60)}...）`);
    }
    if (!interactiveOnly) {
      // 阶段 2：GPU 流式四场景（GPU 优先，失败可 --stream-headless 重跑）
      console.log('\n[final] === 阶段 2：流式四场景（500 token/s × 60s，GPU 优先）===');
      const stream = await runStreamMode();
      report.metrics.stream = {
        headed: stream.headed,
        results: stream.results,
        scenarios: stream.results,
      };
      report.environment = { ...report.environment, ...stream.environment };
      console.log(`[final] 阶段 2 完成：${stream.headed ? 'GPU' : 'headless'} 流式`);
    }
  } catch (err) {
    notes.push(`浏览器模式失败（${err.message}），node 降级模式兜底`);
    console.log(`[final] 浏览器模式失败（${err.message}），降级为 node store 层回放...`);
    mode = 'node';
    const nodeData = await runNodeMode();
    report.metrics = { ...report.metrics, ...nodeData.metrics };
    report.environment = { ...report.environment, ...nodeData.environment };
    notes.push('node 降级口径：仅 store 层数据吞吐与正确性回放；帧间隔/长任务/JS 堆未采集');
  }
  report.mode = mode;

  // 部分模式（--interactive-only / --stream-only）与已有产物合并：
  // 保留旧产物中本次未采集的指标键，避免单场景重跑覆盖完整数据
  const partialMode = interactiveOnly || streamOnly;
  if (partialMode && fs.existsSync(OUT_JSON)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
      if (prev.schema === 'conex-r6-final-verify/v1' && prev.metrics) {
        report.metrics = { ...prev.metrics, ...report.metrics };
        console.log(`[final] 部分模式：已与既有产物合并（保留旧指标键）`);
      }
    } catch {
      // 旧产物不可读则直接覆盖
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n[final] 结果已写入 ${OUT_JSON}`);

  // 汇总打印
  const m = report.metrics;
  console.log('\n========== R6 终验复测汇总 ==========');
  if (m.load1MLines) console.log(`百万行加载: ${m.load1MLines.elapsedMs} ms (ok=${m.load1MLines.ok})`);
  if (m.typingAtMiddle) {
    console.log(`中部击键 store 层: 中位 ${m.typingAtMiddle.storeLayerMs.medianMs} ms；全链路: 中位 ${m.typingAtMiddle.fullChainMs ? m.typingAtMiddle.fullChainMs.medianMs + ' ms' : '未采集'}`);
  }
  if (m.arrowLeft && m.arrowLeft.samples?.length > 0) {
    console.log(`ArrowLeft×${m.arrowLeft.count}: 均值 ${m.arrowLeft.avgMs} ms/键, P95 ${m.arrowLeft.p95Ms} ms`);
  }
  if (m.appendAt1M) {
    console.log(`append@1M: 端到端中位 ${m.appendAt1M.appendTotalMs.medianMs} ms / 净值 ${m.appendAt1M.appendDataNetMs} ms / 物化 ${m.appendAt1M.materializeProbeMs.medianMs} ms / 主数组重建=${m.appendAt1M.mainArrayRefChanged}`);
  }
  if (m.scrollFrames) {
    console.log(`滚动帧: P50 ${m.scrollFrames.intervalP50Ms} ms / P95 ${m.scrollFrames.intervalP95Ms} ms / P99 ${m.scrollFrames.intervalP99Ms} ms, >16.7ms ${m.scrollFrames.framesOver16_7}/${m.scrollFrames.frameCount}, layoutThrash +${m.scrollFrames.layoutThrashDelta}, 长任务 ${m.scrollFrames.longTasks.count} 次`);
  }
  if (m.stream) {
    console.log(`流式（${m.stream.headed ? 'GPU' : 'headless'}）：`);
    for (const [k, v] of Object.entries(m.stream.scenarios)) {
      const f2 = v.frames;
      const band = fpsBand(f2.p50, f2.p95, m.stream.headed ? 120 : 60);
      console.log(`  [${k}] 帧 P50 ${f2.p50.toFixed(2)}ms / P95 ${f2.p95.toFixed(2)}ms / P99 ${f2.p99.toFixed(2)}ms | 长任务 ${v.longTasks.count} 次 | 文本一致 ${v.textMatch} | ${band.band}（等效 ${band.actualHz}Hz）`);
      if (v.heap && v.heap.startMB !== null) {
        console.log(`   堆 ${v.heap.startMB}→${v.heap.endMB}MB（+${Number((v.heap.endMB - v.heap.startMB).toFixed(1))}MB，峰值 ${v.heap.peakMB}MB）`);
      }
    }
  }
  console.log('===========================================');

  printComparison(report);
  return report;
}

main().catch((err) => {
  console.error(`[final] 采集失败：${err.message}`);
  process.exit(1);
});
