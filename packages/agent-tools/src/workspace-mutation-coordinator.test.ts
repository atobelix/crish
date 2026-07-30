import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceMutationCoordinator,
  scopesConflict,
} from './workspace-mutation-coordinator';

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkspaceMutationCoordinator', () => {
  it('normalizes multi-file scopes and detects only same-file conflicts between file leases', async () => {
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      caseSensitivePaths: true,
      idFactory: sequentialIds('lease'),
    });

    const first = await coordinator.acquire({
      scope: {
        type: 'files',
        paths: ['src/../src/b.ts', 'src/a.ts', 'src/a.ts'],
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first lease');
    expect(first.lease.scope).toEqual({
      type: 'files',
      paths: [
        resolve('/repo/src/a.ts').replace(/\\/g, '/'),
        resolve('/repo/src/b.ts').replace(/\\/g, '/'),
      ],
    });

    const unrelated = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/c.ts'] },
    });
    expect(unrelated.ok).toBe(true);

    const sameFile = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/./a.ts'] },
    });
    expect(sameFile).toMatchObject({
      ok: false,
      reason: 'conflict',
      conflictingLeases: [{ token: 'lease_1' }],
    });
  });

  it('treats workspace leases as conflicting with every file lease', async () => {
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      idFactory: sequentialIds('lease'),
    });

    const file = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/app.ts'] },
    });
    expect(file.ok).toBe(true);

    const workspace = await coordinator.acquire({
      scope: { type: 'workspace' },
    });
    expect(workspace).toMatchObject({ ok: false, reason: 'conflict' });

    if (!file.ok) throw new Error('expected file lease');
    expect(coordinator.release(file.lease.token).ok).toBe(true);

    const grantedWorkspace = await coordinator.acquire({
      scope: { type: 'workspace' },
    });
    expect(grantedWorkspace.ok).toBe(true);

    const secondFile = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/other.ts'] },
    });
    expect(secondFile).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('serves waiters FIFO for the same conflict domain while allowing unrelated files through', async () => {
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      idFactory: sequentialIds('lease'),
    });
    const events: string[] = [];

    const active = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/a.ts'] },
    });
    expect(active.ok).toBe(true);
    if (!active.ok) throw new Error('expected active lease');

    const firstWaiter = coordinator
      .acquire({ scope: { type: 'files', paths: ['src/a.ts'] }, wait: true })
      .then((result) => {
        events.push(result.ok ? result.lease.token : result.reason);
        return result;
      });
    const secondWaiter = coordinator
      .acquire({ scope: { type: 'files', paths: ['src/a.ts'] }, wait: true })
      .then((result) => {
        events.push(result.ok ? result.lease.token : result.reason);
        return result;
      });

    const unrelated = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/b.ts'] },
    });
    expect(unrelated.ok).toBe(true);

    coordinator.release(active.lease.token);
    const first = await firstWaiter;
    expect(first.ok).toBe(true);
    expect(events).toEqual(['lease_3']);

    if (!first.ok) throw new Error('expected first waiter lease');
    coordinator.release(first.lease.token);
    const second = await secondWaiter;
    expect(second.ok).toBe(true);
    expect(events).toEqual(['lease_3', 'lease_4']);
  });

  it('keeps a queued workspace waiter ahead of later file waiters', async () => {
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      idFactory: sequentialIds('lease'),
    });

    const activeFile = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/a.ts'] },
    });
    expect(activeFile.ok).toBe(true);
    if (!activeFile.ok) throw new Error('expected active file lease');

    const workspaceWaiter = coordinator.acquire({
      scope: { type: 'workspace' },
      wait: true,
    });
    const laterFileWaiter = coordinator.acquire({
      scope: { type: 'files', paths: ['src/b.ts'] },
      wait: true,
      timeoutMs: 10,
    });

    const laterFile = await laterFileWaiter;
    expect(laterFile).toMatchObject({ ok: false, reason: 'timeout' });

    coordinator.release(activeFile.lease.token);
    const workspace = await workspaceWaiter;
    expect(workspace.ok).toBe(true);
  });

  it('expires leases by TTL and drains the wait queue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      idFactory: sequentialIds('lease'),
      defaultTtlMs: 50,
    });

    const active = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/a.ts'] },
    });
    expect(active.ok).toBe(true);

    const waiter = coordinator.acquire({
      scope: { type: 'files', paths: ['src/a.ts'] },
      wait: true,
    });
    await vi.advanceTimersByTimeAsync(51);

    const granted = await waiter;
    expect(granted.ok).toBe(true);
    if (!granted.ok) throw new Error('expected waiter lease');
    expect(granted.lease.token).toBe('lease_2');
    expect(coordinator.getLease('lease_1')).toBeUndefined();
  });

  it('renews leases and returns typed failures for invalid tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      idFactory: sequentialIds('lease'),
      defaultTtlMs: 20,
    });

    const active = await coordinator.acquire({ scope: { type: 'workspace' } });
    expect(active.ok).toBe(true);
    if (!active.ok) throw new Error('expected active lease');

    await vi.advanceTimersByTimeAsync(10);
    const renewed = coordinator.renew(active.lease.token, { ttlMs: 50 });
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) throw new Error('expected renewed lease');
    expect(renewed.lease.expiresAt).toBe('2026-01-01T00:00:00.060Z');

    expect(coordinator.renew('missing')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(coordinator.release('missing')).toEqual({
      ok: false,
      reason: 'not_found',
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(coordinator.getLease(active.lease.token)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(coordinator.getLease(active.lease.token)).toBeUndefined();
  });

  it('records latest read snapshots by normalized session path', () => {
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      caseSensitivePaths: true,
    });

    coordinator.recordReadSnapshot(
      'session_1',
      'src/../src/app.ts',
      'snapshot_a'
    );
    coordinator.recordReadSnapshot('session_1', 'src/app.ts', 'snapshot_b');
    coordinator.recordReadSnapshot('session_2', 'src/app.ts', 'snapshot_c');

    expect(coordinator.latestReadSnapshot('session_1', './src/app.ts')).toBe(
      'snapshot_b'
    );
    expect(coordinator.latestReadSnapshot('session_2', './src/app.ts')).toBe(
      'snapshot_c'
    );
    expect(
      coordinator.latestReadSnapshot('session_1', './src/other.ts')
    ).toBeUndefined();
  });

  it('releases leases in finally when guarded mutations throw', async () => {
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      idFactory: sequentialIds('lease'),
    });

    await expect(
      coordinator.withLease({ scope: { type: 'workspace' } }, async () => {
        throw new Error('mutation failed');
      })
    ).rejects.toThrow('mutation failed');

    expect(coordinator.listLeases()).toEqual([]);
    const next = await coordinator.acquire({
      scope: { type: 'files', paths: ['src/app.ts'] },
    });
    expect(next.ok).toBe(true);
  });

  it('heartbeats guarded mutations until the operation settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot: '/repo',
      idFactory: sequentialIds('lease'),
    });

    const guarded = coordinator.withLease(
      {
        scope: { type: 'files', paths: ['src/app.ts'] },
        ttlMs: 20,
        heartbeatIntervalMs: 10,
      },
      async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 45));
        return 'done';
      }
    );

    const waiter = coordinator.acquire({
      scope: { type: 'files', paths: ['src/app.ts'] },
      wait: true,
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(coordinator.listLeases()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20);
    await expect(guarded).resolves.toBe('done');

    const granted = await waiter;
    expect(granted.ok).toBe(true);
    expect(coordinator.listLeases()).toHaveLength(1);
  });

  it('exposes pure scope conflict checks', () => {
    const fileA = { type: 'files' as const, paths: ['/repo/a.ts'] };
    const fileB = { type: 'files' as const, paths: ['/repo/b.ts'] };
    expect(scopesConflict(fileA, fileB)).toBe(false);
    expect(
      scopesConflict(fileA, { type: 'files', paths: ['/repo/a.ts'] })
    ).toBe(true);
    expect(scopesConflict(fileA, { type: 'workspace' })).toBe(true);
  });
});

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}_${++next}`;
}
