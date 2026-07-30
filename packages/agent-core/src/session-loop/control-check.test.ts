import { describe, expect, it } from 'vitest';
import { ControlBus } from '../control';
import { AgentInputQueue } from '../agent-input-queue';
import { createTextMessage } from '@crish/agent-context';
import {
  checkControlAtSafePoint,
  hasRunnableInput,
  promoteFollowUpAtIdle,
} from './control-check';

describe('checkControlAtSafePoint', () => {
  it('无意图 → none', () => {
    const bus = new ControlBus();
    expect(checkControlAtSafePoint(bus).kind).toBe('none');
  });

  it('force_cancel → aborted 语义', () => {
    const bus = new ControlBus();
    bus.requestForceCancel('kill');
    const r = checkControlAtSafePoint(bus);
    expect(r.kind).toBe('force_cancel');
    if (r.kind === 'force_cancel') {
      expect(r.endReason).toBe('aborted');
      expect(r.reason).toBe('kill');
    }
  });

  it('cooperative_stop → stop（L2，非 abort）', () => {
    const bus = new ControlBus();
    bus.requestCooperativeStop('user-stop');
    const r = checkControlAtSafePoint(bus);
    expect(r.kind).toBe('cooperative_stop');
    if (r.kind === 'cooperative_stop') {
      expect(r.endReason).toBe('stop');
      expect(r.reason).toBe('user-stop');
    }
  });

  it('soft_inject 写入 inputQueue steer 通道', () => {
    const bus = new ControlBus();
    const q = new AgentInputQueue();
    const msg = createTextMessage('user', 'inject');
    bus.requestSoftInject(msg);
    const r = checkControlAtSafePoint(bus, q);
    expect(r.kind).toBe('soft_inject');
    expect(q.hasSoftPending()).toBe(true);
    expect(q.hasSteerPending()).toBe(true);
    expect(q.hasForcePending()).toBe(false);
    expect(q.hasFollowUpPending()).toBe(false);
    expect(hasRunnableInput(q)).toBe(true);
  });

  it('steer → steer 环；follow_up → followUp 环（pi 分环）', () => {
    const bus = new ControlBus();
    const q = new AgentInputQueue();
    bus.requestSteer(createTextMessage('user', 'steer-now'));
    bus.requestFollowUp(createTextMessage('user', 'after-done'));
    const r = checkControlAtSafePoint(bus, q);
    expect(r.kind).toBe('soft_inject');
    if (r.kind === 'soft_inject') {
      expect(r.steerMessages).toHaveLength(1);
      expect(r.followUpMessages).toHaveLength(1);
    }
    expect(q.hasSteerPending()).toBe(true);
    expect(q.hasFollowUpPending()).toBe(true);
    expect(hasRunnableInput(q)).toBe(true);

    // 安全点只应消费 steer
    q.dequeue();
    expect(q.hasSteerPending()).toBe(false);
    expect(q.hasFollowUpPending()).toBe(true);
    expect(hasRunnableInput(q)).toBe(false);

    // idle promote followUp
    expect(promoteFollowUpAtIdle(q)).toBe(1);
    expect(hasRunnableInput(q)).toBe(true);
    expect(q.hasFollowUpPending()).toBe(false);
  });
});
