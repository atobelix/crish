import { describe, expect, it, vi } from 'vitest';
import { SessionStreamManager } from './sessionStreamManager';

describe('SessionStreamManager', () => {
  it('replace cancels previous handle for same session', () => {
    const mgr = new SessionStreamManager();
    const cancel1 = vi.fn();
    const cancel2 = vi.fn();
    mgr.set('s1', {
      cancel: cancel1,
      userMsgId: 'u1',
      assistantMsgId: 'a1',
      runId: null,
    });
    mgr.replace('s1', {
      cancel: cancel2,
      userMsgId: 'u2',
      assistantMsgId: 'a2',
      runId: null,
    });
    expect(cancel1).toHaveBeenCalledTimes(1);
    expect(mgr.get('s1')?.assistantMsgId).toBe('a2');
  });

  it('cancelSession removes and cancels', () => {
    const mgr = new SessionStreamManager();
    const cancel = vi.fn();
    mgr.set('s1', {
      cancel,
      userMsgId: 'u',
      assistantMsgId: 'a',
      runId: null,
    });
    mgr.cancelSession('s1');
    expect(cancel).toHaveBeenCalled();
    expect(mgr.get('s1')).toBeUndefined();
  });

  it('beginDrain prevents re-entry until endDrain', () => {
    const mgr = new SessionStreamManager();
    expect(mgr.beginDrain('s1')).toBe(true);
    expect(mgr.beginDrain('s1')).toBe(false);
    mgr.endDrain('s1');
    expect(mgr.beginDrain('s1')).toBe(true);
  });

  it('consumeGoalCancelled is one-shot', () => {
    const mgr = new SessionStreamManager();
    mgr.markGoalCancelled('s1');
    expect(mgr.consumeGoalCancelled('s1')).toBe(true);
    expect(mgr.consumeGoalCancelled('s1')).toBe(false);
  });

  it('scheduleStart uses bound starter via microtask', async () => {
    const mgr = new SessionStreamManager();
    const calls: string[] = [];
    mgr.bindStarter((input, userMsgId, sid) => {
      calls.push(`${sid}:${userMsgId}:${input}`);
    });
    mgr.scheduleStart('s1', 'continue', 'u1', (fn) => fn());
    expect(calls).toEqual(['s1:u1:continue']);
  });
});

describe('busyRetry（串行守卫退避计数，FINAL-PLAN P1-d）', () => {
  it('退避 300 → 600 → 1200 → 2400ms', async () => {
    const { busyRetryDelayMs } = await import('./sessionStreamManager');
    expect([1, 2, 3, 4].map(busyRetryDelayMs)).toEqual([300, 600, 1200, 2400]);
  });

  it('noteBusy 累加；clearSession 只清本会话的计数', async () => {
    const m = await import('./sessionStreamManager');
    m.resetBusyRetryForTests();
    expect(m.noteBusy('s1', 'u1')).toBe(1);
    expect(m.noteBusy('s1', 'u1')).toBe(2);
    m.noteBusy('s2', 'u2');
    expect(m.isBusyRetryPending('u1')).toBe(true);
    new m.SessionStreamManager().clearSession('s1');
    expect(m.getBusyAttempt('u1')).toBe(0);
    expect(m.isBusyRetryPending('u1')).toBe(false);
    expect(m.getBusyAttempt('u2')).toBe(1);
    m.resetBusyRetryForTests();
  });
});
