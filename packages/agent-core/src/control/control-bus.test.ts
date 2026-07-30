import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage } from '@crish/shared-types';
import { createTextMessage } from '@crish/agent-context';
import { ControlBus } from './control-bus';
import { levelForKind } from './types';

describe('ControlBus', () => {
  it('request 入队并补齐 id/level/createdAt', () => {
    const bus = new ControlBus();
    const intent = bus.request({ kind: 'cooperative_stop', reason: 'user-stop' });
    expect(intent.id).toBeTruthy();
    expect(intent.level).toBe('L2');
    expect(intent.createdAt).toBeGreaterThan(0);
    expect(intent.reason).toBe('user-stop');
    expect(bus.hasPending()).toBe(true);
    expect(bus.peek()?.kind).toBe('cooperative_stop');
  });

  it('continue 不入队', () => {
    const bus = new ControlBus();
    bus.request({ kind: 'continue' });
    expect(bus.hasPending()).toBe(false);
  });

  it('levelForKind 映射正确', () => {
    expect(levelForKind('soft_inject')).toBe('L1');
    expect(levelForKind('steer')).toBe('L1');
    expect(levelForKind('follow_up')).toBe('L1');
    expect(levelForKind('cooperative_stop')).toBe('L2');
    expect(levelForKind('force_cancel')).toBe('L3');
    expect(levelForKind('continue')).toBe('L0');
  });

  it('drain 清空队列', () => {
    const bus = new ControlBus();
    bus.requestSoftInject(createTextMessage('user', 'hi'));
    bus.requestCooperativeStop('done');
    const all = bus.drain();
    expect(all).toHaveLength(2);
    expect(bus.hasPending()).toBe(false);
    expect(bus.drain()).toEqual([]);
  });

  it('drainAsAction: force_cancel 优先于 cooperative_stop', () => {
    const bus = new ControlBus();
    bus.requestCooperativeStop('soft-stop');
    bus.requestForceCancel('kill');
    const action = bus.drainAsAction();
    expect(action.type).toBe('force_cancel');
    if (action.type === 'force_cancel') {
      expect(action.reason).toBe('kill');
    }
    expect(bus.hasPending()).toBe(false);
  });

  it('drainAsAction: cooperative_stop 带 pending soft messages', () => {
    const bus = new ControlBus();
    const msg = createTextMessage('user', 'steer-me');
    bus.requestSoftInject(msg);
    bus.requestCooperativeStop('enough');
    const action = bus.drainAsAction();
    expect(action.type).toBe('cooperative_stop');
    if (action.type === 'cooperative_stop') {
      expect(action.reason).toBe('enough');
      expect(action.pendingMessages).toHaveLength(1);
      expect(action.pendingMessages[0]).toBe(msg);
    }
  });

  it('drainAsAction: 仅 soft_inject 批量', () => {
    const bus = new ControlBus();
    bus.requestSoftInject(createTextMessage('user', 'a'));
    bus.request({ kind: 'steer', message: createTextMessage('user', 'b') });
    const action = bus.drainAsAction();
    expect(action.type).toBe('soft_inject');
    if (action.type === 'soft_inject') {
      expect(action.messages).toHaveLength(2);
      expect(action.steerMessages).toHaveLength(2);
      expect(action.followUpMessages).toHaveLength(0);
    }
  });

  it('drainAsAction: steer 与 follow_up 分环', () => {
    const bus = new ControlBus();
    bus.requestSteer(createTextMessage('user', 'steer-now'));
    bus.requestFollowUp(createTextMessage('user', 'later'));
    const action = bus.drainAsAction();
    expect(action.type).toBe('soft_inject');
    if (action.type === 'soft_inject') {
      expect(action.steerMessages.map((m) => (m.blocks[0] as { text?: string }).text)).toEqual([
        'steer-now',
      ]);
      expect(action.followUpMessages.map((m) => (m.blocks[0] as { text?: string }).text)).toEqual([
        'later',
      ]);
      expect(action.messages).toHaveLength(2);
    }
  });

  it('便捷方法 requestSoftInject / requestForceCancel', () => {
    const bus = new ControlBus();
    const soft = bus.requestSoftInject(createTextMessage('user', 'x'), 'nudge', 'ui');
    expect(soft.kind).toBe('soft_inject');
    expect(soft.level).toBe('L1');
    expect(soft.source).toBe('ui');

    bus.clear();
    const force = bus.requestForceCancel('panic', 'system');
    expect(force.level).toBe('L3');
    expect(bus.drainAsAction().type).toBe('force_cancel');
  });
});

describe('ControlBus L1 send（点对点）', () => {
  it('send 投递到已注册 target 并返回 true', () => {
    const bus = new ControlBus();
    const received: AgentMessage[] = [];
    bus.registerTarget('ui', (m) => {
      received.push(m);
    });
    const msg = createTextMessage('user', 'hi');
    expect(bus.send('ui', msg)).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(msg);
  });

  it('send 未注册 target 返回 false 且不抛错', () => {
    const bus = new ControlBus();
    expect(bus.send('nope', createTextMessage('user', 'x'))).toBe(false);
  });

  it('registerTarget 返回的 unregister 移除 target', () => {
    const bus = new ControlBus();
    let count = 0;
    const off = bus.registerTarget('t', () => {
      count += 1;
    });
    expect(bus.send('t', createTextMessage('user', 'x'))).toBe(true);
    off();
    expect(bus.send('t', createTextMessage('user', 'x'))).toBe(false);
    expect(count).toBe(1);
  });

  it('registerTarget 重复注册同 target 覆盖，旧 unregister 不误删新注册者', () => {
    const bus = new ControlBus();
    const a: AgentMessage[] = [];
    const b: AgentMessage[] = [];
    const offA = bus.registerTarget('t', (m) => {
      a.push(m);
    });
    bus.registerTarget('t', (m) => {
      b.push(m);
    });
    bus.send('t', createTextMessage('user', 'x'));
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
    offA();
    expect(bus.send('t', createTextMessage('user', 'y'))).toBe(true);
    expect(b).toHaveLength(2);
  });

  it('send 异步 handler fire-and-forget，不阻断调用方', async () => {
    const bus = new ControlBus();
    let done = false;
    bus.registerTarget('async', async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    expect(bus.send('async', createTextMessage('user', 'x'))).toBe(true);
    expect(done).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(true);
  });

  it('send 异步 handler 抛错被吞掉，不抛出未捕获 rejection', async () => {
    const bus = new ControlBus();
    bus.registerTarget('bad', async () => {
      throw new Error('boom');
    });
    expect(() => bus.send('bad', createTextMessage('user', 'x'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('ControlBus L2 subscribe（AgentEvent 流）', () => {
  it('subscribe 指定类型仅收到匹配事件（类型收窄）', () => {
    const bus = new ControlBus();
    const seen: number[] = [];
    bus.subscribe('turn-end', (e) => {
      // e 在此处被收窄为 turn-end，可安全访问 toolCallCount
      seen.push(e.toolCallCount);
    });
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    bus.publish({ type: 'turn-end', sessionId: 's', turnIndex: 0, timestamp: 't', toolCallCount: 3 });
    expect(seen).toEqual([3]);
  });

  it("subscribe '*' 收到所有事件", () => {
    const bus = new ControlBus();
    const seen: AgentEvent['type'][] = [];
    bus.subscribe('*', (e) => {
      seen.push(e.type);
    });
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    bus.publish({ type: 'agent-end', sessionId: 's', timestamp: 't', reason: 'stop' });
    expect(seen).toEqual(['turn-start', 'agent-end']);
  });

  it('subscribe 返回的 unsubscribe 停止接收', () => {
    const bus = new ControlBus();
    const seen: AgentEvent[] = [];
    const off = bus.subscribe('turn-start', (e) => {
      seen.push(e);
    });
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    off();
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 1, timestamp: 't' });
    expect(seen).toHaveLength(1);
  });

  it('同一类型多次 subscribe，publish 分发到全部', () => {
    const bus = new ControlBus();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    bus.subscribe('turn-start', (e) => {
      a.push(e);
    });
    bus.subscribe('turn-start', (e) => {
      b.push(e);
    });
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('subscribe 同步抛错不阻断后续订阅器', () => {
    const bus = new ControlBus();
    const next: AgentEvent[] = [];
    bus.subscribe('turn-start', () => {
      throw new Error('boom');
    });
    bus.subscribe('turn-start', (e) => {
      next.push(e);
    });
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    expect(next).toHaveLength(1);
  });

  it('subscribe 异步 reject 不阻断后续订阅器且无未捕获 rejection', async () => {
    const bus = new ControlBus();
    const next: AgentEvent[] = [];
    bus.subscribe('turn-start', async () => {
      throw new Error('async-boom');
    });
    bus.subscribe('turn-start', (e) => {
      next.push(e);
    });
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    await new Promise((r) => setTimeout(r, 10));
    expect(next).toHaveLength(1);
  });
});

describe('ControlBus 三层共存与 dispose', () => {
  it('L1/L2/L3 可同时工作互不干扰', () => {
    const bus = new ControlBus();
    const sent: AgentMessage[] = [];
    const events: AgentEvent[] = [];

    bus.registerTarget('ui', (m) => {
      sent.push(m);
    });
    bus.subscribe('turn-start', (e) => {
      events.push(e);
    });
    const intent = bus.request({ kind: 'cooperative_stop', reason: 'r' });

    // L1
    bus.send('ui', createTextMessage('user', 'go'));
    // L2
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    // L3
    expect(intent.level).toBe('L2');
    expect(bus.hasPending()).toBe(true);

    expect(sent).toHaveLength(1);
    expect(events).toHaveLength(1);
    const drained = bus.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.kind).toBe('cooperative_stop');
  });

  it('dispose 清理 L1/L2 资源，不影响 L3 队列', () => {
    const bus = new ControlBus();
    let got = false;
    bus.registerTarget('t', () => {
      got = true;
    });
    bus.subscribe('turn-start', () => {});
    bus.request({ kind: 'soft_inject', message: createTextMessage('user', 'x') });

    bus.dispose();

    expect(bus.send('t', createTextMessage('user', 'y'))).toBe(false);
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    expect(got).toBe(false);
    // L3 队列未受影响
    expect(bus.hasPending()).toBe(true);
    expect(bus.drain()).toHaveLength(1);
  });

  it('clear 仅清 L3 队列，不影响 L1/L2', () => {
    const bus = new ControlBus();
    const events: AgentEvent[] = [];
    bus.registerTarget('t', () => {});
    bus.subscribe('turn-start', (e) => {
      events.push(e);
    });
    bus.request({ kind: 'cooperative_stop' });

    bus.clear();

    expect(bus.hasPending()).toBe(false);
    // L1/L2 仍工作
    expect(bus.send('t', createTextMessage('user', 'x'))).toBe(true);
    bus.publish({ type: 'turn-start', sessionId: 's', turnIndex: 0, timestamp: 't' });
    expect(events).toHaveLength(1);
  });
});
