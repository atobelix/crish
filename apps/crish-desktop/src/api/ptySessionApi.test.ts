/**
 * Frontend PTY session API contract tests (mock invoke).
 * Covers create/write/resize/kill + PtySessionManager reuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tauriInvoke', () => ({
  invokeResult: vi.fn(),
}));

import { invokeResult } from './tauriInvoke';
import {
  PtySessionManager,
  ptyCreate,
  ptyKill,
  ptyResize,
  ptyWrite,
  subscribePtyExit,
  subscribePtyOutput,
  type PtyCreateResult,
} from './ptySessionApi';

const mockedInvoke = vi.mocked(invokeResult);

beforeEach(() => {
  mockedInvoke.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function okCreate(ptyId: string) {
  mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: { ptyId } });
}

// ── ptyCreate ─────────────────────────────────────────────────────

describe('ptyCreate', () => {
  it('rejects empty sessionKey without invoke', async () => {
    await expect(ptyCreate({ sessionKey: '', cols: 80, rows: 24 })).resolves.toEqual({
      status: 'error',
      message: 'sessionKey is empty',
    });
    await expect(ptyCreate({ sessionKey: '   ', cols: 80, rows: 24 })).resolves.toEqual({
      status: 'error',
      message: 'sessionKey is empty',
    });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('invokes workbench_pty_create with clamped cols/rows and optional cwd', async () => {
    okCreate('pty-1');
    // cols: 0 → falsy → default 80; rows: -3 → max(1, floor(-3)) = 1
    const res = await ptyCreate({
      sessionKey: '  sess-a  ',
      cols: 0,
      rows: -3,
      cwd: '  C:/repo  ',
    });
    expect(res).toEqual({ status: 'ok', data: { ptyId: 'pty-1' } });
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_pty_create', {
      sessionKey: 'sess-a',
      cols: 80,
      rows: 1,
      cwd: 'C:/repo',
    });
  });

  it('omits empty cwd from args', async () => {
    okCreate('pty-2');
    await ptyCreate({ sessionKey: 's1', cols: 80, rows: 24, cwd: '  ' });
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_pty_create', {
      sessionKey: 's1',
      cols: 80,
      rows: 24,
    });
  });

  it('coerces pty_id snake_case and bare string id', async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: { pty_id: 'pty-snake' } });
    await expect(
      ptyCreate({ sessionKey: 's1', cols: 80, rows: 24 }),
    ).resolves.toEqual({ status: 'ok', data: { ptyId: 'pty-snake' } });

    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: 'pty-bare' });
    await expect(
      ptyCreate({ sessionKey: 's1', cols: 80, rows: 24 }),
    ).resolves.toEqual({ status: 'ok', data: { ptyId: 'pty-bare' } });
  });

  it('errors when create returns no ptyId', async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: {} });
    await expect(
      ptyCreate({ sessionKey: 's1', cols: 80, rows: 24 }),
    ).resolves.toEqual({
      status: 'error',
      message: 'workbench_pty_create returned no ptyId',
    });
  });

  it('maps missing / error from invoke', async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 'missing' });
    await expect(
      ptyCreate({ sessionKey: 's1', cols: 80, rows: 24 }),
    ).resolves.toEqual({ status: 'missing' });

    mockedInvoke.mockResolvedValueOnce({ status: 'error', message: 'spawn failed' });
    await expect(
      ptyCreate({ sessionKey: 's1', cols: 80, rows: 24 }),
    ).resolves.toEqual({ status: 'error', message: 'spawn failed' });
  });

  it('defaults NaN cols/rows to 80×24', async () => {
    okCreate('pty-d');
    await ptyCreate({
      sessionKey: 's1',
      cols: Number.NaN,
      rows: Number.NaN,
    });
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_pty_create', {
      sessionKey: 's1',
      cols: 80,
      rows: 24,
    });
  });
});

// ── ptyWrite / ptyResize / ptyKill ────────────────────────────────

describe('ptyWrite', () => {
  it('rejects empty ptyId', async () => {
    await expect(ptyWrite('', 'x')).resolves.toEqual({
      status: 'error',
      message: 'ptyId is empty',
    });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('writes data on ok and maps missing', async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: null });
    await expect(ptyWrite('  pty-1  ', 'echo hi')).resolves.toEqual({
      status: 'ok',
      data: undefined,
    });
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_pty_write', {
      ptyId: 'pty-1',
      data: 'echo hi',
    });

    mockedInvoke.mockResolvedValueOnce({ status: 'missing' });
    await expect(ptyWrite('pty-1', 'x')).resolves.toEqual({ status: 'missing' });
  });
});

describe('ptyResize', () => {
  it('rejects empty ptyId and clamps size', async () => {
    await expect(ptyResize('', 80, 24)).resolves.toEqual({
      status: 'error',
      message: 'ptyId is empty',
    });

    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: null });
    await expect(ptyResize('pty-1', 0, -1)).resolves.toEqual({
      status: 'ok',
      data: undefined,
    });
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_pty_resize', {
      ptyId: 'pty-1',
      cols: 1,
      rows: 1,
    });
  });
});

describe('ptyKill', () => {
  it('rejects empty and kills on ok', async () => {
    await expect(ptyKill('')).resolves.toEqual({
      status: 'error',
      message: 'ptyId is empty',
    });

    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: null });
    await expect(ptyKill('pty-z')).resolves.toEqual({ status: 'ok', data: undefined });
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_pty_kill', { ptyId: 'pty-z' });
  });
});

// ── subscribe (browser / no Tauri → safe no-op unsubscribe) ───────

describe('subscribePtyOutput / subscribePtyExit', () => {
  it('returns unsubscribe functions that are idempotent', () => {
    const offOut = subscribePtyOutput(() => {});
    const offExit = subscribePtyExit(() => {});
    expect(typeof offOut).toBe('function');
    expect(typeof offExit).toBe('function');
    offOut();
    offOut();
    offExit();
    offExit();
  });
});

// ── PtySessionManager ─────────────────────────────────────────────

describe('PtySessionManager', () => {
  it('ensure creates once then reuses; write/resize/kill track session', async () => {
    const mgr = new PtySessionManager();
    okCreate('pty-m1');
    const first = await mgr.ensure('  unit-1  ', { cols: 100, rows: 30, cwd: 'C:/ws' });
    expect(first).toEqual({ status: 'ok', data: { ptyId: 'pty-m1' } });
    expect(mgr.getPtyId('unit-1')).toBe('pty-m1');
    expect(mockedInvoke).toHaveBeenCalledTimes(1);

    // second ensure: no extra invoke
    const second = await mgr.ensure('unit-1');
    expect(second).toEqual({ status: 'ok', data: { ptyId: 'pty-m1' } });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);

    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: null });
    await expect(mgr.write('unit-1', 'ls\r')).resolves.toEqual({
      status: 'ok',
      data: undefined,
    });
    expect(mockedInvoke).toHaveBeenLastCalledWith('workbench_pty_write', {
      ptyId: 'pty-m1',
      data: 'ls\r',
    });

    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: null });
    await expect(mgr.resize('unit-1', 120, 40)).resolves.toEqual({
      status: 'ok',
      data: undefined,
    });

    mockedInvoke.mockResolvedValueOnce({ status: 'ok', data: null });
    await expect(mgr.kill('unit-1')).resolves.toEqual({ status: 'ok', data: undefined });
    expect(mgr.getPtyId('unit-1')).toBeUndefined();
  });

  it('ensure rejects empty session; write without create errors', async () => {
    const mgr = new PtySessionManager();
    await expect(mgr.ensure('')).resolves.toEqual({
      status: 'error',
      message: 'sessionKey is empty',
    });
    await expect(mgr.write('ghost', 'x')).resolves.toEqual({
      status: 'error',
      message: 'no PTY for session',
    });
    await expect(mgr.resize('ghost', 80, 24)).resolves.toEqual({
      status: 'error',
      message: 'no PTY for session',
    });
    await expect(mgr.kill('ghost')).resolves.toEqual({ status: 'missing' });
  });

  it('coalesces concurrent ensure for same sessionKey', async () => {
    const mgr = new PtySessionManager();
    let resolveInvoke!: (v: { status: 'ok'; data: PtyCreateResult }) => void;
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve as typeof resolveInvoke;
        }),
    );

    const a = mgr.ensure('s-concurrent');
    const b = mgr.ensure('s-concurrent');
    resolveInvoke({ status: 'ok', data: { ptyId: 'pty-once' } });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ status: 'ok', data: { ptyId: 'pty-once' } });
    expect(rb).toEqual({ status: 'ok', data: { ptyId: 'pty-once' } });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it('disposeAll kills every tracked PTY', async () => {
    const mgr = new PtySessionManager();
    mockedInvoke
      .mockResolvedValueOnce({ status: 'ok', data: { ptyId: 'p-a' } })
      .mockResolvedValueOnce({ status: 'ok', data: { ptyId: 'p-b' } })
      .mockResolvedValueOnce({ status: 'ok', data: null })
      .mockResolvedValueOnce({ status: 'ok', data: null });

    await mgr.ensure('sA');
    await mgr.ensure('sB');
    await mgr.disposeAll();
    expect(mgr.getPtyId('sA')).toBeUndefined();
    expect(mgr.getPtyId('sB')).toBeUndefined();
    const killCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'workbench_pty_kill');
    expect(killCalls).toHaveLength(2);
  });
});
