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
