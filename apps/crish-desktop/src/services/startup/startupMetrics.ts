/**
 * 启动实测对比工具（非业务截断）——观察真实加载后再针对性优化。
 *
 * 用法（DevTools / Tauri WebView 控制台）：
 *   crishStartupReport()            // 打印本次启动阶段耗时表
 *   crishStartupReport({ history: true })  // 含历史样本对比
 *   crishStartupReport({ copy: true })     // 复制 JSON（若有 clipboard）
 *
 * 设计约束：
 * - 只读观测，不阻塞启动、不发 IPC、不做硬截断；
 * - 阶段锚点尽量挂在已有 entry-core / bootstrap / hydrate 路径；
 * - 历史仅存 localStorage 最近 N 条，便于同机 before/after 对照。
 */

export interface StartupPhaseSample {
  /** 相对 entry 求值 t0（performance.now 基线）的 ms；未记录为 null */
  ms: number | null;
}

export interface StartupReportSample {
  id: string;
  at: string;
  userAgent: string;
  isTauri: boolean;
  /** 主阶段：相对模块 t0 */
  phases: Record<string, number | null>;
  /** 派生区间（ms） */
  derived: Record<string, number | null>;
  raw: Record<string, unknown>;
  paneHydrate?: {
    enqueued: number;
    done: number;
    lastFlushMs: number | null;
  };
}

const HISTORY_KEY = 'crish_startup_report_v1';
const HISTORY_MAX = 20;

/** 阶段键：写入顺序即构建时间线 */
const PHASE_ORDER = [
  'entryStart',
  'preloadSnapshotDone',
  'reactMounted',
  'reactInteractiveReady',
  'coreReady',
  'bootstrapFullDone',
  'shellReady',
  'paneQueueIdle',
] as const;

type PhaseKey = (typeof PHASE_ORDER)[number];

interface PerfBag {
  t0?: number;
  phases: Partial<Record<PhaseKey, number>>;
  paneEnqueued?: number;
  paneDone?: number;
  lastPaneFlushMs?: number | null;
}

const bag: PerfBag = { phases: {} };

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** entry-core 调用：锚定 t0（模块求值起点） */
export function markStartupEntry(): void {
  if (bag.t0 == null) {
    bag.t0 = now();
    // 存绝对时刻；rel() 会相对 t0 得到 0
    bag.phases.entryStart = bag.t0;
    syncToWindow();
  }
}

/** 任意启动子系统调用：记录阶段绝对时刻（performance.now） */
export function markStartupPhase(phase: PhaseKey, at?: number): void {
  const t = at ?? now();
  if (bag.phases[phase] == null) {
    bag.phases[phase] = t;
    syncToWindow();
  }
}

export function markPaneHydrateEnqueued(): void {
  bag.paneEnqueued = (bag.paneEnqueued ?? 0) + 1;
  syncToWindow();
}

export function markPaneHydrateDone(durationMs?: number): void {
  bag.paneDone = (bag.paneDone ?? 0) + 1;
  if (durationMs != null) {
    bag.lastPaneFlushMs = durationMs;
  }
  if ((bag.paneDone ?? 0) >= (bag.paneEnqueued ?? 0) && (bag.paneEnqueued ?? 0) > 0) {
    markStartupPhase('paneQueueIdle');
  }
  syncToWindow();
}

function syncToWindow(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as {
    __crish_startup_bag?: PerfBag;
    crishStartupReport?: (opts?: ReportOptions) => void;
  };
  w.__crish_startup_bag = bag;
  if (typeof w.crishStartupReport !== 'function') {
    w.crishStartupReport = crishStartupReport;
  }
}

function rel(phase: PhaseKey): number | null {
  const t = bag.phases[phase];
  const t0 = bag.t0;
  if (t == null || t0 == null) return null;
  return round(t - t0);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function derive(phases: Record<string, number | null>): Record<string, number | null> {
  const span = (a: PhaseKey, b: PhaseKey): number | null => {
    const ra = phases[a];
    const rb = phases[b];
    if (ra == null || rb == null) return null;
    return round(rb - ra);
  };
  return {
    preloadSpan: span('entryStart', 'preloadSnapshotDone'),
    mountAfterPreload: span('preloadSnapshotDone', 'reactMounted'),
    rafAfterMount: span('reactMounted', 'reactInteractiveReady'),
    ttiFromEntry: phases.reactInteractiveReady ?? null,
    coreFromEntry: phases.coreReady ?? null,
    fullFromEntry: phases.bootstrapFullDone ?? null,
  };
}

function buildSample(): StartupReportSample {
  const phases: Record<string, number | null> = {};
  for (const k of PHASE_ORDER) {
    phases[k] = rel(k);
  }
  // 兼容已有 __crish_perf 绝对值
  const raw = {
    ...(window.__crish_perf ?? {}),
    bagPhases: { ...bag.phases },
  };
  const perf = window.__crish_perf as
    | { reactInteractiveReady?: number; coreReady?: number; firstPaint?: number }
    | undefined;
  if (perf?.reactInteractiveReady != null && phases.reactInteractiveReady == null) {
    const t0 = bag.t0;
    phases.reactInteractiveReady = t0 != null ? round(perf.reactInteractiveReady - t0) : perf.reactInteractiveReady;
  }

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    isTauri: typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__,
    phases,
    derived: derive(phases),
    raw,
    paneHydrate: {
      enqueued: bag.paneEnqueued ?? 0,
      done: bag.paneDone ?? 0,
      lastFlushMs: bag.lastPaneFlushMs ?? null,
    },
  };
}

function loadHistory(): StartupReportSample[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StartupReportSample[]) : [];
  } catch {
    return [];
  }
}

function pushHistory(sample: StartupReportSample): void {
  try {
    const list = loadHistory();
    list.unshift(sample);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    /* 配额/隐私模式忽略 */
  }
}

/** 关键状态耗时：纯文字，无表格/图表 */
function formatText(sample: StartupReportSample): string {
  const n = (v: number | null | undefined): string =>
    v == null ? '—' : `${v}ms`;
  const p = sample.phases;
  const d = sample.derived;
  const pane = sample.paneHydrate;
  const lines = [
    `crish startup  ${sample.at}  tauri=${sample.isTauri}`,
    `preload: ${n(d.preloadSpan)}`,
    `mount after preload: ${n(d.mountAfterPreload)}`,
    `raf after mount: ${n(d.rafAfterMount)}`,
    `TTI from entry: ${n(d.ttiFromEntry)}`,
    `coreReady: ${n(d.coreFromEntry)}`,
    `bootstrapFull: ${n(d.fullFromEntry)}`,
    `shellReady: ${n(p.shellReady)}`,
    `paneQueueIdle: ${n(p.paneQueueIdle)}`,
  ];
  if (pane && pane.enqueued > 0) {
    lines.push(
      `panes: enqueued=${pane.enqueued} done=${pane.done} last=${n(pane.lastFlushMs)}`
    );
  }
  return lines.join('\n');
}

function formatHistoryCompare(list: StartupReportSample[]): string {
  if (list.length < 2) return '';
  const lines = ['', 'history (newest first): tti / core / preload / full'];
  for (const s of list.slice(0, 8)) {
    const d = s.derived;
    lines.push(
      `  ${s.at.slice(11, 19)}  ${d.ttiFromEntry ?? '—'} / ${d.coreFromEntry ?? '—'} / ${d.preloadSpan ?? '—'} / ${d.fullFromEntry ?? '—'}`
    );
  }
  return lines.join('\n');
}

export interface ReportOptions {
  /** 打印纯文字到 console.log（默认 true） */
  log?: boolean;
  /** 写入 localStorage 历史（默认 true） */
  record?: boolean;
  /** 附带历史对比行（默认 true） */
  history?: boolean;
  /** 返回纯文字（默认 true）；false 返回 JSON */
  copy?: boolean;
}

/** 一键启动报告：仅关键状态耗时纯文字 */
export function crishStartupReport(opts: ReportOptions = {}): string {
  const { log = true, record = true, history = true, copy = true } = opts;
  syncToWindow();
  const sample = buildSample();
  if (record) {
    pushHistory(sample);
  }
  let text = formatText(sample);
  if (history) {
    const h = formatHistoryCompare(loadHistory());
    if (h) text += `\n${h}`;
  }
  if (log) {
    console.log(text);
  }
  return copy ? text : JSON.stringify(sample, null, 2);
}

/** 测试/单元用：重置内存 bag */
export function __resetStartupBagForTest(): void {
  bag.t0 = undefined;
  bag.phases = {};
  bag.paneEnqueued = 0;
  bag.paneDone = 0;
  bag.lastPaneFlushMs = null;
}

// 模块加载即挂全局（entry 早期 import 即可）
if (typeof window !== 'undefined') {
  syncToWindow();
}
