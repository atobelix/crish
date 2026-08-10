// tests/perf/suite/lib/env.mjs
// 环境指纹与运行环境治理（A6 §3.4 防抖）：
// - 环境指纹：UA / hardwareConcurrency / deviceMemory / CDP SystemInfo
//   GPU vendorId+renderer（headless SwiftShader vs GPU 判定）写入报告头部，
//   渲染后端归属可审计——「换环境不知道」风险治理；
// - dev server：检查可用性 → 自动拉起（既有脚本同款 Windows 修复）；
// - 浏览器：ci = headless；nightly/local = GPU 有头优先（A6 §3.3 分档）；
// - CDP 辅助：Performance.getMetrics 窗口增量（M1b L1）、
//   HeapProfiler.collectGarbage + 5s 冷却（防跨场景残留）、
//   Tracing 3s 窗口（M1b L2，nightly 专属，失败 warn 降级）；
// - 运行期守卫：场景间 GC + 冷却（A6 §3.4 第 5 条）。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..'); // tests/perf/suite → 仓库根

/** 默认 dev server 地址（对齐现有 e2e 的 5174 口径，见 playwright.config.ts） */
export const DEFAULT_BASE_URL = 'http://localhost:5174';

/** 档位常量（A6 §3.3；命名继承 VITEST_PERF_TIER 既有口径） */
export const TIERS = ['ci', 'nightly', 'local'];

/** 解析档位：环境变量 PERF_TIER 优先，其次 --tier 参数，默认 ci */
export function resolveTier(args) {
  const envTier = String(process.env.PERF_TIER || '').trim().toLowerCase();
  if (TIERS.includes(envTier)) return envTier;
  const argIdx = args.indexOf('--tier');
  if (argIdx !== -1 && args[argIdx + 1] && TIERS.includes(args[argIdx + 1].toLowerCase())) {
    return args[argIdx + 1].toLowerCase();
  }
  return 'ci';
}

/** 解析 dev server 地址：PERF_BASE_URL 优先，默认 5174 */
export function resolveBaseUrl() {
  return process.env.PERF_BASE_URL || DEFAULT_BASE_URL;
}

/** 检查 dev server 是否可用（fetch 探测；超时即认为不可用） */
export async function checkServer(url, timeoutMs = 3000) {
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

/**
 * 拉起 vite dev server（既有脚本同款 Windows 修复：cmd.exe /c npm run dev）。
 * 返回子进程句柄；调用方在结束时 kill。
 */
export async function spawnDevServer(baseUrl, timeoutMs = 40_000) {
  // Windows 修复（final-verify 同款）：cmd.exe /c 包裹 npm，规避
  // npm.cmd 直 spawn 在部分环境下的 EINVAL
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await checkServer(baseUrl)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`自动启动 vite 失败：${timeoutMs / 1000} 秒内 ${baseUrl} 未就绪`);
}

/** 确保 dev server 可用（已有或自动拉起），返回 { serverOk, devChild } */
export async function ensureServer(baseUrl) {
  let devChild = null;
  if (await checkServer(baseUrl)) return { serverOk: true, devChild: null };
  console.log(`[suite] ${baseUrl} 不可用，尝试自动启动 vite...`);
  try {
    devChild = await spawnDevServer(baseUrl);
    return { serverOk: true, devChild };
  } catch (err) {
    console.log(`[suite] 自动启动失败：${err.message}`);
    return { serverOk: false, devChild: null };
  }
}

/**
 * 按档位启动浏览器：
 * - ci：headless（软件渲染，M1b 阈值按 ci 档 20ms）；
 * - nightly / local：GPU 有头优先（60Hz 名义刷新率，120/140 档可达）。
 */
export async function launchBrowser(tier) {
  const { chromium } = await import('playwright');
  const headed = tier !== 'ci';
  return chromium.launch({ headless: !headed });
}

/**
 * 环境指纹采集（浏览器侧 + CDP SystemInfo）：
 * 返回 { ua, hardwareConcurrency, deviceMemory, platform, nodeVersion,
 *         serverBase, gpu: { vendorId, renderer, available } }。
 * CDP 不可用时 gpu 置 null 并返回 warnings（降级不阻塞，A6 §5.1 口径）。
 * 注意：SystemInfo.getInfo 仅浏览器级 target 支持（page 级 CDP session
 * 会报 Protocol error），故 browserCdp 优先、pageCdp 兜底。
 */
export async function collectEnvironment(page, baseUrl, pageCdp, browserCdp) {
  const pageEnv = await page.evaluate(() => ({
    ua: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: navigator.deviceMemory || null,
    language: navigator.language,
  }));
  const environment = {
    platform: process.platform,
    nodeVersion: process.version,
    serverBase: baseUrl,
    ...pageEnv,
    gpu: null,
    cdp: null,
  };
  const cdp = browserCdp || pageCdp;
  if (cdp) {
    try {
      const info = await cdp.send('SystemInfo.getInfo');
      const gpu = info.gpu || {};
      const device = (gpu.devices || [])[0] || {};
      environment.gpu = {
        vendorId: device.vendorId || null,
        deviceId: device.deviceId || null,
        renderer: gpu.renderer || null,
        // 硬件 GPU 判定：gpuActive 激活 且 非 SwiftShader（软件渲染）；
        // renderer 缺失（null）时按 gpuActive 判定（诚实：无证据不宣称）
        available: !!gpu.gpuActive && !/SwiftShader/i.test(gpu.renderer || ''),
        gpuActive: !!gpu.gpuActive,
      };
      environment.cdp = { model: info.modelName, os: info.osVersion, arch: info.arch };
    } catch (err) {
      environment.gpu = null;
      environment.cdpWarning = `SystemInfo 不可用：${err.message}`;
    }
  }
  return environment;
}

/**
 * CDP 会话建立（失败返回 null，调用方降级）：
 * - pageCdp：页面级（Performance.enable / HeapProfiler / Tracing）；
 * - browserCdp：浏览器级（SystemInfo.getInfo 专用）。
 * Playwright CDP 会话经 page.context().newCDPSession(page) 与
 * browser.newBrowserCDPSession() 建立。
 */
export async function createCdpSessions(browser, page) {
  let pageCdp = null;
  let browserCdp = null;
  try {
    pageCdp = await page.context().newCDPSession(page);
    await pageCdp.send('Performance.enable');
  } catch {
    pageCdp = null;
  }
  try {
    browserCdp = await browser.newBrowserCDPSession();
  } catch {
    browserCdp = null;
  }
  return { pageCdp, browserCdp };
}

/**
 * CDP Performance.getMetrics 窗口增量（M1b L1 采集）：
 * prev 为前一次读数（getCdpCounters 返回值）；返回
 * { taskMs, scriptMs, layoutMs, recalcMs, paintMs, layoutCount, recalcCount,
 *   elapsedMs, delta }（delta = 本窗口各字段增量）。
 */
export async function getCdpCounters(cdp) {
  const res = await cdp.send('Performance.getMetrics');
  const out = {};
  for (const m of res.metrics) {
    out[m.name] = m.value;
  }
  return out;
}

/** 取两个计数器快照的增量（秒级归一；prev 缺失返回 null） */
export function cdpDelta(prev, cur) {
  if (!prev || !cur) return null;
  const names = [
    'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration',
    'PaintDuration', 'LayoutCount', 'RecalcStyleCount', 'TimerHitCount',
  ];
  const delta = {};
  for (const n of names) {
    // 字段缺失按 0 增量计（Chrome 部分版本不暴露 PaintDuration 等——
    // 缺失即无该活动；诚实口径：报告中 layoutPaintPerFrame = Layout +
    // RecalcStyle + Paint，Paint 缺失时退化为 layout 段）
    delta[n] =
      typeof prev[n] === 'number' && typeof cur[n] === 'number'
        ? Math.max(0, cur[n] - prev[n])
        : 0;
  }
  return delta;
}

/**
 * 场景间运行期守卫：强制 GC + 5s 冷却（A6 §3.4 第 5 条，防跨场景残留）。
 * CDP 不可用时仅冷却（warn 提示）。
 */
export async function gcCool(cdp, label = '场景') {
  if (cdp) {
    try {
      await cdp.send('HeapProfiler.collectGarbage');
    } catch {
      console.log(`[suite] 警告：${label} 前 collectGarbage 失败（CDP 受限），仅冷却`);
    }
  }
  await new Promise((r) => setTimeout(r, 5000));
}

/**
 * M1b L2：CDP Tracing 帧相位分解（nightly 专属；失败 warn 降级返回 null）。
 * 抓取 durationMs 窗口，按 16.7ms 时间桶归帧，聚合 RunTask/Layout/
 * UpdateLayoutTree/Paint/Commit 时长；JS ≈ 任务总时长 - layout - paint
 * （与 A6 §2.1 L2 口径一致，headless/GPU 同源可比）。
 */
export async function traceFramePhases(page, cdp, durationMs = 3000) {
  try {
    const events = [];
    const listener = (payload) => {
      if (payload && Array.isArray(payload.params && payload.params.data)) {
        for (const ev of payload.params.data) events.push(ev);
      }
    };
    cdp.on('Tracing.dataCollected', listener);
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing,v8',
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordUntilFull' },
    });
    await page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const t0 = performance.now();
          const tick = () => {
            if (performance.now() - t0 >= ms) resolve(true);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      durationMs
    );
    await cdp.send('Tracing.end');
    await new Promise((r) => setTimeout(r, 500));
    cdp.off('Tracing.dataCollected', listener);

    // 归帧：按事件时间戳（us → ms）落到 16.7ms 桶
    const buckets = new Map();
    let startTs = null;
    for (const ev of events) {
      if (ev.ts === undefined) continue;
      const tsMs = ev.ts / 1000;
      if (startTs === null) startTs = tsMs;
      const bucket = Math.floor((tsMs - startTs) / 16.7);
      if (bucket < 0) continue;
      const dur = ev.dur !== undefined ? ev.dur / 1000 : 0;
      let b = buckets.get(bucket);
      if (!b) {
        b = { task: 0, layout: 0, paint: 0 };
        buckets.set(bucket, b);
      }
      if (ev.name === 'RunTask') b.task += dur;
      else if (ev.name === 'Layout' || ev.name === 'UpdateLayoutTree') b.layout += dur;
      else if (ev.name === 'Paint' || ev.name === 'Commit') b.paint += dur;
    }
    const jsMs = [];
    const layoutPaintMs = [];
    for (const b of buckets.values()) {
      if (b.task > 0) {
        jsMs.push(Math.max(0, b.task - b.layout - b.paint));
        layoutPaintMs.push(b.layout + b.paint);
      }
    }
    if (jsMs.length < 10) return null; // 采样不足视为降级
    const sort = (a) => a.slice().sort((x, y) => x - y);
    const jsSorted = sort(jsMs);
    const lpSorted = sort(layoutPaintMs);
    const p = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    return {
      frames: jsMs.length,
      jsP95Ms: Number(p(jsSorted, 0.95).toFixed(2)),
      jsP50Ms: Number(p(jsSorted, 0.5).toFixed(2)),
      layoutPaintP95Ms: Number(p(lpSorted, 0.95).toFixed(2)),
      layoutPaintP50Ms: Number(p(lpSorted, 0.5).toFixed(2)),
    };
  } catch (err) {
    console.log(`[suite] 警告：L2 trace 不可用（${err.message}），M1b 走 L1 CDP 计数器口径`);
    return null;
  }
}
