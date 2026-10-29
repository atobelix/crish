import { beforeEach, describe, expect, it } from 'vitest';
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';
import {
  getControlMetrics,
  getSnapshot,
  incControlMetric,
  record,
  recordDraftCommit,
  recordDraftEnter,
  recordHydratePrune,
  recordMessageUpsert,
  recordRunControlLevel,
  recordSessionMaterialize,
  recordShellEmptyAssert,
  recordSilentComplete,
  reset,
  resetControlMetrics,
} from './controlMetrics';
import { EMPTY_SESSION_TITLE, prepareSessionsForUi } from './sessionTitle';

describe('controlMetrics (D2 lite)', () => {
  beforeEach(() => {
    resetControlMetrics();
  });

  it('starts at zero after reset', () => {
    expect(getControlMetrics()).toEqual({
      run_control_L1: 0,
      run_control_L2: 0,
      run_control_L3: 0,
      draft_enter: 0,
      draft_commit: 0,
      message_upsert: 0,
      hydrate_prune: 0,
      shell_empty_assert: 0,
      silent_complete: 0,
    });
  });

  it('incControlMetric / record accumulate', () => {
    incControlMetric('draft_enter');
    record('draft_enter');
    expect(getControlMetrics().draft_enter).toBe(2);
  });

  it('incControlMetric ignores non-positive n', () => {
    incControlMetric('message_upsert', 0);
    incControlMetric('message_upsert', -3);
    expect(getControlMetrics().message_upsert).toBe(0);
    incControlMetric('message_upsert', 2);
    expect(getControlMetrics().message_upsert).toBe(2);
  });

  it('recordRunControlLevel maps L1/L2/L3; ignores L0', () => {
    recordRunControlLevel(RUN_CONTROL_LEVEL.L0);
    recordRunControlLevel(RUN_CONTROL_LEVEL.L1);
    recordRunControlLevel('cooperative_stop');
    recordRunControlLevel(RUN_CONTROL_LEVEL.L3);
    recordRunControlLevel(null);
    recordRunControlLevel(undefined);
    const m = getControlMetrics();
    expect(m.run_control_L1).toBe(1);
    expect(m.run_control_L2).toBe(1);
    expect(m.run_control_L3).toBe(1);
  });

  it('recordDraftEnter / recordDraftCommit / session.materialize', () => {
    recordDraftEnter();
    recordDraftCommit();
    recordSessionMaterialize();
    const m = getControlMetrics();
    expect(m.draft_enter).toBe(1);
    expect(m.draft_commit).toBe(2);
  });

  it('recordMessageUpsert / hydrate_prune / shell_empty_assert / silent_complete', () => {
    recordMessageUpsert();
    recordMessageUpsert();
    recordHydratePrune(3);
    recordShellEmptyAssert(2);
    recordSilentComplete();
    recordSilentComplete(2);
    const m = getSnapshot();
    expect(m.message_upsert).toBe(2);
    expect(m.hydrate_prune).toBe(3);
    expect(m.shell_empty_assert).toBe(2);
    expect(m.silent_complete).toBe(3);
  });

  it('getControlMetrics / getSnapshot return independent copies', () => {
    recordDraftEnter();
    const snap = getControlMetrics() as { draft_enter: number };
    snap.draft_enter = 99;
    expect(getSnapshot().draft_enter).toBe(1);
  });

  it('reset() alias clears counters', () => {
    record('message_upsert', 5);
    reset();
    expect(getControlMetrics().message_upsert).toBe(0);
  });

  it('prepareSessionsForUi records hydrate_prune for removed shells', () => {
    const sessions = [
      {
        id: 'ghost-a',
        title: EMPTY_SESSION_TITLE,
        messages: [] as { sender?: string; text?: string }[],
      },
      {
        id: 'keep-active',
        title: EMPTY_SESSION_TITLE,
        messages: [] as { sender?: string; text?: string }[],
      },
      {
        id: 'real',
        title: '有内容',
        messages: [{ sender: 'user', text: 'hi' }],
      },
    ];
    const next = prepareSessionsForUi(sessions, 'keep-active');
    expect(next.map((s) => s.id).sort()).toEqual(['keep-active', 'real']);
    expect(getControlMetrics().hydrate_prune).toBe(1);
  });
});
