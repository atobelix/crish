/**
 * CONN-E3 · mirrorDetectSchedule 纯调度测
 *
 * - 默认 / disabled：零 detect、零 timer
 * - enable + ipc：detect 一次 → report 可达
 * - intervalMs>0：timer 存在；stop 清 timer
 * ≠ EL-03；≠ inotify 满关
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMirrorDetectScheduler,
  runMirrorDetectOnce,
} from './mirrorDetectSchedule';
import { createMockNoteMirrorIpc } from './noteMirrorIpc';

describe('mirrorDetectSchedule · CONN-E3', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('conn_e3_schedule_run_once_maps_report', async () => {
    const ipc = createMockNoteMirrorIpc({
      d1: { class: 'mirror_only', path: '/t/d1.md', pendingLag: 1 },
    });
    const r = await runMirrorDetectOnce(ipc, { docId: 'd1' });
    expect(r.outcome.ok).toBe(true);
    expect(r.report?.docId).toBe('d1');
    expect(r.report?.class).toBe('mirror_only');
    expect(r.report?.pendingLag).toBe(1);
    expect(ipc.detectCalls).toHaveLength(1);
  });

  it('conn_e3_schedule_disabled_no_detect_no_timer', async () => {
    const ipc = createMockNoteMirrorIpc({ d1: { class: 'both' } });
    const onReport = vi.fn();
    const s = createMirrorDetectScheduler(() => ({
      enabled: false,
      docId: 'd1',
      ipc,
      intervalMs: 1000,
      onReport,
    }));

    expect(s.isActive()).toBe(false);
    const started = s.start();
    expect(started).toBeNull();
    expect(s.hasIntervalTimer()).toBe(false);
    expect(ipc.detectCalls).toHaveLength(0);
    expect(onReport).not.toHaveBeenCalled();

    const inactive = await s.runOnce();
    expect(inactive.outcome.ok).toBe(false);
    if (!inactive.outcome.ok) {
      expect(inactive.outcome.code).toBe('note.schedule_inactive');
    }
    expect(ipc.detectCalls).toHaveLength(0);

    s.dispose();
  });

  it('conn_e3_schedule_enabled_detect_once_no_interval_by_default', async () => {
    const ipc = createMockNoteMirrorIpc({
      d1: { class: 'authority_only' },
    });
    const reports: string[] = [];
    const s = createMirrorDetectScheduler(() => ({
      enabled: true,
      docId: 'd1',
      ipc,
      onReport: (r) => reports.push(r.class),
    }));

    expect(s.isActive()).toBe(true);
    const first = s.start();
    expect(first).not.toBeNull();
    const result = await first!;
    expect(result.report?.class).toBe('authority_only');
    expect(reports).toEqual(['authority_only']);
    expect(ipc.detectCalls).toHaveLength(1);
    expect(s.hasIntervalTimer()).toBe(false);

    // 推进时间也不再 detect
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ipc.detectCalls).toHaveLength(1);

    s.dispose();
  });

  it('conn_e3_schedule_interval_timer_and_stop', async () => {
    const ipc = createMockNoteMirrorIpc({
      d1: { class: 'mirror_only' },
    });
    const s = createMirrorDetectScheduler(() => ({
      enabled: true,
      docId: 'd1',
      ipc,
      intervalMs: 5000,
    }));

    const first = s.start();
    await first;
    expect(ipc.detectCalls).toHaveLength(1);
    expect(s.hasIntervalTimer()).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(ipc.detectCalls.length).toBeGreaterThanOrEqual(2);

    s.stop();
    expect(s.hasIntervalTimer()).toBe(false);
    const afterStop = ipc.detectCalls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ipc.detectCalls).toHaveLength(afterStop);

    s.dispose();
  });

  it('conn_e3_schedule_detect_failure_no_fake_report', async () => {
    const ipc = createMockNoteMirrorIpc();
    ipc.setNextError({ code: 'note.detect_failed', reason: 'boom' });
    const onReport = vi.fn();
    const onError = vi.fn();
    const s = createMirrorDetectScheduler(() => ({
      enabled: true,
      docId: 'missing',
      ipc,
      onReport,
      onError,
    }));
    const r = await s.start();
    expect(r?.report).toBeNull();
    expect(r?.outcome.ok).toBe(false);
    expect(onReport).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'note.detect_failed' })
    );
    s.dispose();
  });
});
