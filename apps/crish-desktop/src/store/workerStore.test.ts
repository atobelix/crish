/**
 * workerStore 单测：killWorker / triggerCronJobNow / applyTelemetryWorkers +
 * 持久化分片（crish-workers-v1 仅 killedWorkerIds）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkerStore } from './workerStore';
import { useSettingsStore } from './settingsStore';

beforeEach(() => {
  localStorage.clear();
  useWorkerStore.setState({
    activeWorkers: [],
    killedWorkerIds: [],
    manuallyTriggeredWorkers: [],
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('workerStore — manual workers', () => {
  it('triggerCronJobNow seeds a manual worker with safe label', () => {
    const s = useWorkerStore.getState();
    const before = s.activeWorkers.length;
    s.triggerCronJobNow('  deploy  ');
    let st = useWorkerStore.getState();
    expect(st.activeWorkers.length).toBe(before + 1);
    expect(st.manuallyTriggeredWorkers.length).toBe(before + 1);
    expect(st.activeWorkers[st.activeWorkers.length - 1]!.taskName).toContain(
      'deploy'
    );

    s.triggerCronJobNow('   ');
    st = useWorkerStore.getState();
    const last = st.activeWorkers.slice(-1)[0]!;
    expect(last.taskName).toContain('task');
    expect(last.id).toMatch(/^worker-manual-/);
  });
});

describe('workerStore — killWorker', () => {
  it('removes worker from both lists and records killed id', () => {
    const s = useWorkerStore.getState();
    s.applyTelemetryWorkers({
      activeWorkers: [
        { id: 'live', taskName: 't', elapsedSeconds: 1 },
        { id: 'dead', taskName: 'd', elapsedSeconds: 2 },
      ],
    });
    s.killWorker('dead', 'd');
    const st = useWorkerStore.getState();
    expect(st.activeWorkers.some((w) => w.id === 'dead')).toBe(false);
    expect(st.activeWorkers.some((w) => w.id === 'live')).toBe(true);
    expect(st.killedWorkerIds).toContain('dead');
  });

  it('killWorker with empty id is a guarded no-op', () => {
    const s = useWorkerStore.getState();
    s.killWorker('', 't');
    expect(useWorkerStore.getState().killedWorkerIds).toEqual([]);
  });
});

describe('workerStore — applyTelemetryWorkers', () => {
  it('increments manual worker elapsed and merges live workers after killed filter', () => {
    const s = useWorkerStore.getState();
    s.triggerCronJobNow('job');
    s.applyTelemetryWorkers({
      activeWorkers: [
        { id: 'live', taskName: 't', elapsedSeconds: 1 },
        { id: 'dead', taskName: 'd', elapsedSeconds: 9 },
      ],
    });
    let st = useWorkerStore.getState();
    expect(st.activeWorkers.some((w) => w.id === 'live')).toBe(true);
    expect(st.activeWorkers.some((w) => w.id === 'dead')).toBe(true);

    s.killWorker('dead', 'd');
    s.applyTelemetryWorkers({
      activeWorkers: [{ id: 'dead', taskName: 'd', elapsedSeconds: 9 }],
    });
    st = useWorkerStore.getState();
    expect(st.activeWorkers.some((w) => w.id === 'dead')).toBe(false);
    expect(st.activeWorkers.some((w) => w.id === 'live')).toBe(false);
    // 手动 worker elapsed 随每次遥测递增（本测试共同步 2 次 → +4）
    const manual = st.manuallyTriggeredWorkers[0];
    expect(manual).toBeDefined();
    expect(manual!.elapsedSeconds).toBe(4);
  });

  it('ignores id-less / malformed worker entries', () => {
    const s = useWorkerStore.getState();
    s.applyTelemetryWorkers({
      activeWorkers: [
        { id: 'ok', taskName: 'a', elapsedSeconds: 0 },
        { id: '', taskName: 'x', elapsedSeconds: 1 },
        { taskName: 'no-id', elapsedSeconds: 1 },
        null,
      ] as never,
    });
    const st = useWorkerStore.getState();
    expect(st.activeWorkers.map((w) => w.id)).toEqual(['ok']);
  });
});

describe('workerStore — persistence (crish-workers-v1)', () => {
  it('killWorker writes killedWorkerIds into localStorage slice', () => {
    const s = useWorkerStore.getState();
    s.killWorker('w-1', 't');
    const raw = localStorage.getItem('crish-workers-v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { state: { killedWorkerIds: string[] } };
    expect(parsed.state.killedWorkerIds).toEqual(['w-1']);
  });

  it('rehydrates killedWorkerIds on a fresh module import', async () => {
    const s = useWorkerStore.getState();
    s.killWorker('w-2', 't');
    vi.resetModules();
    const { useWorkerStore: freshWorker } = await import('./workerStore');
    expect(freshWorker.getState().killedWorkerIds).toEqual(['w-2']);
    // 运行态字段不落盘、不回流
    expect(freshWorker.getState().activeWorkers).toEqual([]);
  });

  it('cross-store: settingsStore.syncTelemetryData lands workers via applyTelemetryWorkers', () => {
    const s = useSettingsStore.getState();
    s.syncTelemetryData({
      activeWorkers: [{ id: 'engine-w', taskName: 'run', elapsedSeconds: 5 }],
    });
    const st = useWorkerStore.getState();
    expect(st.activeWorkers.some((w) => w.id === 'engine-w')).toBe(true);
  });
});
