// @vitest-environment jsdom
/**
 * useVirtualScroll wiring / phase tests (R8-List-SyncLayout + R8-List-RegressionTests).
 *
 * H1: ids→syncOrder runs in layout phase (useLayoutEffect), not paint-after useEffect.
 * H2: ids change calls syncOrder and never clear; ChatMessageList has no startIndex→clearHeights Effect.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVirtualScroll } from './useVirtualScroll';

const here =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

describe('useVirtualScroll — ids→syncOrder (layout phase, no clear)', () => {
  it('expand / window pan: ids change syncs order and retains heights without clear', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['m2', 'm3', 'm4'], itemCount: 3 } }
    );

    // Seed measured heights for the current window
    result.current.manager.setActual('m2', 200);
    result.current.manager.setActual('m3', 300);
    result.current.manager.setActual('m4', 400);

    expect(result.current.manager.getOrder()).toEqual(['m2', 'm3', 'm4']);
    expect(result.current.manager.getHeight('m2')).toBe(200);

    const clearSpy = vi.spyOn(result.current.manager, 'clear');
    const syncSpy = vi.spyOn(result.current.manager, 'syncOrder');

    // expand older: prepend m0,m1 — contract: syncOrder only, never clear
    const expanded = ['m0', 'm1', 'm2', 'm3', 'm4'];
    rerender({ ids: expanded, itemCount: 5 });

    expect(syncSpy).toHaveBeenCalled();
    expect(
      syncSpy.mock.calls.some(
        (c) => c[0] === expanded || equalArr(c[0], expanded)
      )
    ).toBe(true);
    expect(clearSpy).not.toHaveBeenCalled();

    // Layout phase completed: order length === ids.length === itemCount
    expect(result.current.manager.getOrder()).toEqual(expanded);
    expect(result.current.manager.getOrder().length).toBe(5);
    expect(result.current.manager.getOrder().length).toBe(expanded.length);

    // Same-id heights retained across pan
    expect(result.current.manager.getHeight('m2')).toBe(200);
    expect(result.current.manager.getHeight('m3')).toBe(300);
    expect(result.current.manager.getHeight('m4')).toBe(400);
    expect(result.current.manager.hasHeight('m2')).toBe(true);

    // totalHeight reflects new order (fallback for unmeasured prepends)
    expect(result.current.totalHeight).toBe(100 + 100 + 200 + 300 + 400);

    clearSpy.mockRestore();
    syncSpy.mockRestore();
  });

  it('repeated identical ids is safe (StrictMode-style double sync)', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 80 }),
      { initialProps: { ids: ['a', 'b'], itemCount: 2 } }
    );

    result.current.manager.setActual('a', 50);
    result.current.manager.setActual('b', 60);

    // Same content, new array reference (simulates parent re-memo miss / remount path)
    rerender({ ids: ['a', 'b'], itemCount: 2 });
    act(() => {
      result.current.syncOrder(['a', 'b']);
      result.current.syncOrder(['a', 'b']);
    });

    expect(result.current.manager.getOrder()).toEqual(['a', 'b']);
    expect(result.current.manager.getHeight('a')).toBe(50);
    expect(result.current.manager.getHeight('b')).toBe(60);
  });

  it('syncOrder called on ids change; clear NOT called during window pan', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['a', 'b'], itemCount: 2 } }
    );

    const clearSpy = vi.spyOn(result.current.manager, 'clear');
    const syncSpy = vi.spyOn(result.current.manager, 'syncOrder');
    clearSpy.mockClear();
    syncSpy.mockClear();

    // ids 变化 → syncOrder 被调用
    rerender({ ids: ['a', 'b', 'c'], itemCount: 3 });
    expect(syncSpy).toHaveBeenCalled();
    // 仅会话切换时 clear，窗口平移禁止 clear
    expect(clearSpy).not.toHaveBeenCalled();

    clearSpy.mockRestore();
    syncSpy.mockRestore();
  });

  it('syncOrder NOT called when ids array reference unchanged', () => {
    const stableIds = ['a', 'b'];
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: stableIds, itemCount: 2 } }
    );

    const syncSpy = vi.spyOn(result.current.manager, 'syncOrder');
    syncSpy.mockClear(); // clear the initial render call

    // Same array reference → useLayoutEffect deps [manager, ids] unchanged → skip
    rerender({ ids: stableIds, itemCount: 2 });
    expect(syncSpy).not.toHaveBeenCalled();

    syncSpy.mockRestore();
  });

  it('clearHeights empties order; subsequent ids sync restores without leaking clear into pan', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['s1-m0', 's1-m1'], itemCount: 2 } }
    );

    result.current.manager.setActual('s1-m0', 110);
    act(() => {
      result.current.clearHeights();
    });
    expect(result.current.manager.getOrder()).toEqual([]);
    expect(result.current.manager.hasHeight('s1-m0')).toBe(false);

    // Session switch style: new ids after clear
    const next = ['s2-m0', 's2-m1', 's2-m2'];
    rerender({ ids: next, itemCount: 3 });
    expect(result.current.manager.getOrder()).toEqual(next);
    expect(result.current.manager.getOrder().length).toBe(3);
  });
});

describe('useVirtualScroll source — layout phase lock', () => {
  it('auto ids→syncOrder uses useLayoutEffect (not paint-after useEffect)', () => {
    const src = readFileSync(
      resolve(here, './useVirtualScroll.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n');

    // Positive: layout-phase auto sync block
    expect(src).toMatch(
      /useLayoutEffect\(\(\)\s*=>\s*\{[\s\S]*?manager\.syncOrder\(ids\)[\s\S]*?\},\s*\[manager,\s*ids\]\)/
    );

    // Negative: do not use useEffect for manager.syncOrder(ids)
    const useEffectBlocks =
      src.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[[^\]]*?\]\)/g) ??
      [];
    for (const block of useEffectBlocks) {
      expect(block.includes('manager.syncOrder')).toBe(false);
    }
  });
});

describe('ChatMessageList height lifecycle contract (static source)', () => {
  it('has no startIndex + clearHeights wired in the same Effect', () => {
    const src = readFileSync(
      resolve(here, '../components/chat-message-list/MessageVirtualizer.tsx'),
      'utf8'
    ).replace(/\r\n/g, '\n');

    // Remove comments to avoid false positive comment matches
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

    // Forbid clearHeights appearing in an effect body/deps window with messageWindow.startIndex
    const effectBlocks =
      codeOnly.match(/use(?:Layout)?Effect\([\s\S]*?\);\s*\n/g) ?? [];
    for (const block of effectBlocks) {
      const hasClear = block.includes('clearHeights');
      const hasStartIndex = block.includes('startIndex');
      expect(hasClear && hasStartIndex).toBe(false);
    }

    // No effect dependency array listing both startIndex and clearHeights
    const effectCallRegex =
      /use(?:Layout)?Effect\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*(\[[^\]]*?\])\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = effectCallRegex.exec(codeOnly)) !== null) {
      const depArrayStr = match[1] ?? '';
      const hasClear = depArrayStr.includes('clearHeights');
      const hasStartIndex = depArrayStr.includes('startIndex');
      expect(hasClear && hasStartIndex).toBe(false);
    }

    // Positive lock: session switch still clears heights
    expect(src).toMatch(
      /clearHeights[\s\S]{0,300}?activeSessionId|activeSessionId[\s\S]{0,300}?clearHeights/
    );
    // Positive lock: window pan / expand relies on syncOrder (comment or hook path)
    expect(src).toMatch(/useVirtualScroll|syncOrder/);
  });
});

function equalArr(a: unknown, b: string[]): boolean {
  return (
    Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])
  );
}

describe('T4.1（R-04）：setActual 同值跳过不触发 actualTick', () => {
  it('同高度重复 setActual：manager.setActual 不被调用（入 pending 前短路）', async () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['a'], itemCount: 1, fallbackHeight: 100 })
    );
    act(() => {
      result.current.manager.setActual('a', 50);
    });
    expect(result.current.manager.getActualHeight('a')).toBe(50);
    const setActualSpy = vi.spyOn(result.current.manager, 'setActual');
    // 同值 setActual（RO 重复回调场景）→ pending 短路，manager 零调用
    act(() => {
      result.current.setActual('a', 50);
    });
    expect(setActualSpy).not.toHaveBeenCalled();
  });

  it('异值 setActual：进入 pending（rAF 异步 flush）；同值短路不重复入队', () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['a', 'b'], itemCount: 2, fallbackHeight: 100 })
    );
    act(() => {
      result.current.manager.setActual('a', 50);
      result.current.manager.setActual('b', 50);
    });
    // 异值 → 入 pending（rAF flush 在测试环境不自动触发，manager 未变）
    act(() => {
      result.current.setActual('a', 200);
    });
    expect(result.current.manager.getActualHeight('a')).toBe(50);
    // 同值短路：pending 不重复入队（无额外写入）
    act(() => {
      result.current.setActual('a', 200);
    });
    expect(result.current.manager.getActualHeight('a')).toBe(50);
    // 直接经 manager 验证异值写入路径正常
    act(() => {
      result.current.manager.setActual('a', 200);
    });
    expect(result.current.manager.getActualHeight('a')).toBe(200);
  });

  it('已有实测时，阈值内复测不写模型，避免切标签回弹', () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['a'], itemCount: 1, fallbackHeight: 100 })
    );
    act(() => {
      result.current.syncOrder(['a']);
      result.current.manager.setActual('a', 100);
    });
    act(() => {
      result.current.setActual('a', 103);
      result.current.flushPendingGeometry();
    });
    expect(result.current.manager.getActualHeight('a')).toBe(100);

    act(() => {
      result.current.setActual('a', 106);
      result.current.flushPendingGeometry();
    });
    expect(result.current.manager.getActualHeight('a')).toBe(106);
    expect(result.current.totalHeight).toBe(106);
  });

  it('首次实测即使只差 2px 也写入，占位与模型一起更新', () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['a'], itemCount: 1, fallbackHeight: 100 })
    );
    act(() => {
      result.current.syncOrder(['a']);
      result.current.preloadEstimates([{ id: 'a', height: 100 }]);
    });
    expect(result.current.manager.getActualHeight('a')).toBeNull();
    act(() => {
      result.current.setActual('a', 102);
      result.current.flushPendingGeometry();
    });
    expect(result.current.manager.getActualHeight('a')).toBe(102);
    expect(result.current.totalHeight).toBe(102);
  });
});

describe('W3-A：程序吸底令牌排他、C3 双帧兜底与流式即时测高契约', () => {
  it('程序吸底触发 onScroll 时 gestureActive 不激活（GFPC === 0），后续 setActual 在下一 rAF 即时刷新树状数组高度', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useVirtualScroll({ ids: ['a', 'b'], itemCount: 2, fallbackHeight: 100 })
      );

      const fakeContainer = document.createElement('div');
      Object.defineProperties(fakeContainer, {
        scrollTop: { value: 0, writable: true, configurable: true },
        scrollHeight: { value: 600, writable: true, configurable: true },
        clientHeight: { value: 400, writable: true, configurable: true },
      });

      // 1. 经 performProgrammaticScroll 执行程序吸底并派发原生 onScroll
      act(() => {
        result.current.performProgrammaticScroll(fakeContainer, 200);
        result.current.onScroll({
          currentTarget: fakeContainer,
        } as unknown as React.UIEvent<HTMLDivElement>);
      });

      // 断言：假阳性手势计数 GFPC === 0（gestureActive 绝不激活）
      expect(result.current.isGestureActive()).toBe(false);
      expect(result.current.scrollTop).toBe(200);

      // 2. 流式吐字触发 setActual，应在下一帧 rAF（16ms）即时写入树状数组，无需等待 100ms
      act(() => {
        result.current.setActual('a', 260);
      });
      act(() => {
        vi.advanceTimersByTime(16);
      });

      expect(result.current.manager.getActualHeight('a')).toBe(260);
      expect(result.current.totalHeight).toBe(260 + 100);
      expect(result.current.isGestureActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('C3 令牌生命周期：单次匹配消费自销毁 + 跨首帧延迟到达保护 + 双帧 rAF 兜底释放', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useVirtualScroll({ ids: ['a'], itemCount: 1, fallbackHeight: 100 })
      );
      const fakeContainer = document.createElement('div');
      Object.defineProperty(fakeContainer, 'scrollTop', {
        value: 300,
        writable: true,
        configurable: true,
      });

      // 场景 A：Chromium 延迟至第 1 帧 rAF 之后才派发 scroll 事件（验证修复 C3 单帧早泄）
      act(() => {
        result.current.performProgrammaticScroll(fakeContainer, 300);
      });
      act(() => {
        vi.advanceTimersByTime(16); // 经过第 1 帧 rAF，双帧哨兵仍存活
      });
      act(() => {
        result.current.onScroll({
          currentTarget: fakeContainer,
        } as unknown as React.UIEvent<HTMLDivElement>);
      });
      // 第 1 次匹配事件正常豁免并自销毁
      expect(result.current.isGestureActive()).toBe(false);

      // 场景 B：单次消费自销毁后，再次发生未授权 scroll 事件立即进入手势保护
      act(() => {
        result.current.onScroll({
          currentTarget: fakeContainer,
        } as unknown as React.UIEvent<HTMLDivElement>);
      });
      expect(result.current.isGestureActive()).toBe(true);

      // 等待手势结束
      act(() => {
        vi.advanceTimersByTime(110);
      });
      expect(result.current.isGestureActive()).toBe(false);

      // 场景 C：若未发生任何 scroll 事件，双帧 rAF（~34ms）后令牌兜底自动释放
      act(() => {
        result.current.markProgrammaticScroll(300);
      });
      act(() => {
        vi.advanceTimersByTime(40);
      });
      expect(result.current.isProgrammaticScrollEvent(300)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('流式连续调用 setActual 绝对不会延长 gestureEpoch 定时器（根除反向续期死循环）', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useVirtualScroll({
          ids: ['stream-row'],
          itemCount: 1,
          fallbackHeight: 100,
        })
      );

      const fakeContainer = document.createElement('div');
      Object.defineProperty(fakeContainer, 'scrollTop', {
        value: 50,
        writable: true,
        configurable: true,
      });

      // t = 0ms：真实非程序滚动激活 100ms 手势冻结
      act(() => {
        result.current.onScroll({
          currentTarget: fakeContainer,
        } as unknown as React.UIEvent<HTMLDivElement>);
      });
      expect(result.current.isGestureActive()).toBe(true);

      // t = 20ms, 40ms, 60ms, 80ms：流式高频触发 setActual
      act(() => {
        vi.advanceTimersByTime(20);
        result.current.setActual('stream-row', 120);
        vi.advanceTimersByTime(20);
        result.current.setActual('stream-row', 140);
        vi.advanceTimersByTime(20);
        result.current.setActual('stream-row', 160);
        vi.advanceTimersByTime(20);
        result.current.setActual('stream-row', 180);
      });

      // t = 80ms：仍在初始 100ms 手势窗口内
      expect(result.current.isGestureActive()).toBe(true);

      // 再推进 25ms（累计 105ms > 100ms）：
      // 若 setActual 错误调用了 bumpGestureEpoch，定时器将被推迟到 80 + 100 = 180ms；
      // 切除后，定时器在 100ms 准时释放并刷入最新高度 180！
      act(() => {
        vi.advanceTimersByTime(25);
      });

      expect(result.current.isGestureActive()).toBe(false);
      expect(result.current.manager.getActualHeight('stream-row')).toBe(180);
      expect(result.current.totalHeight).toBe(180);
    } finally {
      vi.useRealTimers();
    }
  });

  it('物理 wheel 事件在捕获阶段立即打断程序滚动豁免并激活手势保护', () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['a', 'b'], itemCount: 2, fallbackHeight: 100 })
    );

    const fakeContainer = document.createElement('div');
    Object.defineProperty(fakeContainer, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    });

    // 1. 发起程序吸底滚动（挂载容器监听并激活豁免令牌）
    act(() => {
      result.current.performProgrammaticScroll(fakeContainer, 240);
    });
    expect(result.current.isGestureActive()).toBe(false);

    // 2. 用户在 scroll 事件到达前物理拨动滚轮（Capture 阶段立即拦截）
    act(() => {
      fakeContainer.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -40, bubbles: true })
      );
    });

    // 断言：程序滚动豁免权已被原子销毁，且手势保护立即激活
    expect(result.current.isGestureActive()).toBe(true);
    expect(result.current.isProgrammaticScrollEvent(240)).toBe(false);
  });

  it('静态源码锁：setActual 物理切除 bumpGestureEpoch，且手势模块零模块级可变全局变量', () => {
    const vsSrc = readFileSync(
      resolve(here, './useVirtualScroll.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n');
    const gestureSrc = readFileSync(
      resolve(here, './useVirtualScrollGesture.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n');

    // 提取 setActual 函数体，断言内部不含 bumpGestureEpoch
    const setActualMatch = vsSrc.match(
      /const setActual = useCallback\([\s\S]*?\](?:,\s*)?\);/
    );
    expect(setActualMatch).not.toBeNull();
    expect(setActualMatch![0]).not.toContain('bumpGestureEpoch');

    // 断言 useVirtualScrollGesture.ts 顶层无模块级 let 可变全局状态
    const topLevelLines = gestureSrc
      .split('\n')
      .filter((line) => /^let\s+/.test(line));
    expect(topLevelLines).toEqual([]);
  });
});

describe('VS-01 ~ VS-05：虚拟滚动首帧测高保护、跨会话 scrollTop 重置与尺寸重算修复验证', () => {
  it('VS-02: clearHeights 同步归零 scrollTop、latestScrollTopRef 与容器 scrollTop', () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['a', 'b'], itemCount: 2, fallbackHeight: 100 })
    );

    const fakeContainer = document.createElement('div');
    Object.defineProperties(fakeContainer, {
      scrollTop: { value: 500, writable: true, configurable: true },
      scrollHeight: { value: 1200, writable: true, configurable: true },
      clientHeight: { value: 400, writable: true, configurable: true },
    });
    // @ts-expect-error test container injection
    result.current.containerRef.current = fakeContainer;

    act(() => {
      fakeContainer.scrollTop = 500;
      result.current.onScroll({
        currentTarget: fakeContainer,
      } as unknown as React.UIEvent<HTMLDivElement>);
    });
    expect(result.current.scrollTop).toBe(500);

    act(() => {
      result.current.clearHeights();
    });

    expect(result.current.scrollTop).toBe(0);
    expect(fakeContainer.scrollTop).toBe(0);
  });

  it('VS-04: totalHeight 依赖补齐 ids，同条数切换会话时 totalHeight 立即重算', () => {
    const { result, rerender } = renderHook(
      ({ ids, itemCount }: { ids: string[]; itemCount: number }) =>
        useVirtualScroll({ ids, itemCount, fallbackHeight: 100 }),
      { initialProps: { ids: ['s1-m1', 's1-m2'], itemCount: 2 } }
    );

    result.current.manager.setActual('s1-m1', 300);
    result.current.manager.setActual('s1-m2', 400);

    rerender({ ids: ['s1-m1', 's1-m2'], itemCount: 2 });
    expect(result.current.totalHeight).toBe(700);

    // 切换到同为 2 条消息但不同 ID 的新会话
    rerender({ ids: ['s2-m1', 's2-m2'], itemCount: 2 });
    // 新会话无测高，应立即回退至 fallbackHeight * 2 = 200，绝不残留旧会话的 700
    expect(result.current.totalHeight).toBe(200);
  });

  it('VS-01 静态源码锁：activeSessionId 切会话守卫与同步 useLayoutEffect 时序断言', () => {
    const mvSrc = readFileSync(
      resolve(here, '../components/chat-message-list/MessageVirtualizer.tsx'),
      'utf8'
    ).replace(/\r\n/g, '\n');

    // 1. activeSessionId 切会话重置必须使用 useLayoutEffect，绝不允许使用被动 useEffect
    expect(mvSrc).toMatch(
      /useLayoutEffect\(\(\)\s*=>\s*\{[\s\S]*?activeSessionId[\s\S]*?clearHeights\(\)[\s\S]*?\}\s*,\s*\[activeSessionId,\s*clearHeights,\s*manager\]\)/
    );

    // 2. 必须具备 prevSessionIdRef 守卫以跳过首次挂载
    expect(mvSrc).toMatch(
      /if\s*\(\s*prevSessionIdRef\.current\s*===\s*activeSessionId\s*\)\s*\{\s*return;\s*\}/
    );

    // 3. 切会话 useLayoutEffect 必须置于 preloadEstimates 与吸底 performProgrammaticScroll 之前
    const sessionClearIndex = mvSrc.indexOf(
      'prevSessionIdRef.current = activeSessionId'
    );
    const preloadEstimatesIndex = mvSrc.indexOf('unmeasuredEstimates');
    const bottomStickIndex = mvSrc.lastIndexOf('BOTTOM_STICK_EPSILON_PX');

    expect(sessionClearIndex).toBeGreaterThan(0);
    expect(preloadEstimatesIndex).toBeGreaterThan(sessionClearIndex);
    expect(bottomStickIndex).toBeGreaterThan(preloadEstimatesIndex);
  });

  it('VS-05 静态源码锁：ChatMessageList 传入 leafRootRef 闭合多分屏滚动隔离', () => {
    const listSrc = readFileSync(
      resolve(here, '../components/chat-message-list/ChatMessageList.tsx'),
      'utf8'
    ).replace(/\r\n/g, '\n');

    // 必须调用 useLeafScope 并解构 leafRootRef
    expect(listSrc).toMatch(/useLeafScope/);
    expect(listSrc).toMatch(/leafRootRef/);

    // useScrollAnchor 必须传入 scrollContainerRef: leafRootRef
    expect(listSrc).toMatch(/scrollContainerRef:\s*leafRootRef/);

    // 搜索定位必须传入 leafRootRef?.current
    expect(listSrc).toMatch(
      /scopedScrollToMessage\(id,\s*leafRootRef\?\.current\)/
    );
  });
});
