// @vitest-environment jsdom
import { StrictMode, createElement, useEffect, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOMBSTONE_CAPACITY,
  ScopedLifecycleRegistry,
  bindSessionTombstoneOracle,
  getSharedTombstoneCapacity,
  getSharedTombstoneSet,
  isSessionTombstoned,
  markSessionTombstone,
  recordSharedTombstone,
  setSharedTombstoneCapacity,
  useScopedLifecycle,
} from './ScopedLifecycleRegistry';

describe('ScopedLifecycleRegistry', () => {
  let slr: ScopedLifecycleRegistry;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    slr = new ScopedLifecycleRegistry();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('dispose 按 LIFO 顺序执行，且只执行一次', () => {
    const order: string[] = [];
    slr.register(() => order.push('a'));
    slr.register(() => order.push('b'));
    slr.register(() => order.push('c'));
    expect(slr.size).toBe(3);
    slr.dispose();
    slr.dispose();
    expect(order).toEqual(['c', 'b', 'a']);
    expect(slr.isDisposed).toBe(true);
    expect(slr.disposed).toBe(true);
    expect(slr.size).toBe(0);
  });

  it('单个 disposer 抛错不阻断其余拆除，并记录错误', () => {
    const after = vi.fn();
    slr.register(after);
    slr.register(() => {
      throw new Error('boom');
    });
    slr.dispose();
    expect(after).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[SLR] Disposer execution error:',
      expect.any(Error)
    );
  });

  it('register 返回的句柄可提前注销，之后 dispose 不再重复执行', () => {
    const fn = vi.fn();
    const off = slr.register(fn);
    off();
    off();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(slr.size).toBe(0);
    slr.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('已 dispose 后 register 立即同步执行；非函数输入被忽略', () => {
    slr.dispose();
    const fn = vi.fn();
    slr.register(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(slr.size).toBe(0);
    expect(() =>
      slr.register(undefined as unknown as () => void)()
    ).not.toThrow();
  });

  it('listen 解绑时复用注册时的 capture options', () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const removeSpy = vi.spyOn(target, 'removeEventListener');
    slr.listen(target, 'ping', handler, { capture: true });
    target.dispatchEvent(new Event('ping'));
    slr.dispose();
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('ping', handler, { capture: true });
  });

  it('listen 对空 target / 已 dispose 返回空操作且不登记', () => {
    slr.listen(null, 'x', () => {});
    expect(slr.size).toBe(0);
    slr.dispose();
    const target = new EventTarget();
    const handler = vi.fn();
    slr.listen(target, 'x', handler);
    target.dispatchEvent(new Event('x'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('observe 在 dispose 时 disconnect；已 dispose 时立即 disconnect', () => {
    const obs = { disconnect: vi.fn() };
    expect(slr.observe(obs)).toBe(obs);
    expect(slr.size).toBe(1);
    slr.dispose();
    expect(obs.disconnect).toHaveBeenCalledTimes(1);
    const late = { disconnect: vi.fn() };
    slr.observe(late);
    expect(late.disconnect).toHaveBeenCalledTimes(1);
  });

  it('timeout 到期后自动出列；提前 dispose 则不触发', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    slr.timeout(fired, 100);
    expect(slr.size).toBe(1);
    vi.advanceTimersByTime(100);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(slr.size).toBe(0);

    const never = vi.fn();
    slr.timeout(never, 100);
    slr.dispose();
    vi.advanceTimersByTime(500);
    expect(never).not.toHaveBeenCalled();
  });

  it('interval 周期触发直到注销', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = slr.interval(tick, 10);
    vi.advanceTimersByTime(35);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(slr.size).toBe(0);
  });

  it('raf 执行一次后出列；提前取消则不执行', () => {
    vi.useFakeTimers();
    const frame = vi.fn();
    slr.raf(frame);
    vi.advanceTimersByTime(50);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(slr.size).toBe(0);
    const cancelled = vi.fn();
    const cancel = slr.raf(cancelled);
    cancel();
    vi.advanceTimersByTime(50);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('asyncScope：dispose 中止 signal 并执行已决议的 cleanup', async () => {
    const cleanup = vi.fn();
    let seen: AbortSignal | undefined;
    slr.asyncScope(async (signal) => {
      seen = signal;
      return cleanup;
    });
    await vi.waitFor(() => expect(seen).toBeInstanceOf(AbortSignal));
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    slr.dispose();
    expect(seen?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('asyncScope：runner 在 dispose 之后才返回的 cleanup 立即执行（无孤儿订阅）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lateCleanup = vi.fn();
    slr.asyncScope(async () => {
      await gate;
      return lateCleanup;
    });
    slr.dispose();
    release();
    await vi.waitFor(() => expect(lateCleanup).toHaveBeenCalledTimes(1));
  });

  it('asyncScope：非中止错误被记录，中止错误静默', async () => {
    slr.asyncScope(async () => {
      throw new Error('runner failed');
    });
    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        '[SLR] asyncScope runner error:',
        expect.any(Error)
      )
    );
    errorSpy.mockClear();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    slr.asyncScope(async () => {
      throw abortErr;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reset 拆除现有资源后恢复可用', () => {
    const fn = vi.fn();
    slr.register(fn);
    slr.reset();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(slr.isDisposed).toBe(false);
    const next = vi.fn();
    slr.register(next);
    expect(next).not.toHaveBeenCalled();
    expect(slr.size).toBe(1);
  });
});

describe('useScopedLifecycle', () => {
  function useWindowPing(handler: () => void) {
    const slr = useScopedLifecycle();
    useEffect(() => {
      slr.listen(window, 'crish-test-ping' as keyof WindowEventMap, handler);
    }, [slr, handler]);
    return slr;
  }

  it('卸载时释放托管监听', () => {
    const handler = vi.fn();
    const { result, unmount } = renderHook(() => useWindowPing(handler));
    window.dispatchEvent(new Event('crish-test-ping'));
    expect(handler).toHaveBeenCalledTimes(1);
    unmount();
    expect(result.current.isDisposed).toBe(true);
    window.dispatchEvent(new Event('crish-test-ping'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('StrictMode 双挂载后监听仍然生效，卸载后释放', () => {
    const handler = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children);
    const { unmount } = renderHook(() => useWindowPing(handler), { wrapper });
    window.dispatchEvent(new Event('crish-test-ping'));
    expect(handler).toHaveBeenCalledTimes(1);
    unmount();
    window.dispatchEvent(new Event('crish-test-ping'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('共享会话墓碑 LRU', () => {
  beforeEach(() => {
    bindSessionTombstoneOracle(null);
    getSharedTombstoneSet().clear();
    setSharedTombstoneCapacity(DEFAULT_TOMBSTONE_CAPACITY);
  });
  afterEach(() => {
    bindSessionTombstoneOracle(null);
    getSharedTombstoneSet().clear();
    setSharedTombstoneCapacity(DEFAULT_TOMBSTONE_CAPACITY);
  });

  it('trim 后记录，空白 id 忽略', () => {
    markSessionTombstone('  s1  ');
    markSessionTombstone('   ');
    expect(isSessionTombstoned('s1')).toBe(true);
    expect(isSessionTombstoned(' s1 ')).toBe(true);
    expect(isSessionTombstoned('')).toBe(false);
    expect([...getSharedTombstoneSet()]).toEqual(['s1']);
  });

  it('满容量淘汰最久未触碰项；重复标记会刷新为最新', () => {
    setSharedTombstoneCapacity(2);
    recordSharedTombstone('a');
    recordSharedTombstone('b');
    recordSharedTombstone('a');
    recordSharedTombstone('c');
    expect([...getSharedTombstoneSet()]).toEqual(['a', 'c']);
    expect(isSessionTombstoned('b')).toBe(false);
  });

  it('缩容立即裁掉最旧项；容量下限为 1', () => {
    ['a', 'b', 'c'].forEach(recordSharedTombstone);
    setSharedTombstoneCapacity(0);
    expect(getSharedTombstoneCapacity()).toBe(1);
    expect([...getSharedTombstoneSet()]).toEqual(['c']);
  });

  it('绑定外部仲裁器后读写全部委托给它', () => {
    const oracle = {
      isSessionTombstoned: vi.fn(() => true),
      markSessionTombstone: vi.fn(),
    };
    bindSessionTombstoneOracle(oracle);
    markSessionTombstone('x');
    expect(oracle.markSessionTombstone).toHaveBeenCalledWith('x');
    expect(getSharedTombstoneSet().size).toBe(0);
    expect(isSessionTombstoned('anything')).toBe(true);
    expect(oracle.isSessionTombstoned).toHaveBeenCalledWith('anything');
  });
});
