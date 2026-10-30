import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  busyRetryDelayMs,
  createSessionStreamRegistryForTest,
  getBusyAttempt,
  isBusyRetryPending,
  noteBusy,
  resetBusyRetryForTests,
  type SessionStreamHandle,
} from './sessionStreamManager';
import { StreamRenderBuffer } from './StreamRenderBuffer';
import {
  getSharedTombstoneSet,
  markSessionTombstone,
} from '../utils/lifecycle/ScopedLifecycleRegistry';

function makeHandle(
  assistantMsgId: string,
  cancel: SessionStreamHandle['cancel'] = vi.fn()
): SessionStreamHandle {
  return {
    userMsgId: `u-${assistantMsgId}`,
    assistantMsgId,
    renderBuffer: new StreamRenderBuffer(),
    runId: null,
    cancel,
  };
}

const sync = (fn: () => void) => fn();

afterEach(() => {
  getSharedTombstoneSet().clear();
  resetBusyRetryForTests();
});

describe('SessionStreamRegistry · 句柄', () => {
  it('register 同会话替换：旧句柄以 force 取消并重置其渲染缓冲', () => {
    const reg = createSessionStreamRegistryForTest();
    const cancel1 = vi.fn();
    const first = makeHandle('a1', cancel1);
    const reset = vi.spyOn(first.renderBuffer, 'reset');
    reg.register('s1', first);
    const second = makeHandle('a2');
    expect(reg.register('s1', second)).toBe(first);
    expect(cancel1).toHaveBeenCalledWith('force');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reg.get('s1')).toBe(second);
  });

  it('release 仅移除同一轮句柄（assistantMsgId 守卫），且不取消、不重置缓冲', () => {
    const reg = createSessionStreamRegistryForTest();
    const cancel = vi.fn();
    const h = makeHandle('a1', cancel);
    const reset = vi.spyOn(h.renderBuffer, 'reset');
    reg.register('s1', h);
    expect(reg.release('s1', 'a-other')).toBe(false);
    expect(reg.get('s1')).toBe(h);
    expect(reg.release('s1', 'a1')).toBe(true);
    expect(reg.get('s1')).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('cancel(mode) 移除句柄、透传模式并重置渲染缓冲；无句柄时为空操作', () => {
    const reg = createSessionStreamRegistryForTest();
    const cancel = vi.fn();
    const h = makeHandle('a1', cancel);
    const reset = vi.spyOn(h.renderBuffer, 'reset');
    reg.register('s1', h);
    expect(reg.cancel('s1', 'cooperative')).toBe(h);
    expect(cancel).toHaveBeenCalledWith('cooperative');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reg.get('s1')).toBeUndefined();
    expect(reg.cancel('s1', 'force')).toBeUndefined();
  });

  it('句柄 cancel 抛错：不外抛，句柄仍被移除、缓冲仍被重置', () => {
    const reg = createSessionStreamRegistryForTest();
    const h = makeHandle('a1', () => {
      throw new Error('wire down');
    });
    const reset = vi.spyOn(h.renderBuffer, 'reset');
    reg.register('s1', h);
    expect(() => reg.cancel('s1', 'force')).not.toThrow();
    expect(reg.get('s1')).toBeUndefined();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('停止后（cancel）可立即登记新一轮，不残留忙碌', () => {
    const reg = createSessionStreamRegistryForTest();
    reg.register('s1', makeHandle('a1'));
    reg.cancel('s1', 'cooperative');
    const next = makeHandle('a2');
    expect(reg.register('s1', next)).toBeUndefined();
    expect(reg.get('s1')?.assistantMsgId).toBe('a2');
  });

  it('不同会话句柄互不影响', () => {
    const reg = createSessionStreamRegistryForTest();
    const ha = makeHandle('a');
    const hb = makeHandle('b');
    reg.register('sa', ha);
    reg.register('sb', hb);
    reg.cancel('sa', 'force');
    expect(reg.get('sa')).toBeUndefined();
    expect(reg.get('sb')).toBe(hb);
  });
});

describe('SessionStreamRegistry · drain / goal-cancel / clearSession', () => {
  it('beginDrain 防重入直到 endDrain', () => {
    const reg = createSessionStreamRegistryForTest();
    expect(reg.beginDrain('s1')).toBe(true);
    expect(reg.beginDrain('s1')).toBe(false);
    reg.endDrain('s1');
    expect(reg.beginDrain('s1')).toBe(true);
  });

  it('consumeGoalCancelled 一次性', () => {
    const reg = createSessionStreamRegistryForTest();
    reg.markGoalCancelled('s1');
    expect(reg.consumeGoalCancelled('s1')).toBe(true);
    expect(reg.consumeGoalCancelled('s1')).toBe(false);
  });

  it('clearSession 清空句柄 / drain / goal-cancel / 挂起续写 / busy 计数，不触发 cancel', async () => {
    const reg = createSessionStreamRegistryForTest();
    const cancel = vi.fn();
    reg.register('s1', makeHandle('a1', cancel));
    reg.beginDrain('s1');
    reg.markGoalCancelled('s1');
    noteBusy('s1', 'u1');
    noteBusy('s2', 'u2');
    reg.scheduleStart('s1', 'pending', 'u1', sync);

    expect(reg.clearSession('s1')).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(reg.get('s1')).toBeUndefined();
    expect(reg.beginDrain('s1')).toBe(true);
    expect(reg.consumeGoalCancelled('s1')).toBe(false);
    expect(getBusyAttempt('u1')).toBe(0);
    expect(isBusyRetryPending('u1')).toBe(false);
    expect(getBusyAttempt('u2')).toBe(1);

    const starter = vi.fn();
    reg.bindStarter('s1', starter);
    await Promise.resolve();
    expect(starter).not.toHaveBeenCalled();
    expect(reg.clearSession('s1')).toBe(false);
  });
});

describe('SessionStreamRegistry · starter 与 scheduleStart', () => {
  it('优先该会话自己的 starter（分栏互不覆盖）', () => {
    const reg = createSessionStreamRegistryForTest();
    const a = vi.fn();
    const b = vi.fn();
    reg.bindStarter('sa', a);
    reg.bindStarter('sb', b);
    reg.scheduleStart('sa', 'go-a', 'ua', sync);
    reg.scheduleStart('sb', 'go-b', 'ub', sync);
    expect(a).toHaveBeenCalledExactlyOnceWith('sa', 'go-a', 'ua');
    expect(b).toHaveBeenCalledExactlyOnceWith('sb', 'go-b', 'ub');
  });

  it('会话视图未挂载：由最近登记的 starter 以该 sessionId 定址启动', () => {
    const reg = createSessionStreamRegistryForTest();
    const a = vi.fn();
    const b = vi.fn();
    reg.bindStarter('sa', a);
    reg.bindStarter('sb', b);
    reg.scheduleStart('s-bg', 'go', 'u', sync);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledExactlyOnceWith('s-bg', 'go', 'u');
  });

  it('unbind 只移除本次登记；同会话后登记者生效，解绑后回落到先登记者', () => {
    const reg = createSessionStreamRegistryForTest();
    const first = vi.fn();
    const second = vi.fn();
    reg.bindStarter('s1', first);
    const unbindSecond = reg.bindStarter('s1', second);
    reg.scheduleStart('s1', 'x', 'u1', sync);
    expect(second).toHaveBeenCalledTimes(1);
    unbindSecond();
    unbindSecond();
    reg.scheduleStart('s1', 'y', 'u2', sync);
    expect(first).toHaveBeenCalledExactlyOnceWith('s1', 'y', 'u2');
  });

  it('无任何 starter：挂起最新一次续写，下次登记时经 microtask 启动', async () => {
    const reg = createSessionStreamRegistryForTest();
    reg.scheduleStart('s1', 'old', 'u0', sync);
    reg.scheduleStart('s1', 'latest', 'u1', sync);
    const starter = vi.fn();
    reg.bindStarter('s1', starter);
    expect(starter).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(starter).toHaveBeenCalledExactlyOnceWith('s1', 'latest', 'u1');
  });

  it('默认调度为 microtask', async () => {
    const reg = createSessionStreamRegistryForTest();
    const starter = vi.fn();
    reg.bindStarter('s1', starter);
    reg.scheduleStart('s1', 'go', 'u1');
    expect(starter).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(starter).toHaveBeenCalledTimes(1);
  });

  it('墓碑会话不启动（Double-Lock 第一把锁）', () => {
    const reg = createSessionStreamRegistryForTest();
    const starter = vi.fn();
    reg.bindStarter('s1', starter);
    markSessionTombstone('s1');
    reg.scheduleStart('s1', 'go', 'u1', sync);
    expect(starter).not.toHaveBeenCalled();
  });

  it('Store 已无该会话不启动（Double-Lock 第二把锁）；解绑探针后恢复', () => {
    const reg = createSessionStreamRegistryForTest();
    const starter = vi.fn();
    reg.bindStarter('s1', starter);
    const unbindOracle = reg.bindSessionAliveOracle(() => false);
    reg.scheduleStart('s1', 'go', 'u1', sync);
    expect(starter).not.toHaveBeenCalled();
    unbindOracle();
    reg.scheduleStart('s1', 'go', 'u1', sync);
    expect(starter).toHaveBeenCalledTimes(1);
  });
});

describe('busyRetry（串行守卫退避计数，FINAL-PLAN P1-d）', () => {
  it('退避 300 → 600 → 1200 → 2400ms', () => {
    expect([1, 2, 3, 4].map(busyRetryDelayMs)).toEqual([300, 600, 1200, 2400]);
  });

  it('noteBusy 累加', () => {
    expect(noteBusy('s1', 'u1')).toBe(1);
    expect(noteBusy('s1', 'u1')).toBe(2);
    expect(isBusyRetryPending('u1')).toBe(true);
  });
});
