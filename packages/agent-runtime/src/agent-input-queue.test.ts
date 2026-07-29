import { describe, expect, it } from 'vitest';
import { AgentInputQueue } from './agent-input-queue';
import { createTextMessage } from './session';

function textOf(msg: { blocks?: Array<{ type?: string; text?: string }> } | undefined): string | null {
  const b = msg?.blocks?.[0];
  return b && 'text' in b && typeof b.text === 'string' ? b.text : null;
}

describe('AgentInputQueue soft vs force', () => {
  it('默认 enqueue 为 force，可 hasForcePending', () => {
    const q = new AgentInputQueue();
    q.enqueue(createTextMessage('user', 'force'));
    expect(q.hasForcePending()).toBe(true);
    expect(q.hasSoftPending()).toBe(false);
    expect(q.hasPending()).toBe(true);
    expect(q.hasRunnablePending()).toBe(true);
  });

  it('enqueueForce === force 环（显式 mid-stream 路径）', () => {
    const q = new AgentInputQueue();
    q.enqueueForce(createTextMessage('user', 'force-explicit'));
    expect(q.hasForcePending()).toBe(true);
    expect(q.hasSteerPending()).toBe(false);
    expect(textOf(q.dequeueForce())).toBe('force-explicit');
  });

  it('enqueueSoft 不计入 force', () => {
    const q = new AgentInputQueue();
    q.enqueueSoft(createTextMessage('user', 'soft'));
    expect(q.hasForcePending()).toBe(false);
    expect(q.hasSoftPending()).toBe(true);
    expect(q.hasSteerPending()).toBe(true);
    expect(q.hasPending()).toBe(true);
    expect(q.hasRunnablePending()).toBe(true);
  });

  it('enqueueSteer 不 hasForcePending（公共 steer = soft 安全点）', () => {
    const q = new AgentInputQueue();
    q.enqueueSteer(createTextMessage('user', 'pi-steer'));
    expect(q.hasForcePending()).toBe(false);
    expect(q.hasSteerPending()).toBe(true);
    expect(q.dequeueForce()).toBeUndefined();
    expect(textOf(q.dequeue())).toBe('pi-steer');
  });

  it('dequeue 优先 force', () => {
    const q = new AgentInputQueue();
    q.enqueueSoft(createTextMessage('user', 'soft'));
    q.enqueue(createTextMessage('user', 'force'));
    const first = q.dequeue();
    expect(textOf(first)).toBe('force');
  });

  it('dequeueForce 不取出 soft', () => {
    const q = new AgentInputQueue();
    q.enqueueSoft(createTextMessage('user', 'soft'));
    expect(q.dequeueForce()).toBeUndefined();
    expect(q.hasSoftPending()).toBe(true);
  });

  it('drainSoft 清空 soft/steer 通道', () => {
    const q = new AgentInputQueue();
    q.enqueueSoft(createTextMessage('user', 'a'));
    q.enqueueSoft(createTextMessage('user', 'b'));
    q.enqueue(createTextMessage('user', 'force'));
    const soft = q.drainSoft();
    expect(soft).toHaveLength(2);
    expect(q.hasSoftPending()).toBe(false);
    expect(q.hasForcePending()).toBe(true);
  });
});

/**
 * 对齐 pi agent CHANGELOG #403：
 * - steer：下一安全点（force 优先后的 soft 环）；dequeue 可取
 * - followUp：仅 idle 时 promote 后才可 dequeue
 */
describe('AgentInputQueue steer vs followUp (pi semantics)', () => {
  it('enqueueSteer === soft 环（安全点可运行）', () => {
    const q = new AgentInputQueue();
    q.enqueueSteer(createTextMessage('user', 'steer-me'));
    expect(q.hasSteerPending()).toBe(true);
    expect(q.hasSoftPending()).toBe(true);
    expect(q.hasFollowUpPending()).toBe(false);
    expect(q.hasRunnablePending()).toBe(true);
    expect(textOf(q.dequeue())).toBe('steer-me');
  });

  it('enqueueFollowUp 不进入 dequeue / hasRunnablePending', () => {
    const q = new AgentInputQueue();
    q.enqueueFollowUp(createTextMessage('user', 'later'));
    expect(q.hasFollowUpPending()).toBe(true);
    expect(q.hasPending()).toBe(true);
    expect(q.hasRunnablePending()).toBe(false);
    expect(q.hasSteerPending()).toBe(false);
    expect(q.dequeue()).toBeUndefined();
    expect(q.hasFollowUpPending()).toBe(true);
  });

  it('dequeue 顺序 force > steer，永不自动取 followUp', () => {
    const q = new AgentInputQueue();
    q.enqueueFollowUp(createTextMessage('user', 'fu'));
    q.enqueueSteer(createTextMessage('user', 'st'));
    q.enqueue(createTextMessage('user', 'f'), 'force');
    expect(textOf(q.dequeue())).toBe('f');
    expect(textOf(q.dequeue())).toBe('st');
    expect(q.dequeue()).toBeUndefined();
    expect(q.hasFollowUpPending()).toBe(true);
  });

  it('drainFollowUp 清空 followUp 环且不动 steer', () => {
    const q = new AgentInputQueue();
    q.enqueueSteer(createTextMessage('user', 'st'));
    q.enqueueFollowUp(createTextMessage('user', 'a'));
    q.enqueueFollowUp(createTextMessage('user', 'b'));
    const fu = q.drainFollowUp();
    expect(fu.map(textOf)).toEqual(['a', 'b']);
    expect(q.hasFollowUpPending()).toBe(false);
    expect(q.hasSteerPending()).toBe(true);
  });

  it('promoteFollowUp 将 followUp 提升为 steer（idle 路径）', () => {
    const q = new AgentInputQueue();
    q.enqueueFollowUp(createTextMessage('user', 'after-idle'));
    expect(q.hasRunnablePending()).toBe(false);
    expect(q.promoteFollowUp()).toBe(1);
    expect(q.hasFollowUpPending()).toBe(false);
    expect(q.hasRunnablePending()).toBe(true);
    expect(textOf(q.dequeue())).toBe('after-idle');
  });

  it('mode soft 与 steer 等价；mode followUp 独立', () => {
    const q = new AgentInputQueue();
    q.enqueue(createTextMessage('user', 's1'), 'soft');
    q.enqueue(createTextMessage('user', 's2'), 'steer');
    q.enqueue(createTextMessage('user', 'fu'), 'followUp');
    expect(q.drainSteer().map(textOf)).toEqual(['s1', 's2']);
    expect(q.drainFollowUp().map(textOf)).toEqual(['fu']);
  });

  it('length 与 clear 覆盖三环', () => {
    const q = new AgentInputQueue();
    q.enqueue(createTextMessage('user', 'f'));
    q.enqueueSteer(createTextMessage('user', 's'));
    q.enqueueFollowUp(createTextMessage('user', 'u'));
    expect(q.length).toBe(3);
    q.clear();
    expect(q.length).toBe(0);
    expect(q.hasPending()).toBe(false);
  });

  it('pi 场景：tool 批后可取 steer，followUp 仍挂起直至 idle promote', () => {
    const q = new AgentInputQueue();
    // 用户在 tool 执行中提交 steer + followUp
    q.enqueueSteer(createTextMessage('user', 'change direction'));
    q.enqueueFollowUp(createTextMessage('user', 'and then summarize'));

    // 安全点 after tools：仅 runnable
    expect(q.hasRunnablePending()).toBe(true);
    expect(textOf(q.dequeue())).toBe('change direction');
    expect(q.hasRunnablePending()).toBe(false);
    expect(q.hasFollowUpPending()).toBe(true);

    // agent 还会继续 tool 环；followUp 不得被误取
    expect(q.dequeue()).toBeUndefined();

    // 最终 idle：promote followUp
    q.promoteFollowUp();
    expect(textOf(q.dequeue())).toBe('and then summarize');
  });
});
