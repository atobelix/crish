import { describe, expect, it } from 'vitest';
import { ControlBus } from './control-bus';
import { levelForKind } from './types';
import { createTextMessage } from '../session';

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
