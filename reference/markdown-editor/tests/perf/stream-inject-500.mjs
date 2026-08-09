// tests/perf/stream-inject-500.mjs
// R3-D 流式轮验证：500 token/s 注入压测（四场景）
//
// 背景：验证「500 token/s 流式 + 60fps 保底（P95 < 16.6ms）」目标。
// 对齐 docs/analysis/01-性能帧率路线.md：
// - 帧预算口径：500 token/s 注入，rAF 采样帧间隔 P95 < 16.6ms（60fps 保底）；
// - 流式专项预算（§4.3）：StreamBuffer 按 rAF 合并，每帧注入 ≤1 个 chunk，
//   每 chunk 数据层 COW O(尾段)（≤0.6ms），行渲染仅新增行；
// - 注入形态（§4.1 流式帧）：LLM 单次吐 token → push → 每帧 1 chunk → appendText。
//
// 现状接线说明（R3-D 核实）：App.tsx 未把 MarkdownEngine 的 engineRef 暴露到
// window（R5 宿主 streamAppend/streamEnd 接线未落地），故浏览器注入走
// store.appendText 常规路径——即 streamAppend 的「回落等价路径」
// （MarkdownEngine.tsx:364-368：非直刷情形 = flushStreamInternal + appendText），
// C3 直刷（纯文本末行命令式 DOM 写）不在本次压测范围；appendText 路径比直刷
// 更重，口径保守。收口用 store.flushStreamTail()（= streamEnd 的 stop-flush 语义，
// EditorStore.ts:1084）。
//
// 场景（500 token/s、持续 60s ≈ 3 万 token）：
//   A 纯文本流式        ：文本 token（每 8 token 一个换行）
//   B 代码块中途闭合    ：流式中周期性 ``` 开/闭 fence（fence 字符在
//                          DIRECT_STREAM_FORBIDDEN_CHARS 内 → 必走软渲染路径）
//   C 公式块中途闭合    ：流式中周期性 $$ 开/闭 fence（同上）
//   D 流式 + 用户编辑   ：流式期间每 2s 一次 insertText 到文档中部
//                         正确性断言：最终 getText() 与页面内参考模型完全一致
//                         （无丢字/乱序）+ 帧率判定
//
// 判定：P95 帧间隔 < 16.6ms 为 PASS；场景 D 附加文本一致性断言。
// 附注：60Hz 名义帧间隔为 16.67ms，P95 落在 [16.6, 16.7] 区间属「无掉帧」
// 名义帧，本脚本按任务口径（<16.6）严格判定，同时报告 >16.7ms / >33.3ms
// 掉帧率与长任务/堆数据供主 Agent 综合裁决。
//
// 用法：
//   node tests/perf/stream-inject-500.mjs                浏览器模式（默认）
//   node tests/perf/stream-inject-500.mjs --node-only    强制 node 降级模式
//   node tests/perf/stream-inject-500.mjs --no-browser   跳过浏览器探测直接降级
//
// 环境变量：
//   PERF_BASE_URL      覆盖 dev server 地址（默认 http://localhost:5173）
//   STREAM_DURATION_MS 覆盖注入时长（默认 60000）
//   STREAM_TPS         覆盖注入速率 token/s（默认 500）
//   PERF_HEADED=1      使用有头浏览器（GPU 渲染）复测——headless 为软件渲染，
//                      帧间隔偏保守（R2 重测已证实 headless layout/paint 惩罚），
//                      有头模式用于对比验证帧率结论是否受渲染后端影响。
//
// 产物：stream-inject-report.json（本脚本写入）+ README.md（追加流式章节）。
// 纪律：编码 UTF-8 无 BOM；中文注释；不 commit。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_JSON = path.join(__dirname, 'stream-inject-report.json');
const BASE_URL = process.env.PERF_BASE_URL || 'http://localhost:5173';

const nodeOnly = process.argv.includes('--node-only');
const skipBrowser = process.argv.includes('--no-browser');

// ---- 基准参数 -------------------------------------------------------------
// 注入速率与时长（env 可覆盖，默认 500 token/s × 60s = 3 万 token）
const TOKENS_PER_SECOND = Number(process.env.STREAM_TPS || 500);
const DURATION_MS = Number(process.env.STREAM_DURATION_MS || 60_000);
// 60fps 保底判定阈值（任务口径：P95 帧 < 16.6ms）
const FRAME_BUDGET_MS = 16.6;
// 场景 D 用户编辑间隔（每 2s 一次 insertText 到中部）
const EDIT_INTERVAL_MS = 2_000;
// 每 chunk 的数据层计时口径：页面内 performance.now() 环绕 appendText
const CHUNK_SAMPLE_COUNT = 0; // 占位：实际在页面内收集，此处仅声明口径

// ---- 通用统计工具（与 baseline-collect 同款）-------------------------------
function pct(arr, p) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function mean(arr) {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ---- token 生成器源码（浏览器页面 / node 降级同源共用）---------------------
// 必须自包含（不引用任何模块/作用域符号），页面内用 new Function 实例化。
// 生成器为确定性迭代器：next() 每次返回一个 token 字符串。
// - 文本 token：中文单词池循环取，每 8 个文本 token 附带一个换行（模拟
//   自然语言流式换行，约 62 行/s，对齐 01 文档 §4.3「60-80 行/秒」量级）；
// - 场景 B：每 40 个 token 插入一个代码块段（```js 开 fence + 3 行代码 +
//   闭 fence，段内 token 逐字到达 = fence 中途闭合的软渲染路径）；
// - 场景 C：每 60 个 token 插入一个公式块段（$$ 开 fence + 2 行公式 + 闭 fence）。
const GEN_SRC = `
function createTokenGen(scenario) {
  var words = ['流式','注入','引擎','渲染','性能','帧率','预算','解析','增量','合并','光标','选区','撤销','重做','虚拟','滚动','测量','回填','样本','缓存','线程','提交','布局','绘制','采样','统计','判定','预算','达标','回落'];
  // 块段序列（scenario 决定）：fence 与代码/公式内容逐 token 到达（中途闭合）
  var CODE_SEG = ['\`\`\`js\\n', 'const a = 1;\\n', 'a + b = 3;\\n', 'console.log(a);\\n', '\`\`\`\\n'];
  var MATH_SEG = ['$$\\n', 'x_i^2 + y_i^2 = r^2\\n', '\\\\sum_{i=1}^n i = n(n+1)/2\\n', '$$\\n'];
  var seg = scenario === 'code' ? CODE_SEG : scenario === 'math' ? MATH_SEG : null;
  var segEvery = scenario === 'code' ? 40 : 60;
  var segPos = seg ? 0 : null;   // 当前块段内下标；null = 不在段内
  // 当前块段的起始 token 号（段退出后保留：n - segAt < segEvery 时保持文本流，
  // 满周期再进新段。R3-D 实测踩坑：此前退出时把 segAt 重置为 -1，导致
  // n - (-1) >= segEvery 恒真，fence 段连续不断、文本 token 全部消失——
  // 场景 B 文档被污染为纯代码块序列（30 万字符），帧数据失真）
  var segAt = -1;
  var n = 0;                     // 已产出 token 数
  var w = 0;                     // 单词池循环下标
  var nl = 0;                    // 距上次换行的文本 token 数
  return function next() {
    var t;
    if (segPos !== null) {
      // 块段内：逐 token 吐出段序列（segAt 保留，退出后回到文本流）
      t = seg[segPos++];
      if (segPos >= seg.length) { segPos = null; }
    } else if (seg && n - segAt >= segEvery) {
      // 进入新块段（记录段起点；段内 token 也计入 n，周期按总 token 数计）
      segAt = n;
      segPos = 0;
      t = seg[segPos++];
      if (segPos >= seg.length) { segPos = null; }
    } else {
      // 普通文本 token
      t = words[w++ % words.length];
      nl++;
      if (nl >= 8) { t += '\\n'; nl = 0; }
    }
    n++;
    return t;
  };
}
`;

// ---- 场景 D 初始文档（页面/node 同源：100 行确定性中文文本）---------------
// 编辑位置 = 第 50 行中段（initText.length / 2 附近），远离文档末尾，
// 使 appendText 的「追加点前移」判定恒不触发（光标不在逻辑末行），
// 与流式追加（全文末尾）互不干扰——正是「用户编辑中部 + 流追尾」的标准场景。
function genInitText() {
  const arr = [];
  for (let i = 0; i < 100; i++) {
    arr.push('初始文档第' + i + '行：这是用于流式期间用户编辑正确性验证的稳定文本内容。');
  }
  return arr.join('\n');
}

// ---- 页面端主函数源码（Playwright evaluate 执行；与 node 模式同源注入）----
// 结构：
//  1. setText(initText) 重置文档并等待落定；
//  2. 启动帧采样（rAF 连续打点）+ longtask 观察 + 堆轮询（1s 间隔）；
//  3. 注入调度：setInterval(1ms) + 时间戳驱动（500 token/s 精确节拍），
//     token 经「内联 StreamBuffer」（rAF 合并）→ 每帧 1 chunk → appendText；
//  4. 场景 D：setInterval(2s) 用户编辑（setCursorPos + insertText 到中部）；
//  5. durationMs 后停止注入 → flush 累积 → flushStreamTail（= streamEnd 语义）
//     → 等待渲染落定 → 校验（文本模型一致 / 长度 / verifyConsistency）；
//  6. 返回 { frames, longTasks, heap, chunkMs, tokenCount, correctness, ... }。
// 所有计时均为页面内 performance.now()，规避 Playwright 外部计时污染。
const PAGE_FN_SRC = `
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

  // ---- 1. 重置文档并等待落定 ----
  var initLines = initText.length === 0 ? 1 : initText.split('\\n').length;
  get().setText(initText);
  var deadline = performance.now() + 10000;
  while (get().getLineCount() !== initLines && performance.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 15); });
  }
  // 等待一帧让重置渲染落定
  await new Promise(function (r) { requestAnimationFrame(r); });

  // ---- 2. 参考模型（页面内与注入同步构建的确定性预期）----
  // 流内容 = 全部 token 序列拼接；用户编辑 = 中部插入序列。
  // 预期终态 = initText 在固定点插入全部用户编辑 + 流内容追加到全文末尾
  // （追加点恒在末尾：光标在中部，appendText 追加点前移判定不触发）。
  // 注意：生成器源码经 eval 函数表达式注入（new Function 为全局作用域，
  // 无法访问本函数的 scenario 局部变量，已踩坑）。
  var createTokenGen = eval('(' + ${JSON.stringify(GEN_SRC)} + ')');
  var gen = createTokenGen(scenario);
  var modelStream = '';
  var modelEdits = '';
  var tokenCount = 0;

  // ---- 3. 内联 StreamBuffer（镜像 src/core/StreamBuffer.ts：rAF 合并）----
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

  // ---- 4. 长任务观察（PerformanceObserver('longtask')）----
  var longTasks = [];
  var ltObserver = null;
  try {
    ltObserver = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) longTasks.push(entries[i].duration);
    });
    ltObserver.observe({ entryTypes: ['longtask'] });
  } catch (e) { /* 环境不支持时降级为空采集 */ }

  // ---- 5. 堆轮询（每 1s 采样一次 usedJSHeapSize）----
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

  // ---- 6. 注入调度（时间戳驱动精确 500 token/s）----
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

  // ---- 7. 场景 D 用户编辑（每 2s 一次 insertText 到中部）----
  if (scenario === 'edit') {
    editTimer = setInterval(function () {
      if (stopped) { clearInterval(editTimer); return; }
      edits++;
      var text = 'U' + edits + '。';
      get().setCursorPos(editPos);
      get().insertText(text);
      modelEdits += text;
      editPos += text.length; // 光标自然推进（连续打字语义）
    }, editIntervalMs);
  }

  // ---- 8. 帧采样（rAF 连续打点，与注入同时运行）----
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

  // ---- 9. 收口（= streamEnd 语义）与落定等待 ----
  // flushBuf 幂等（无累积空操作）；flushStreamTail 合并尾段 + 登记
  // meta:'stream' 单步 undo op（EditorStore.ts:1084）。
  flushBuf();
  get().flushStreamTail();
  await new Promise(function (r) { requestAnimationFrame(r); });
  await new Promise(function (r) { setTimeout(r, 50); });

  // ---- 10. 观察者清理 ----
  if (ltObserver) { try { ltObserver.disconnect(); } catch (e) {} }
  if (heapTimer) clearInterval(heapTimer);
  if (editTimer) clearInterval(editTimer);
  clearInterval(injectTimer);

  // ---- 11. 校验与统计 ----
  var s = get();
  var finalText = s.getText();
  var expected = initText.slice(0, editPos - modelEdits.length)
    + modelEdits
    + initText.slice(editPos - modelEdits.length)
    + modelStream;
  // 注意：editPos 在编辑后已推进到「初始插入点 + 全部编辑长度」，
  // 故初始插入点 = editPos - modelEdits.length（仅场景 D 有效；A/B/C 中
  // modelEdits 恒为空串，expected = initText + modelStream）。
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

// ---- 工具：拉起 vite dev server（复刻 baseline-collect 的 Windows 修复）----
async function spawnDevServer() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['run', 'dev'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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

  const headed = process.env.PERF_HEADED === '1';
  const browser = await chromium.launch({ headless: !headed });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log(`[perf][pageerror] ${err.message}`));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__CRISH_SESSION_STORE__ !== 'undefined', null, { timeout: 30_000 });
    // 等待 App 初始大文档（100 × test-document）分块加载落定
    await page.waitForFunction(() => window.__CRISH_METRICS__.getLineCount() > 1000, null, { timeout: 120_000 });
    await page.waitForTimeout(1500);

    const environment = await page.evaluate(() => ({
      ua: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      language: navigator.language,
    }));

    // 场景定义：A 纯文本 / B 代码 fence / C 公式 fence / D 编辑+流式
    const scenarios = [
      { key: 'A-plain', scenario: 'plain', initText: '', editPos: 0 },
      { key: 'B-code-fence', scenario: 'code', initText: '', editPos: 0 },
      { key: 'C-math-fence', scenario: 'math', initText: '', editPos: 0 },
      { key: 'D-edit-during-stream', scenario: 'edit', initText: genInitText(), editPos: null },
    ];

    const pageRun = new Function(PAGE_FN_SRC + '\nreturn pageRunStream;')();
    const results = {};
    for (const sc of scenarios) {
      console.log(`[perf] 场景 ${sc.key}：500 token/s 注入 ${DURATION_MS / 1000}s 开始...`);
      const tRun0 = Date.now();
      const r = await page.evaluate(pageRun, {
        scenario: sc.scenario,
        initText: sc.initText,
        durationMs: DURATION_MS,
        tps: TOKENS_PER_SECOND,
        editIntervalMs: EDIT_INTERVAL_MS,
        // 场景 D 编辑位置：初始文档中部（第 50 行中段，远离末尾）
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
        `[perf] 场景 ${sc.key} 完成（${elapsedSec}s）：token=${r.injectedTokens} 帧=${f.count} ` +
        `P50=${f.p50.toFixed(2)}ms P95=${f.p95.toFixed(2)}ms P99=${f.p99.toFixed(2)}ms ` +
        `>16.7ms=${f.over16_7} >33.3ms=${f.over33_3} 长任务=${r.longTasks.count} ` +
        `文本一致=${r.textMatch} 判定=${verdict.pass ? 'PASS' : 'FAIL'}`
      );
    }

    return { environment, results };
  } finally {
    await browser.close();
    if (devChild) devChild.kill();
  }
}

// ---- node 降级模式（store 层数据吞吐 + 正确性；无浏览器帧率）---------------
// 口径说明：node 无 rAF/定时器精度限制，为节省真实等待时间采用「同步回放」——
// 按 8 token/chunk（= 60fps × 每帧 ~8.3 token 的帧合并形态）连续同步执行
// appendText，计时数据层每 chunk 成本；帧间隔/长任务/JS 堆标记未采集。
// 该模式验证的是「数据层能否承载 500 token/s」与四场景文本正确性，
// 不代表浏览器帧率结论。
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
    // 与浏览器模式同源：eval 函数表达式方式实例化生成器
    const createGen = eval('(' + GEN_SRC + ')');
    const chunkSize = 8; // 每 chunk token 数（对齐帧合并形态 500/60≈8.3）

    // 前置生成 token 数组（确定性，全场景共用同一生成器实例的序列）
    const tokenArray = [];
    {
      const g = createGen('plain');
      for (let i = 0; i < TOKENS_PER_SECOND * (DURATION_MS / 1000); i++) tokenArray.push(g());
    }

    const environment = {
      os: `${os.platform()} ${os.release()}`,
      node: process.version,
      cpus: os.cpus().length,
      arch: os.arch(),
    };

    // 四场景 store 层回放（每场景重置文档后同步跑完整 token 序列）
    const runStoreScenario = (scenario, initText, withEdits) => {
      const gen = createGen(scenario);
      const expectedTokens = TOKENS_PER_SECOND * (DURATION_MS / 1000);
      get().setText(initText);
      // 等待 setText 落定（小文档同步；防御分块）
      while (get().getLineCount() !== (initText.length === 0 ? 1 : initText.split('\n').length)) {
        // setText 小文档为同步路径，此循环理论不执行
      }
      // 用户编辑模型：每 2s 一次、每次插入后光标推进（与浏览器模式同构）
      const editInterval = EDIT_INTERVAL_MS / 1000 * (TOKENS_PER_SECOND); // 换算为 token 数间隔
      const basePos = Math.floor(initText.length / 2);
      let modelEdits = '';
      let edits = 0;
      let modelStream = '';
      let chunkCosts = [];
      let injected = 0;
      const t0 = performance.now();
      while (injected < expectedTokens) {
        // 模拟帧合并：攒 chunkSize 个 token 一次 append
        let c = '';
        for (let k = 0; k < chunkSize && injected < expectedTokens; k++) {
          const t = gen();
          c += t;
          modelStream += t;
          injected++;
        }
        // 用户编辑（按 token 位置触发，等价每 2s 一次）
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
      // 收口（= streamEnd 语义）
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

    const results = {
      'A-plain': runStoreScenario('plain', '', false),
      'B-code-fence': runStoreScenario('code', '', false),
      'C-math-fence': runStoreScenario('math', '', false),
      'D-edit-during-stream': runStoreScenario('edit', genInitText(), true),
    };

    for (const [k, v] of Object.entries(results)) {
      console.log(
        `[perf][node] 场景 ${k}：token=${v.injectedTokens} chunkP50=${v.chunkMs.p50}ms ` +
        `chunkP95=${v.chunkMs.p95}ms 总耗时=${v.storeRunMs}ms 文本一致=${v.textMatch}`
      );
    }
    return { environment, results };
  } finally {
    await server.close();
  }
}

// ---- 多轮运行累积工具 -------------------------------------------------------
// 读取旧报告中的 runs（仅同 schema 同参数），供本次 append；本轮数据恒为
// 顶层最新字段。旧 runs 中 params 不一致的轮次保留（如实记录，不丢弃）。
function loadPreviousRuns() {
  try {
    if (!fs.existsSync(OUT_JSON)) return [];
    const old = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
    if (old.schema === 'conex-r3d-stream-inject/v1' && Array.isArray(old.runs)) {
      return old.runs;
    }
    return [];
  } catch {
    return [];
  }
}

// 把本轮运行追加到 runs 尾部（上限 20 轮，防文件膨胀）
function appendRun(prev, run) {
  const runs = [...prev, run];
  return runs.length > 20 ? runs.slice(runs.length - 20) : runs;
}

// ---- 主流程（浏览器优先，失败自动降级 node）--------------------------------
async function main() {
  let mode = 'browser';
  let data = null;
  let fallbackError = null;
  const previousRuns = loadPreviousRuns();

  try {
    if (nodeOnly || skipBrowser) throw new Error('显式指定降级模式');
    data = await runBrowserMode();
  } catch (err) {
    fallbackError = err.message;
    console.log(`[perf] 浏览器模式失败（${err.message}），降级为 node store 层回放...`);
    mode = 'node';
    data = await runNodeMode();
  }

  const notes = [];
  if (mode === 'node') {
    notes.push('浏览器模式不可用，仅采集 store 层数据吞吐回放；帧间隔/长任务/JS 堆未采集');
    if (fallbackError) notes.push(`降级原因：${fallbackError}`);
    notes.push('node 同步回放口径：按 8 token/chunk 连续执行 appendText，验证数据层吞吐与文本正确性，不代表浏览器帧率');
  } else {
    notes.push('计时全部在页面内 performance.now() 完成，规避 Playwright 外部计时污染');
    notes.push('注入形态：token 级 push（500 token/s 时间戳节拍）经 rAF 合并为每帧 1 chunk → appendText，对齐 StreamBuffer 帧预算（01 文档 §4.3）');
    notes.push('接线说明：App.tsx 未暴露 engineRef（R5 宿主接线未落地），注入走 store.appendText 常规路径（streamAppend 回落等价路径），C3 直刷路径不在本次压测范围，口径保守');
    notes.push('判定口径：P95 < 16.6ms（60fps 保底）为 PASS；注意 60Hz 名义帧间隔 16.67ms，P95 落入 [16.6,16.7) 属名义帧无掉帧，请结合 >16.7ms/>33.3ms 掉帧率综合裁决');
  }
  notes.push(`注入参数：${TOKENS_PER_SECOND} token/s × ${DURATION_MS}ms ≈ ${Math.round(TOKENS_PER_SECOND * DURATION_MS / 1000)} token；场景 D 用户编辑间隔 ${EDIT_INTERVAL_MS}ms`);

  // 判定汇总（browser 模式才有帧数据；node 模式帧判定置 null）
  const scenariosOut = {};
  let allFramesOk = true;
  let anyFrameMetric = false;
  let scenarioDCorrect = null;
  for (const [key, r] of Object.entries(data.results)) {
    if (r.frames) {
      anyFrameMetric = true;
      if (!(r.frames.p95 < FRAME_BUDGET_MS)) allFramesOk = false;
    }
    if (key === 'D-edit-during-stream') scenarioDCorrect = r.textMatch === true;
    scenariosOut[key] = {
      scenario: r.scenario,
      injectedTokens: r.injectedTokens,
      edits: r.edits,
      textLength: r.textLength,
      finalTextChars: r.finalTextChars ?? null,
      expectedChars: r.expectedChars ?? null,
      textMatch: r.textMatch,
      consistency: r.consistency,
      storeRunMs: r.storeRunMs ?? null,
      frames: r.frames ?? null,
      longTasks: r.longTasks ?? null,
      heap: r.heap ?? null,
      chunkMs: r.chunkMs,
      verdict: r.verdict ?? (r.textMatch === true ? { pass: true, note: 'node 模式：文本一致通过，帧判定未采集' } : { pass: false }),
    };
  }

  const report = {
    schema: 'conex-r3d-stream-inject/v1',
    collectedAt: new Date().toISOString(),
    mode,
    // 渲染后端标记：headless（软件渲染，同 R0/R2 口径）/ headed（GPU 渲染）
    headed: process.env.PERF_HEADED === '1',
    params: {
      tokensPerSecond: TOKENS_PER_SECOND,
      durationMs: DURATION_MS,
      expectedTokens: Math.round(TOKENS_PER_SECOND * DURATION_MS / 1000),
      frameBudgetMs: FRAME_BUDGET_MS,
      editIntervalMs: EDIT_INTERVAL_MS,
    },
    environment: {
      platform: os.platform(),
      nodeVersion: process.version,
      serverBase: BASE_URL,
      ...data.environment,
    },
    scenarios: scenariosOut,
    verdict: {
      framesAllP95UnderBudget: anyFrameMetric ? allFramesOk : null,
      scenarioDTextCorrect: scenarioDCorrect,
      pass: (anyFrameMetric ? allFramesOk : true) && (scenarioDCorrect !== false),
    },
    // 多轮运行累积（同机 headless / GPU 对比轮）：每次运行 append 一条，
    // 顶层字段（scenarios/verdict/environment）恒为最新一轮
    runs: appendRun(
      previousRuns,
      {
        collectedAt: new Date().toISOString(),
        mode,
        headed: process.env.PERF_HEADED === '1',
        params: {
          tokensPerSecond: TOKENS_PER_SECOND,
          durationMs: DURATION_MS,
          expectedTokens: Math.round(TOKENS_PER_SECOND * DURATION_MS / 1000),
          frameBudgetMs: FRAME_BUDGET_MS,
          editIntervalMs: EDIT_INTERVAL_MS,
        },
        environment: {
          platform: os.platform(),
          nodeVersion: process.version,
          serverBase: BASE_URL,
          ...data.environment,
        },
        scenarios: scenariosOut,
        verdict: {
          framesAllP95UnderBudget: anyFrameMetric ? allFramesOk : null,
          scenarioDTextCorrect: scenarioDCorrect,
          pass: (anyFrameMetric ? allFramesOk : true) && (scenarioDCorrect !== false),
        },
      }
    ),
    notes,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n[perf] 结果已写入 ${OUT_JSON}`);

  // 汇总打印（供回报）
  console.log('\n========== R3-D 500 token/s 流式注入汇总 ==========');
  console.log(`模式：${mode}（${TOKENS_PER_SECOND} token/s × ${DURATION_MS / 1000}s ≈ ${report.params.expectedTokens} token）`);
  for (const [key, r] of Object.entries(scenariosOut)) {
    if (r.frames) {
      console.log(
        `[${key}] 帧 P50 ${r.frames.p50.toFixed(2)}ms / P95 ${r.frames.p95.toFixed(2)}ms / P99 ${r.frames.p99.toFixed(2)}ms` +
        ` | >16.7ms ${r.frames.over16_7}/${r.frames.count} | >33.3ms ${r.frames.over33_3}` +
        ` | 长任务 ${r.longTasks.count} 次(共${r.longTasks.totalMs}ms) | 堆 ${r.heap.startMB}→${r.heap.peakMB}MB` +
        ` | 文本一致 ${r.textMatch} | 判定 ${r.verdict?.pass ? 'PASS' : 'FAIL'}`
      );
    } else {
      console.log(`[${key}] node 回放：chunk P50 ${r.chunkMs.p50}ms / P95 ${r.chunkMs.p95}ms | 总 ${r.storeRunMs}ms | 文本一致 ${r.textMatch}`);
    }
  }
  if (scenarioDCorrect !== null) {
    console.log(`场景 D 正确性（文本一致）：${scenarioDCorrect ? '通过' : '失败'}`);
  }
  console.log('================================================');
  return report;
}

main().catch((err) => {
  console.error(`[perf] 采集失败：${err.message}`);
  process.exit(1);
});
