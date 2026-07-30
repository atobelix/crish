import { describe, expect, it, vi } from 'vitest';
import { LifecycleHookRegistry, adaptAgentHooks } from './lifecycle-hooks';

describe('LifecycleHookRegistry', () => {
  it('observe 收到 emit 事件', async () => {
    const reg = new LifecycleHookRegistry();
    const seen: number[] = [];
    reg.observe('turn.end', (p) => {
      seen.push(p.turnIndex);
    });
    await reg.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 3,
      toolCallCount: 1,
      maxTurns: 10,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(seen).toEqual([3]);
  });

  it('observe(*) 捕获全部事件类型', async () => {
    const reg = new LifecycleHookRegistry();
    const types: string[] = [];
    reg.observe('*', () => {
      types.push('hit');
    });
    await reg.emit('turn.start', { sessionId: 's', turnIndex: 1 });
    await reg.emit('tool.pre', {
      sessionId: 's',
      toolCallId: 't1',
      toolName: 'read',
      input: {},
      turnIndex: 1,
      cwd: '/',
    });
    expect(types).toHaveLength(2);
  });

  it('on(turn.end) stop 建议合并', async () => {
    const reg = new LifecycleHookRegistry();
    reg.on('turn.end', () => ({ stop: false }));
    reg.on('turn.end', () => ({ stop: true, reason: 'policy' }));
    const result = await reg.emit('turn.end', {
      sessionId: 's',
      turnIndex: 1,
      toolCallCount: 0,
      maxTurns: 5,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(result.stop).toBe(true);
  });

  it('on(tool.pre) 可 block', async () => {
    const reg = new LifecycleHookRegistry();
    reg.on('tool.pre', () => ({ block: true, reason: 'deny' }));
    const result = await reg.emit('tool.pre', {
      sessionId: 's',
      toolCallId: 'c1',
      toolName: 'shell',
      input: { cmd: 'rm' },
      turnIndex: 1,
      cwd: '/',
    });
    expect(result.block).toBe(true);
    expect(result.reason).toBe('deny');
  });

  it('observe 失败不抛、不阻断 on', async () => {
    const reg = new LifecycleHookRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.observe('turn.start', () => {
      throw new Error('boom');
    });
    let onHit = false;
    reg.on('turn.start', () => {
      onHit = true;
    });
    await reg.emit('turn.start', { sessionId: 's', turnIndex: 1 });
    expect(onHit).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('unsubscribe 后不再触发', async () => {
    const reg = new LifecycleHookRegistry();
    let n = 0;
    const unsub = reg.observe('turn.start', () => {
      n += 1;
    });
    unsub();
    await reg.emit('turn.start', { sessionId: 's', turnIndex: 1 });
    expect(n).toBe(0);
  });

  it('adaptAgentHooks 桥接 shouldStopAfterTurn', async () => {
    const reg = new LifecycleHookRegistry();
    adaptAgentHooks(reg, {
      shouldStopAfterTurn: () => true,
    });
    const result = await reg.emit('turn.end', {
      sessionId: 's',
      turnIndex: 2,
      toolCallCount: 0,
      maxTurns: 10,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(result.stop).toBe(true);
  });

  it('createLifecycleToolMiddleware: tool.pre block → proceed=false', async () => {
    const { createLifecycleToolMiddleware } = await import('./lifecycle-hooks');
    const reg = new LifecycleHookRegistry();
    reg.on('tool.pre', () => ({ block: true, reason: 'deny-shell' }));
    const mw = createLifecycleToolMiddleware(reg, () => ({
      sessionId: 's',
      turnIndex: 2,
      cwd: '/w',
    }));
    const result = await mw.beforeExecute(
      { id: 'c1', toolName: 'shell', input: { cmd: 'rm' } },
      { sessionId: 's', cwd: '/w' },
    );
    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('deny-shell');
  });

  it('createLifecycleToolMiddleware: tool.post receives output and may modify', async () => {
    const { createLifecycleToolMiddleware } = await import('./lifecycle-hooks');
    const reg = new LifecycleHookRegistry();
    const seen: unknown[] = [];
    reg.on('tool.post', (p) => {
      seen.push(p.output);
      return { modifiedOutput: { text: 'rewritten' } };
    });
    const mw = createLifecycleToolMiddleware(reg, () => ({
      sessionId: 's',
      turnIndex: 1,
      cwd: '/',
    }));
    const out = await mw.onResult(
      { id: 'c1', toolName: 'read', input: {} },
      { sessionId: 's', cwd: '/' },
      { text: 'raw' },
    );
    expect(seen).toEqual([{ text: 'raw' }]);
    expect(out).toEqual({ text: 'rewritten' });
  });
});
