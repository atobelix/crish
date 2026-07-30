import { describe, expect, it } from 'vitest';
import { LifecycleHookRegistry } from './lifecycle-hooks';
import {
  HealthHookPack,
  emptyHealthSnapshot,
  registerBuiltinHealthHooks,
} from './health-hook-pack';

function turnStart(sessionId = 's', turnIndex = 1) {
  return { sessionId, turnIndex };
}

function turnEnd(sessionId = 's', turnIndex = 1) {
  return {
    sessionId,
    turnIndex,
    toolCallCount: 0,
    maxTurns: 10,
    hasPendingInput: false,
    isAborted: false,
  };
}

function toolPre(id: string, name = 'read') {
  return {
    sessionId: 's',
    toolCallId: id,
    toolName: name,
    input: {},
    turnIndex: 1,
    cwd: '/',
  };
}

function toolPost(id: string, opts?: { isError?: boolean; name?: string }) {
  return {
    sessionId: 's',
    toolCallId: id,
    toolName: opts?.name ?? 'read',
    input: {},
    output: { text: opts?.isError ? 'err' : 'ok' },
    ...(opts?.isError !== undefined ? { isError: opts.isError } : {}),
    turnIndex: 1,
    cwd: '/',
  };
}

describe('HealthHookPack / registerBuiltinHealthHooks', () => {
  it('registerBuiltinHealthHooks is observe-only (never block/terminate)', async () => {
    const reg = new LifecycleHookRegistry();
    registerBuiltinHealthHooks(reg);

    const pre = await reg.emit('tool.pre', toolPre('c1'));
    expect(pre.block).toBeUndefined();
    expect(pre.terminate).toBeUndefined();
    expect(pre.stop).toBeUndefined();

    const post = await reg.emit('tool.post', toolPost('c1'));
    expect(post.block).toBeUndefined();
    expect(post.terminate).toBeUndefined();

    const end = await reg.emit('turn.end', turnEnd());
    expect(end.stop).toBeUndefined();
  });

  it('counts turn.start / turn.end after simulated emits', async () => {
    const reg = new LifecycleHookRegistry();
    const pack = registerBuiltinHealthHooks(reg);

    await reg.emit('turn.start', turnStart('s', 1));
    await reg.emit('turn.end', turnEnd('s', 1));
    await reg.emit('turn.start', turnStart('s', 2));
    await reg.emit('turn.end', turnEnd('s', 2));

    const snap = pack.getHealthSnapshot();
    expect(snap.turnStartCount).toBe(2);
    expect(snap.turnEndCount).toBe(2);
    expect(snap.lastTurnDurationMs).not.toBeNull();
    expect(snap.turnDurationMsAvg).not.toBeNull();
    expect(snap.turnDurationMsTotal).toBeGreaterThanOrEqual(0);
  });

  it('counts tool.pre / tool.post and error consecutive', async () => {
    const reg = new LifecycleHookRegistry();
    const pack = registerBuiltinHealthHooks(reg);

    await reg.emit('tool.pre', toolPre('a'));
    await reg.emit('tool.post', toolPost('a', { isError: true }));
    await reg.emit('tool.pre', toolPre('b'));
    await reg.emit('tool.post', toolPost('b', { isError: true }));
    await reg.emit('tool.pre', toolPre('c'));
    await reg.emit('tool.post', toolPost('c', { isError: false }));

    const snap = pack.getHealthSnapshot();
    expect(snap.toolPreCount).toBe(3);
    expect(snap.toolPostCount).toBe(3);
    expect(snap.toolErrorCount).toBe(2);
    expect(snap.toolOpenCount).toBe(0);
    expect(snap.toolBlockRate).toBe(0);
    expect(snap.consecutiveToolErrors).toBe(0); // cleared after success
    expect(snap.maxConsecutiveToolErrors).toBe(2);
  });

  it('toolBlockRate rises when pre has no post (block simulation)', async () => {
    const reg = new LifecycleHookRegistry();
    const pack = registerBuiltinHealthHooks(reg);

    // One blocked (no post), one allowed (with post)
    await reg.emit('tool.pre', toolPre('blocked'));
    await reg.emit('tool.pre', toolPre('ok'));
    await reg.emit('tool.post', toolPost('ok'));

    const snap = pack.getHealthSnapshot();
    expect(snap.toolPreCount).toBe(2);
    expect(snap.toolPostCount).toBe(1);
    expect(snap.toolOpenCount).toBe(1);
    expect(snap.toolBlockRate).toBe(0.5);
  });

  it('does not prevent other on() handlers from blocking', async () => {
    const reg = new LifecycleHookRegistry();
    registerBuiltinHealthHooks(reg);
    reg.on('tool.pre', () => ({ block: true, reason: 'policy' }));

    const result = await reg.emit('tool.pre', toolPre('x'));
    expect(result.block).toBe(true);
    expect(result.reason).toBe('policy');
  });

  it('reset clears counters; dispose stops further updates', async () => {
    const reg = new LifecycleHookRegistry();
    const pack = registerBuiltinHealthHooks(reg);

    await reg.emit('turn.start', turnStart());
    expect(pack.getHealthSnapshot().turnStartCount).toBe(1);

    pack.reset();
    expect(pack.getHealthSnapshot()).toMatchObject(emptyHealthSnapshot());

    await reg.emit('turn.start', turnStart('s', 2));
    expect(pack.getHealthSnapshot().turnStartCount).toBe(1);

    pack.dispose();
    await reg.emit('turn.start', turnStart('s', 3));
    expect(pack.getHealthSnapshot().turnStartCount).toBe(1); // no new count
  });

  it('HealthHookPack.register is idempotent', async () => {
    const reg = new LifecycleHookRegistry();
    const pack = new HealthHookPack();
    pack.register(reg);
    pack.register(reg); // second call no-op

    await reg.emit('tool.pre', toolPre('once'));
    expect(pack.getHealthSnapshot().toolPreCount).toBe(1);
  });

  it('AgentSessionLoop-style: loop registry can host pack via registerBuiltinHealthHooks', async () => {
    // Mirrors session-loop wire: new registry → registerBuiltinHealthHooks
    const lifecycleHooks = new LifecycleHookRegistry();
    const healthPack = registerBuiltinHealthHooks(lifecycleHooks);

    await lifecycleHooks.emit('turn.start', turnStart('sess', 0));
    await lifecycleHooks.emit('tool.pre', toolPre('t1', 'echo'));
    await lifecycleHooks.emit('tool.post', toolPost('t1', { name: 'echo' }));
    await lifecycleHooks.emit('turn.end', turnEnd('sess', 0));

    const snap = healthPack.getHealthSnapshot();
    expect(snap.turnStartCount).toBe(1);
    expect(snap.turnEndCount).toBe(1);
    expect(snap.toolPreCount).toBe(1);
    expect(snap.toolPostCount).toBe(1);
    expect(snap.toolBlockRate).toBe(0);
  });

  it('counts context.compact.start/end and abort without blocking', async () => {
    const reg = new LifecycleHookRegistry();
    const pack = registerBuiltinHealthHooks(reg);

    const start = await reg.emit('context.compact.start', {
      sessionId: 's',
      trigger: 'auto',
      tokensBefore: 1000,
    });
    expect(start.block).toBeUndefined();
    expect(start.terminate).toBeUndefined();
    expect(start.stop).toBeUndefined();

    await reg.emit('context.compact.end', {
      sessionId: 's',
      aborted: false,
      trigger: 'auto',
      tokensBefore: 1000,
      tokensAfter: 400,
      durationMs: 42,
    });

    await reg.emit('context.compact.start', { sessionId: 's' });
    const endAbort = await reg.emit('context.compact.end', {
      sessionId: 's',
      aborted: true,
      error: 'region-fail',
      durationMs: 7,
    });
    expect(endAbort.block).toBeUndefined();

    const snap = pack.getHealthSnapshot();
    expect(snap.compactStartCount).toBe(2);
    expect(snap.compactEndCount).toBe(2);
    expect(snap.compactAbortCount).toBe(1);
    expect(snap.lastCompactDurationMs).toBe(7);
  });

  it('compact end without durationMs leaves lastCompactDurationMs unchanged', async () => {
    const reg = new LifecycleHookRegistry();
    const pack = registerBuiltinHealthHooks(reg);

    await reg.emit('context.compact.start', { sessionId: 's' });
    await reg.emit('context.compact.end', {
      sessionId: 's',
      aborted: false,
      durationMs: 15,
    });
    expect(pack.getHealthSnapshot().lastCompactDurationMs).toBe(15);

    await reg.emit('context.compact.end', {
      sessionId: 's',
      aborted: false,
    });
    expect(pack.getHealthSnapshot().lastCompactDurationMs).toBe(15);
  });
});
