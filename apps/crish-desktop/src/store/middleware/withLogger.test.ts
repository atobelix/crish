/**
 * withLogger 嵌套 set 回归测试（store 发送链路主路径防护）。
 *
 * 背景（R6 终验定位）：persist / withAutoIndex 等中间件对函数 partial 先求值
 * 再**再次调用**内层 set，同一 action 的 instrumented set 嵌套触发。旧实现 mark
 * 名固定（store:anonymous:start），内层 clearMarks 清掉外层 start mark →
 * 外层 measure 抛 SyntaxError → 异常穿透 store action（createSession/commitDraft
 * 路径）→ 发送链在「草稿 commit」处静默中断。
 *
 * 回归断言：
 * 1. 嵌套 set 不抛且 state 正确更新（唯一 mark 名修复）；
 * 2. 外部清掉全部 mark 时 measure 失败也不向业务层抛（try-catch 兜底）；
 * 3. 非 development 环境直接透传（production 零开销语义）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withLogger } from './withLogger';

type TestState = {
  count: number;
  bump: () => void;
};

/** 模拟 persist / withAutoIndex：函数 partial 求值后再次调用内层 set */
function relaySet(config: (set: unknown, get: unknown, api: unknown) => unknown) {
  return (set: (partial: unknown, replace?: boolean) => void, get: unknown, api: unknown) => {
    const setImpl = (partial: unknown, replace?: boolean) => {
      if (typeof partial === 'function') {
        // 与 persist 同构：先求值函数 partial，再以对象 partial 调内层 set
        return set((state: TestState) => partial(state), replace);
      }
      return set(partial, replace);
    };
    return config(setImpl, get, api);
  };
}

/** 模拟外部干扰：set 执行前清掉全部 performance marks */
function wipeMarksBeforeSet(
  config: (set: unknown, get: unknown, api: unknown) => unknown
) {
  return (set: (partial: unknown, replace?: boolean) => void, get: unknown, api: unknown) => {
    const setImpl = (partial: unknown, replace?: boolean) => {
      performance.clearMarks();
      return set(partial, replace);
    };
    return config(setImpl, get, api);
  };
}

function createTestStore(
  middleware: (config: (set: unknown, get: unknown, api: unknown) => unknown) => unknown
) {
  return create<TestState>()(
    withLogger(
      middleware(
        immer((set) => ({
          count: 0,
          bump: () =>
            set((state: TestState) => {
              state.count += 1;
            }),
        }))
      )
    )
  );
}

describe('withLogger（dev 观测中间件）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('嵌套 set（函数 partial 二次调用内层 set）不抛且 state 正确更新', () => {
    vi.stubEnv('NODE_ENV', 'development');

    const store = createTestStore(relaySet);
    expect(() => store.getState().bump()).not.toThrow();
    expect(store.getState().count).toBe(1);
  });

  it('外部清掉全部 mark 时 measure 失败也不向业务层抛异常', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);

    const store = createTestStore(wipeMarksBeforeSet);
    expect(() => store.getState().bump()).not.toThrow();
    expect(store.getState().count).toBe(1);
  });

  it('非 development 环境直接透传 set（零开销），不触碰 performance', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const markSpy = vi.spyOn(performance, 'mark');

    const store = createTestStore(relaySet);
    store.getState().bump();
    expect(store.getState().count).toBe(1);
    expect(markSpy).not.toHaveBeenCalled();
  });
});
