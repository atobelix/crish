import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSessionExecutionTrackerStore } from '../sessionExecutionTrackerStore';

describe('sessionExecutionTrackerStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSessionExecutionTrackerStore.getState().clearAllRuns();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('startRun records new execution with default thinking stage and timestamp', () => {
    const store = useSessionExecutionTrackerStore.getState();
    store.startRun('s1', 'run-1');

    const runs = useSessionExecutionTrackerStore.getState().activeRuns;
    expect(runs['s1']).toBeDefined();
    expect(runs['s1']?.sessionId).toBe('s1');
    expect(runs['s1']?.runId).toBe('run-1');
    expect(runs['s1']?.stage).toBe('thinking');
    expect(runs['s1']?.startTime).toBeGreaterThan(0);
  });

  it('updateRunId updates runId on active execution', () => {
    const store = useSessionExecutionTrackerStore.getState();
    store.startRun('s1', null);
    store.updateRunId('s1', 'run-real-1');

    const item = useSessionExecutionTrackerStore.getState().activeRuns['s1'];
    expect(item?.runId).toBe('run-real-1');
  });

  it('updateStage updates stage and detail, ignoring idempotent updates', () => {
    const store = useSessionExecutionTrackerStore.getState();
    store.startRun('s1', null);
    store.updateStage('s1', 'executing_tool', 'bash');

    const item = useSessionExecutionTrackerStore.getState().activeRuns['s1'];
    expect(item?.stage).toBe('executing_tool');
    expect(item?.stageDetail).toBe('bash');

    // Idempotent update should preserve identical object reference
    const prevRuns = useSessionExecutionTrackerStore.getState().activeRuns;
    store.updateStage('s1', 'executing_tool', 'bash');
    const nextRuns = useSessionExecutionTrackerStore.getState().activeRuns;
    expect(nextRuns).toBe(prevRuns);
  });

  it('markApprovalPending and resolveApproval lifecycle', () => {
    const store = useSessionExecutionTrackerStore.getState();
    store.startRun('s1', null);
    store.markApprovalPending('s1', 'tool-1', 'dangerous_rm');

    let item = useSessionExecutionTrackerStore.getState().activeRuns['s1'];
    expect(item?.stage).toBe('waiting_approval');
    expect(item?.approvalMeta).toEqual({
      toolId: 'tool-1',
      toolName: 'dangerous_rm',
    });

    store.resolveApproval('s1');
    item = useSessionExecutionTrackerStore.getState().activeRuns['s1'];
    expect(item?.stage).toBe('executing_tool');
    expect(item?.approvalMeta).toBeUndefined();
  });

  it('completeRun initiates 3000ms graceful decay window before cleanup', () => {
    const store = useSessionExecutionTrackerStore.getState();
    store.startRun('s1', 'run-1');
    store.completeRun('s1');

    const item = useSessionExecutionTrackerStore.getState().activeRuns['s1'];
    expect(item?.stage).toBe('just_completed');
    expect(item?.stageDetail).toBe('done');
    expect(item?.settledAt).toBeGreaterThan(0);

    // At 1500ms, item is still retained to prevent layout jump
    vi.advanceTimersByTime(1500);
    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['s1']
    ).toBeDefined();

    // At 3000ms, item is cleanly decayed and removed
    vi.advanceTimersByTime(1500);
    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['s1']
    ).toBeUndefined();
  });

  it('failRun sets error stage and decays after timer', () => {
    const store = useSessionExecutionTrackerStore.getState();
    store.startRun('s1', null);
    store.failRun('s1', 'Network timeout');

    const item = useSessionExecutionTrackerStore.getState().activeRuns['s1'];
    expect(item?.stage).toBe('error');
    expect(item?.stageDetail).toBe('Network timeout');

    vi.advanceTimersByTime(3000);
    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['s1']
    ).toBeUndefined();
  });

  it('startRun cancels existing decay timer for re-activated session', () => {
    const store = useSessionExecutionTrackerStore.getState();
    store.startRun('s1', 'run-1');
    store.completeRun('s1');

    // Within 3000ms window, session starts a new run
    vi.advanceTimersByTime(1000);
    store.startRun('s1', 'run-2', 'thinking');

    // Advance past original 3000ms timer
    vi.advanceTimersByTime(2500);
    const item = useSessionExecutionTrackerStore.getState().activeRuns['s1'];
    expect(item).toBeDefined();
    expect(item?.runId).toBe('run-2');
    expect(item?.stage).toBe('thinking');
  });

  it('removeRun explicitly deletes run and cancels decay timer', () => {
    const store = useSessionExecutionTrackerStore.getState();
    store.startRun('s1', null);
    store.completeRun('s1');
    store.removeRun('s1');

    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['s1']
    ).toBeUndefined();
  });
});
