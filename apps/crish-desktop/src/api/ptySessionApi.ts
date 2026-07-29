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

import { invokeResult, type InvokeResult } from './tauriInvoke';

// ── Types ────────────────────────────────────────────────────────────

export type PtyCreateResult = { ptyId: string };

export type PtyCreateOptions = {
  sessionKey: string;
  cols: number;
  rows: number;
  cwd?: string;
};

export type PtyOutputPayload = { ptyId: string; data: string };
export type PtyExitPayload = { ptyId: string; code?: number | null };

export type PtyInvokeOk<T> = { status: 'ok'; data: T };
export type PtyInvokeMissing = { status: 'missing' };
export type PtyInvokeErr = { status: 'error'; message: string };
export type PtyInvokeResult<T> = PtyInvokeOk<T> | PtyInvokeMissing | PtyInvokeErr;

const EVENT_PTY_OUTPUT = 'workbench://pty-output';
const EVENT_PTY_EXIT = 'workbench://pty-exit';

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

function mapInvoke<T>(
  res: InvokeResult<T>,
): PtyInvokeResult<T> {
  if (res.status === 'ok') return { status: 'ok', data: res.data };
  if (res.status === 'missing') return { status: 'missing' };
  return { status: 'error', message: res.message };
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
  const data = coerceText(rec.data ?? rec.chunk ?? rec.output);
  return { ptyId, data };
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
  opts: PtyCreateOptions,
): Promise<PtyInvokeResult<PtyCreateResult>> {
  const sessionKey = (opts.sessionKey || '').trim();
  if (!sessionKey) {
    return { status: 'error', message: 'sessionKey is empty' };
  }
  const cols = Math.max(1, Math.floor(Number(opts.cols) || 80));
  const rows = Math.max(1, Math.floor(Number(opts.rows) || 24));
  const cwd = opts.cwd?.trim() || undefined;

  const res = await invokeResult<unknown>('workbench_pty_create', {
    sessionKey,
    cols,
    rows,
    ...(cwd ? { cwd } : {}),
  });

  if (res.status !== 'ok') return mapInvoke(res);

  const ptyId = coercePtyId(res.data);
  if (!ptyId) {
    return { status: 'error', message: 'workbench_pty_create returned no ptyId' };
  }
  return { status: 'ok', data: { ptyId } };
}

/** Write raw bytes/text to a live PTY. */
export async function ptyWrite(
  ptyId: string,
  data: string,
): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };

  const res = await invokeResult<unknown>('workbench_pty_write', {
    ptyId: id,
    data: data ?? '',
  });
  if (res.status === 'ok') return { status: 'ok', data: undefined };
  return mapInvoke(res);
}

/** Resize PTY window (cols × rows). */
export async function ptyResize(
  ptyId: string,
  cols: number,
  rows: number,
): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };
  const c = Math.max(1, Math.floor(Number(cols) || 1));
  const r = Math.max(1, Math.floor(Number(rows) || 1));

  const res = await invokeResult<unknown>('workbench_pty_resize', {
    ptyId: id,
    cols: c,
    rows: r,
  });
  if (res.status === 'ok') return { status: 'ok', data: undefined };
  return mapInvoke(res);
}

/** Kill / dispose a PTY process. */
export async function ptyKill(ptyId: string): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };

  const res = await invokeResult<unknown>('workbench_pty_kill', {
    ptyId: id,
  });
  if (res.status === 'ok') return { status: 'ok', data: undefined };
  return mapInvoke(res);
}

// ── Event subscriptions (shared Tauri listen, multi-handler fan-out) ─

type UnlistenFn = () => void;

type FanoutEntry<T> = {
  handlers: Set<(p: T) => void>;
  unlisten: UnlistenFn | null;
  starting: Promise<void> | null;
};

const outputFanout: FanoutEntry<PtyOutputPayload> = {
  handlers: new Set(),
  unlisten: null,
  starting: null,
};

const exitFanout: FanoutEntry<PtyExitPayload> = {
  handlers: new Set(),
  unlisten: null,
  starting: null,
};

async function ensureTauriListen<T>(
  eventName: string,
  entry: FanoutEntry<T>,
  parse: (raw: unknown) => T | null,
): Promise<void> {
  if (entry.unlisten || entry.starting) {
    await entry.starting;
    return;
  }

  entry.starting = (async () => {
    try {
      const mod = await import('@tauri-apps/api/event');
      const listen = mod?.listen;
      if (typeof listen !== 'function') return;

      entry.unlisten = await listen(eventName, (event: { payload?: unknown }) => {
        const payload = parse(event?.payload);
        if (!payload) return;
        for (const h of entry.handlers) {
          try {
            h(payload);
          } catch (err) {
            console.warn(`[ptySessionApi] handler error on ${eventName}`, err);
          }
        }
      });
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
  handler: (p: T) => void,
): () => void {
  entry.handlers.add(handler);
  void ensureTauriListen(eventName, entry, parse);

  return () => {
    entry.handlers.delete(handler);
    if (entry.handlers.size === 0 && entry.unlisten) {
      try {
        entry.unlisten();
      } catch {
        /* ignore */
      }
      entry.unlisten = null;
    }
  };
}

/** Subscribe to PTY stdout/stderr chunks. Returns unsubscribe. */
export function subscribePtyOutput(
  handler: (p: PtyOutputPayload) => void,
): () => void {
  return subscribeFanout(EVENT_PTY_OUTPUT, outputFanout, parseOutputPayload, handler);
}

/** Subscribe to PTY process exit. Returns unsubscribe. */
export function subscribePtyExit(
  handler: (p: PtyExitPayload) => void,
): () => void {
  return subscribeFanout(EVENT_PTY_EXIT, exitFanout, parseExitPayload, handler);
}

// ── Optional thin manager (sessionKey → ptyId) ───────────────────────

export type PtySessionManagerOptions = {
  cols?: number;
  rows?: number;
  cwd?: string;
};

/**
 * Reuse one PTY per sessionKey. Thin convenience for TerminalCard (C3).
 * Not a global singleton — construct per UI surface if needed.
 */
export class PtySessionManager {
  private readonly bySession = new Map<string, string>();
  private readonly creating = new Map<string, Promise<PtyInvokeResult<PtyCreateResult>>>();

  getPtyId(sessionKey: string): string | undefined {
    const key = (sessionKey || '').trim();
    return key ? this.bySession.get(key) : undefined;
  }

  /** Create if missing; return existing ptyId otherwise. */
  async ensure(
    sessionKey: string,
    opts: PtySessionManagerOptions = {},
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
    data: string,
  ): Promise<PtyInvokeResult<void>> {
    const ptyId = this.getPtyId(sessionKey);
    if (!ptyId) return { status: 'error', message: 'no PTY for session' };
    return ptyWrite(ptyId, data);
  }

  async resize(
    sessionKey: string,
    cols: number,
    rows: number,
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
      entries.map(([, ptyId]) => ptyKill(ptyId).catch(() => undefined)),
    );
  }
}
