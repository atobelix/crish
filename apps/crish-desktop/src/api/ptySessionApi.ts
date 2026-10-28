/**
 * Interactive PTY session API (frontend).
 *
 * Binds to Tauri commands C1 registers:
 *   workbench_pty_create / workbench_pty_write / workbench_pty_resize / workbench_pty_kill
 * Events:
 *   workbench://pty-output  → { ptyId, data }
 *   workbench://pty-exit    → { ptyId, code? }
 *
 * Browser / missing-command: invoke returns { status: 'missing' }; event subscribe is a no-op.
 */

import { invokeResult } from './tauriInvoke';
import { getWorkspacePath } from './projectStore';
import {
  killPty,
  mapPtyInvoke,
  ptyAttach,
  ptyDetach,
  ptyPing,
  ptyResize,
  ptyWrite,
  type PtyInvokeResult,
} from './ptySessionCommands';
import {
  createPtyCreateArgs,
  normalizePtyCreateOptions,
  type PtyCreateOptions,
  type PtyCreateResult,
} from './ptyCreateArgs';
import { logger } from '../services/LoggerService';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
// D0/U-BUDGET：环形缓冲预算定义收敛至 perfBudgets 镜像（仅 re-export，行为不变）
import { PTY_HISTORY_MAX_BYTES } from './perfBudgets';

export { PTY_HISTORY_MAX_BYTES };
export { ptyAttach, ptyDetach, ptyPing, ptyResize, ptyWrite };
export type {
  PtyInvokeErr,
  PtyInvokeMissing,
  PtyInvokeOk,
  PtyInvokeResult,
} from './ptySessionCommands';

// ── Types ────────────────────────────────────────────────────────────

export type { PtyCreateOptions, PtyCreateResult } from './ptyCreateArgs';
export type PtyOutputPayload = { ptyId: string; data: string };
export type PtyExitPayload = { ptyId: string; code?: number | null };

const EVENT_PTY_OUTPUT = 'workbench://pty-output';
const EVENT_PTY_EXIT = 'workbench://pty-exit';
const EVENT_PTY_GC_KILLED = 'workbench://pty-gc-killed';

// ── Event fan-out state ──────────────────────────────────────────────

type FanoutEntry<T> = {
  handlers: Set<(p: T) => void>;
  unlisten: UnlistenFn | null;
  starting: Promise<void> | null;
};

const createFanout = <T>(): FanoutEntry<T> => ({
  handlers: new Set(),
  unlisten: null,
  starting: null,
});

const outputFanout = createFanout<PtyOutputPayload>();
const exitFanout = createFanout<PtyExitPayload>();
const gcKilledFanout = createFanout<PtyExitPayload>();

// ── PTY Output History Ring Buffer ────────────────────────────────────
// PTY_HISTORY_MAX_BYTES 定义见 perfBudgets.ts（D0 SoT 镜像；此处仅 re-export）

export type PtyHistoryEntry = {
  chunks: string[];
  totalBytes: number;
};

const ptyHistoryMap = new Map<string, PtyHistoryEntry>();

function checkCleanupUnlisten<T>(entry: FanoutEntry<T>): void {
  if (entry.handlers.size === 0 && entry.unlisten && ptyHistoryMap.size === 0) {
    try {
      entry.unlisten();
    } catch {
      /* ignore */
    }
    entry.unlisten = null;
  }
}

const textEncoder =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function getChunkBytes(chunk: string): number {
  if (textEncoder) {
    return textEncoder.encode(chunk).length;
  }
  return chunk.length;
}

/**
 * 记录指定 ptyId 的输出历史到环形缓冲。
 * 超过 PTY_HISTORY_MAX_BYTES 时从队首依次淘汰旧 chunk 直至低于上限。
 */
export function recordPtyOutputHistory(ptyId: string, data: string): void {
  const id = (ptyId || '').trim();
  if (!id || !data) return;

  let entry = ptyHistoryMap.get(id);
  if (!entry) {
    entry = { chunks: [], totalBytes: 0 };
    ptyHistoryMap.set(id, entry);
  }

  const chunkBytes = getChunkBytes(data);
  entry.chunks.push(data);
  entry.totalBytes += chunkBytes;

  while (entry.totalBytes > PTY_HISTORY_MAX_BYTES && entry.chunks.length > 0) {
    if (entry.chunks.length === 1 && entry.totalBytes > PTY_HISTORY_MAX_BYTES) {
      const single = entry.chunks[0];
      if (!single) break;
      entry.chunks[0] = trimToUtf8ByteLimit(single, PTY_HISTORY_MAX_BYTES);
      entry.totalBytes = getChunkBytes(entry.chunks[0]);
      break;
    }
    const oldest = entry.chunks.shift();
    if (oldest) {
      entry.totalBytes -= getChunkBytes(oldest);
    }
  }

  if (entry.totalBytes < 0) {
    entry.totalBytes = 0;
  }
}

/**
 * 字节感知的单 chunk 尾部截断（audit-repair-202609 T28）：
 * 保留最新 `limit` 个 UTF-8 字节，从后按码点回退找最大合法后缀。
 * 修正历史实现的两处缺陷——① totalBytes 按 UTF-8 字节计但旧截断按 UTF-16
 * 码元 slice（CJK 场景裁后仍可能超上限）；② 截断点可能劈开代理对。
 * TextEncoder 将孤立代理对编码为 U+FFFD（3 字节），按码点累计天然无劈裂。
 */
function trimToUtf8ByteLimit(input: string, limit: number): string {
  if (!textEncoder || getChunkBytes(input) <= limit) return input;
  const points = Array.from(input);
  let acc = 0;
  let startIdx = points.length; // 指向保留后缀的起点
  for (let i = points.length - 1; i >= 0; i--) {
    const bytes = textEncoder.encode(points[i]).length;
    if (acc + bytes > limit) break;
    acc += bytes;
    startIdx = i;
  }
  return points.slice(startIdx).join('');
}

/** 返回该 ptyId 的历史 chunks 快照 */
export function getPtyOutputHistory(ptyId: string): string[] {
  const id = (ptyId || '').trim();
  if (!id) return [];
  const entry = ptyHistoryMap.get(id);
  if (!entry || entry.chunks.length === 0) return [];
  return [...entry.chunks];
}

/** 清除指定 ptyId 的历史缓冲 */
export function clearPtyOutputHistory(ptyId: string): void {
  const id = (ptyId || '').trim();
  if (!id) return;
  ptyHistoryMap.delete(id);
  if (ptyHistoryMap.size === 0) {
    checkCleanupUnlisten(outputFanout);
    checkCleanupUnlisten(exitFanout);
    checkCleanupUnlisten(gcKilledFanout);
  }
}

/** 测试辅助：清空所有 PTY 历史缓冲 */
export function resetPtyHistoryForTests(): void {
  ptyHistoryMap.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function coerceText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

function coercePtyId(raw: unknown): string | null {
  const rec = asRec(raw);
  if (rec) {
    const id = coerceText(rec.ptyId ?? rec.pty_id).trim();
    return id || null;
  }
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

function normalizeExitCode(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseOutputPayload(raw: unknown): PtyOutputPayload | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const ptyId = coerceText(rec.ptyId ?? rec.pty_id).trim();
  if (!ptyId) return null;
  return { ptyId, data: coerceText(rec.data ?? rec.chunk ?? rec.output) };
}

function parseExitPayload(raw: unknown): PtyExitPayload | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const ptyId = coerceText(rec.ptyId ?? rec.pty_id).trim();
  if (!ptyId) return null;
  const code = normalizeExitCode(rec.code ?? rec.exitCode ?? rec.exit_code);
  return code === undefined ? { ptyId } : { ptyId, code };
}

// ── Commands ─────────────────────────────────────────────────────────

/**
 * Spawn an interactive PTY bound to sessionKey.
 * missing = non-Tauri / command not registered; error = shell failure.
 */
export async function ptyCreate(
  opts: PtyCreateOptions
): Promise<PtyInvokeResult<PtyCreateResult>> {
  const options = normalizePtyCreateOptions(opts);
  if (!options) {
    return { status: 'error', message: 'sessionKey is empty' };
  }
  const res = await invokeResult<unknown>('workbench_pty_create', () =>
    createPtyCreateArgs(options, getWorkspacePath, false)
  );

  if (res.status !== 'ok') return mapPtyInvoke(res);

  const ptyId = coercePtyId(res.data);
  if (!ptyId) {
    return {
      status: 'error',
      message: 'workbench_pty_create returned no ptyId',
    };
  }

  if (!ptyHistoryMap.has(ptyId)) {
    ptyHistoryMap.set(ptyId, { chunks: [], totalBytes: 0 });
  }
  void ensureTauriListen(EVENT_PTY_OUTPUT, outputFanout, parseOutputPayload);
  void ensureTauriListen(EVENT_PTY_EXIT, exitFanout, parseExitPayload);
  void ensureTauriListen(EVENT_PTY_GC_KILLED, gcKilledFanout, parseExitPayload);

  return { status: 'ok', data: { ptyId } };
}

/** Kill / dispose a PTY process. */
export async function ptyKill(ptyId: string): Promise<PtyInvokeResult<void>> {
  return killPty(ptyId, clearPtyOutputHistory);
}

// ── Event subscriptions (shared Tauri listen, multi-handler fan-out) ─

async function ensureTauriListen<T>(
  eventName: string,
  entry: FanoutEntry<T>,
  parse: (raw: unknown) => T | null
): Promise<void> {
  if (entry.unlisten || entry.starting) {
    await entry.starting;
    return;
  }

  entry.starting = (async () => {
    try {
      if (typeof listen !== 'function') return;

      entry.unlisten = await listen(
        eventName,
        (event: { payload?: unknown }) => {
          const payload = parse(event?.payload);
          if (!payload) return;

          if (eventName === EVENT_PTY_OUTPUT) {
            const out = payload as unknown as PtyOutputPayload;
            recordPtyOutputHistory(out.ptyId, out.data);
          } else if (
            eventName === EVENT_PTY_EXIT ||
            eventName === EVENT_PTY_GC_KILLED
          ) {
            const exit = payload as unknown as PtyExitPayload;
            clearPtyOutputHistory(exit.ptyId);
          }

          for (const h of entry.handlers) {
            try {
              h(payload);
            } catch (err) {
              logger.warn(`[ptySessionApi] handler error on ${eventName}`, {
                module: 'ptySessionApi',
                err:
                  err instanceof Error
                    ? { message: err.message, stack: err.stack, name: err.name }
                    : { message: String(err) },
              });
            }
          }
        }
      );
    } catch {
      // Browser dev / no Tauri event module — subscribe stays local no-op.
      entry.unlisten = null;
    } finally {
      entry.starting = null;
    }
  })();

  await entry.starting;
}

function subscribeFanout<T>(
  eventName: string,
  entry: FanoutEntry<T>,
  parse: (raw: unknown) => T | null,
  handler: (p: T) => void
): () => void {
  entry.handlers.add(handler);
  void ensureTauriListen(eventName, entry, parse);

  return () => {
    entry.handlers.delete(handler);
    checkCleanupUnlisten(entry);
  };
}

/** Subscribe to PTY stdout/stderr chunks. Returns unsubscribe. */
export function subscribePtyOutput(
  handler: (p: PtyOutputPayload) => void
): () => void {
  void ensureTauriListen(EVENT_PTY_EXIT, exitFanout, parseExitPayload);
  void ensureTauriListen(EVENT_PTY_GC_KILLED, gcKilledFanout, parseExitPayload);

  return subscribeFanout(
    EVENT_PTY_OUTPUT,
    outputFanout,
    parseOutputPayload,
    handler
  );
}

/** Subscribe to PTY process exit. Returns unsubscribe. */
export function subscribePtyExit(
  handler: (p: PtyExitPayload) => void
): () => void {
  return subscribeFanout(EVENT_PTY_EXIT, exitFanout, parseExitPayload, handler);
}

/** Subscribe to PTY GC kill events (>2h detached idle sweep). Returns unsubscribe. */
export function subscribePtyGcKilled(
  handler: (p: PtyExitPayload) => void
): () => void {
  return subscribeFanout(
    EVENT_PTY_GC_KILLED,
    gcKilledFanout,
    parseExitPayload,
    handler
  );
}

// ── Optional thin manager (sessionKey → ptyId) ───────────────────────

export type PtySessionManagerOptions = {
  cols?: number;
  rows?: number;
  /** 旧终端标签的路径快照；ptyCreate 会在授权后重新读取活动工作区。 */
  cwd?: string;
};

/**
 * Reuse one PTY per sessionKey. Thin convenience for TerminalCard (C3).
 * Not a global singleton — construct per UI surface if needed.
 */
export class PtySessionManager {
  private readonly bySession = new Map<string, string>();
  private readonly creating = new Map<
    string,
    Promise<PtyInvokeResult<PtyCreateResult>>
  >();

  getPtyId(sessionKey: string): string | undefined {
    const key = (sessionKey || '').trim();
    return key ? this.bySession.get(key) : undefined;
  }

  /** Create if missing; return existing ptyId otherwise. */
  async ensure(
    sessionKey: string,
    opts: PtySessionManagerOptions = {}
  ): Promise<PtyInvokeResult<PtyCreateResult>> {
    const key = (sessionKey || '').trim();
    if (!key) return { status: 'error', message: 'sessionKey is empty' };

    const existing = this.bySession.get(key);
    if (existing) return { status: 'ok', data: { ptyId: existing } };

    const inflight = this.creating.get(key);
    if (inflight) return inflight;

    const promise = ptyCreate({
      sessionKey: key,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }).then((res) => {
      if (res.status === 'ok') {
        this.bySession.set(key, res.data.ptyId);
      }
      this.creating.delete(key);
      return res;
    });

    this.creating.set(key, promise);
    return promise;
  }

  async write(
    sessionKey: string,
    data: string
  ): Promise<PtyInvokeResult<void>> {
    const ptyId = this.getPtyId(sessionKey);
    if (!ptyId) return { status: 'error', message: 'no PTY for session' };
    return ptyWrite(ptyId, data);
  }

  async resize(
    sessionKey: string,
    cols: number,
    rows: number
  ): Promise<PtyInvokeResult<void>> {
    const ptyId = this.getPtyId(sessionKey);
    if (!ptyId) return { status: 'error', message: 'no PTY for session' };
    return ptyResize(ptyId, cols, rows);
  }

  async kill(sessionKey: string): Promise<PtyInvokeResult<void>> {
    const key = (sessionKey || '').trim();
    const ptyId = key ? this.bySession.get(key) : undefined;
    if (!ptyId) return { status: 'missing' };
    this.bySession.delete(key);
    return ptyKill(ptyId);
  }

  /** Kill all tracked PTYs (best-effort). */
  async disposeAll(): Promise<void> {
    const entries = [...this.bySession.entries()];
    this.bySession.clear();
    this.creating.clear();
    await Promise.all(
      entries.map(([, ptyId]) => ptyKill(ptyId).catch(() => undefined))
    );
  }
}
