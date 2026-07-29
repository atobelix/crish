/**
 * W6-4: after L2/L3 stop, stream manager must not report busy so composer can send again.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionStreamManager } from './sessionStreamManager';

describe('SessionStreamManager continue-after-stop (W6-4)', () => {
  it('after delete (stop finalize), hasStream is false — new prompt accepted', () => {
    const mgr = new SessionStreamManager();
    const cancel = vi.fn();
    mgr.set('sess-1', {
      cancel,
      userMsgId: 'u1',
      assistantMsgId: 'a1',
      runId: 'run-1',
    });
    expect(mgr.hasStream('sess-1')).toBe(true);

    // finalizeStopGeneration deletes then cancels
    mgr.delete('sess-1');
    expect(mgr.hasStream('sess-1')).toBe(false);
    expect(mgr.get('sess-1')).toBeUndefined();

    // continue: new stream can be registered without stuck busy
    mgr.set('sess-1', {
      cancel: vi.fn(),
      userMsgId: 'u2',
      assistantMsgId: 'a2',
      runId: 'run-2',
    });
    expect(mgr.hasStream('sess-1')).toBe(true);
    expect(mgr.get('sess-1')?.assistantMsgId).toBe('a2');
  });

  it('clearSession removes stream and draining so continue is not blocked', () => {
    const mgr = new SessionStreamManager();
    mgr.set('sess-1', {
      cancel: vi.fn(),
      userMsgId: 'u1',
      assistantMsgId: 'a1',
      runId: 'r1',
    });
    mgr.beginDrain('sess-1');
    expect(mgr.clearSession('sess-1')).toBe(true);
    expect(mgr.hasStream('sess-1')).toBe(false);
    // second drain can start after clear
    expect(mgr.beginDrain('sess-1')).toBe(true);
  });
});
