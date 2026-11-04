// @vitest-environment jsdom
/**
 * R12 / R12b · 尾部滚动缓冲契约（依据《输入区滚动缓冲分析》§4.4 与
 * 《尾部留白与发送滚动修订方案》§五）：
 * 1. 落点等式分两态：idle 静止落点 = 底衬 16（真底）；turn 窗口内 = 16 + effB；
 * 2. 窗口语义（R12b）：发送进入 / 终态退出 / 切会话归零 / 离底不置闩 /
 *    短会话无溢出门（几何层判定在 chatScrollGeometry.test 钉死，
 *    本文件钉窗口信号状态机与宿主行为面）；
 * 3. 四个 chatSpacerHeight 生产调用点同值（源码锁：无一处漏带缓冲项）；
 * 4. 机制 B 采样：单调、无过冲、末帧精确、总时长落入定时律区间；
 * 5. 斜坡模拟：单调、单帧步长受帧预算约束、有限帧内开满；
 *    R12b 增补收合模拟：effB 按同一定时律单调递减至精确 0；
 * 6. handleScroll 物理底语义：贴底翻转与 FAB 阈值按距物理底距离计量；
 * 7. 回底驱动：逐帧经 performProgrammaticScroll 同步提交、原生 smooth 已退休、
 *    减少动效时塌缩为单次提交。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, renderHook } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualScrollManager } from '../../api/VirtualScrollManager';
import {
  CHAT_SCROLL_PAD_BOTTOM,
  CHAT_SCROLL_PAD_TOP,
  chatSpacerHeight,
  resolveTailBufferPx,
  resolveTailBufferRampStepPx,
  resolveTailBufferTargetPx,
} from './chatScrollGeometry';
import { computeActiveRowWindow } from './messageDomPurge';
import {
  useVirtualizerScrollHandlers,
  type VirtualizerScrollHandlersParams,
} from './messageVirtualizerScrollState';
import {
  deriveTailBufferWindow,
  planPositionAt,
  resolveScrollToBottomDurationMs,
  scrollToBottomPositionAt,
  type ScrollToBottomPlan,
  type TailBufferWindowState,
} from './messageVirtualizerScrollPlan';

const here =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

describe('R12-1：落点等式·窗口内（末行底边距容器底 = 16 + effB）', () => {
  it.each([
    { content: 2000, viewport: 800 },
    { content: 5000, viewport: 600 },
    { content: 1200, viewport: 1080 },
  ])('content=$content viewport=$viewport', ({ content, viewport }) => {
    const effB = resolveTailBufferPx(viewport);
    const total = chatSpacerHeight(content, effB);
    const maxScroll = Math.max(0, total - viewport);
    // 跟随静止点 scrollTop = maxScroll（物理底）；容器底边在文档坐标 maxScroll + viewport，
    // 末行底边在文档坐标 PAD_TOP + content，两者之差即静止时间距
    const lastRowBottomToContainerBottom =
      maxScroll + viewport - (CHAT_SCROLL_PAD_TOP + content);
    expect(lastRowBottomToContainerBottom).toBeCloseTo(
      CHAT_SCROLL_PAD_BOTTOM + effB,
      6
    );
  });

  it('computeActiveRowWindow：带缓冲的总高与同一 chatSpacerHeight 公式逐值一致', () => {
    const manager = new VirtualScrollManager(100);
    const messages = [
      { id: 'm1', sender: 'user' },
      { id: 'm2', sender: 'assistant' },
    ] as unknown as Parameters<typeof computeActiveRowWindow>[0]['messages'];
    manager.syncOrder(['m1', 'm2']);
    const base = {
      visibleRange: { startIndex: 0, endIndex: 0 },
      scrollTop: 0,
      viewportHeight: 400,
      totalHeight: 0,
      vsManager: manager,
      messages,
      msgIds: ['m1', 'm2'],
      pinnedIdSet: new Set<string>(),
      isScrolling: false,
    } as unknown as Parameters<typeof computeActiveRowWindow>[0];
    const content = manager.getTotalHeight(2);
    const effB = 224;
    const withBuffer = computeActiveRowWindow({
      ...base,
      tailBufferPx: effB,
    });
    const withoutBuffer = computeActiveRowWindow({ ...base });
    expect(withBuffer.totalHeight).toBe(chatSpacerHeight(content, effB));
    expect(withBuffer.totalHeight - withoutBuffer.totalHeight).toBe(effB);
  });
});

describe('R12b-1：静止零留白（idle 时 effB ≡ 0，落点 = 底衬 16 真底）', () => {
  it.each([
    { content: 2000, viewport: 800 },
    { content: 5000, viewport: 600 },
    { content: 12000, viewport: 1080 },
  ])(
    'content=$content viewport=$viewport：idle 目标 0 且滑到最底只剩底衬',
    ({ content, viewport }) => {
      const effB = resolveTailBufferTargetPx({
        turnActive: false,
        viewportHeight: viewport,
      });
      expect(effB).toBe(0);
      const total = chatSpacerHeight(content, effB);
      expect(total).toBe(
        CHAT_SCROLL_PAD_TOP + content + CHAT_SCROLL_PAD_BOTTOM
      );
      // 跟随静止点 scrollTop = maxScroll（物理底）：末行底边距容器底恰为底衬，
      // 物理上不可再向下滚出任何空白
      const maxScroll = Math.max(0, total - viewport);
      const lastRowBottomToContainerBottom =
        maxScroll + viewport - (CHAT_SCROLL_PAD_TOP + content);
      expect(lastRowBottomToContainerBottom).toBeCloseTo(
        CHAT_SCROLL_PAD_BOTTOM,
        6
      );
    }
  );
});

describe('R12b-2：窗口信号状态机（发送闩桥接 / 主信号接管 / 基线纪律）', () => {
  const fresh: TailBufferWindowState = {
    baselineTailUserId: undefined,
    sendLatchUserId: null,
  };
  const step = (
    prev: TailBufferWindowState,
    input: Partial<{
      sessionChanged: boolean;
      tailUserId: string | null;
      thinkingMsgId: string | null | undefined;
      isAtBottom: boolean;
    }>
  ) =>
    deriveTailBufferWindow(prev, {
      sessionChanged: false,
      tailUserId: null,
      thinkingMsgId: null,
      isAtBottom: true,
      ...input,
    });

  it('首帧只立基线不置闩：打开会话时尾行恰为 user 行也不张缓冲', () => {
    const r = step(fresh, { tailUserId: 'u-old' });
    expect(r.turnActive).toBe(false);
    expect(r.state).toEqual({
      baselineTailUserId: 'u-old',
      sendLatchUserId: null,
    });
  });

  it('在底发送：新 user 行落账即置闩开窗（assistant 行尚未创建的空窗被桥接）', () => {
    const primed = step(fresh, { tailUserId: null }).state;
    const sent = step(primed, { tailUserId: 'u-1', isAtBottom: true });
    expect(sent.turnActive).toBe(true);
    expect(sent.state.sendLatchUserId).toBe('u-1');
  });

  it('离底发送：不置闩、不进窗口，该轮 effB 保持 0', () => {
    const primed = step(fresh, { tailUserId: null }).state;
    const sent = step(primed, { tailUserId: 'u-1', isAtBottom: false });
    expect(sent.turnActive).toBe(false);
    expect(sent.state.sendLatchUserId).toBeNull();
  });

  it('主信号接管：thinkingMsgId 出现即清闩，窗口由主信号维持', () => {
    const primed = step(fresh, { tailUserId: null }).state;
    const latched = step(primed, { tailUserId: 'u-1' }).state;
    const taken = step(latched, {
      tailUserId: null,
      thinkingMsgId: 'a-1',
    });
    expect(taken.turnActive).toBe(true);
    expect(taken.state.sendLatchUserId).toBeNull();
  });

  it('终态退出：主信号消失且尾行已是 assistant 行，窗口关闭', () => {
    const inTurn = step(fresh, {
      tailUserId: null,
      thinkingMsgId: 'a-1',
    }).state;
    const done = step(inTurn, { tailUserId: null, thinkingMsgId: null });
    expect(done.turnActive).toBe(false);
  });

  it('闩住期间尾行被顶替且无主信号（极速终态 / 撤回）：窗口关闭', () => {
    const primed = step(fresh, { tailUserId: null }).state;
    const latched = step(primed, { tailUserId: 'u-1' }).state;
    const replaced = step(latched, { tailUserId: null });
    expect(replaced.turnActive).toBe(false);
    expect(replaced.state.sendLatchUserId).toBeNull();
  });

  it('切会话：闩清零、新尾行只作基线；新会话自带主信号则窗口直开', () => {
    const primed = step(fresh, { tailUserId: null }).state;
    const latched = step(primed, { tailUserId: 'u-1' }).state;
    const switched = step(latched, {
      sessionChanged: true,
      tailUserId: 'u-other',
    });
    expect(switched.turnActive).toBe(false);
    expect(switched.state).toEqual({
      baselineTailUserId: 'u-other',
      sendLatchUserId: null,
    });
    const switchedLive = step(latched, {
      sessionChanged: true,
      tailUserId: null,
      thinkingMsgId: 'a-9',
    });
    expect(switchedLive.turnActive).toBe(true);
  });
});

describe('R12-3：四点同值源码锁（chatSpacerHeight 生产调用点无一漏带缓冲项）', () => {
  it('4 个生产调用点全部传入 tailBuffer 项', () => {
    const files = [
      'MessageVirtualizer.tsx',
      'messageDomPurge.tsx',
      'messageVirtualizerScrollState.ts',
    ];
    const calls: string[] = [];
    for (const file of files) {
      const src = readFileSync(resolve(here, file), 'utf8').replace(
        /\r\n/g,
        '\n'
      );
      let idx = src.indexOf('chatSpacerHeight(');
      while (idx >= 0) {
        calls.push(src.slice(idx, idx + 140));
        idx = src.indexOf('chatSpacerHeight(', idx + 1);
      }
    }
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call).toMatch(/tailBuffer/);
    }
  });
});

describe('R12-4：机制 B 定时律采样（单调 / 无过冲 / 末帧精确 / 时长入界）', () => {
  it.each([
    { distance: 60, duration: 120 },
    { distance: 300, duration: 125 },
    { distance: 1500, duration: 450 },
  ])('D=$distance → T=$duration', ({ distance, duration }) => {
    expect(resolveScrollToBottomDurationMs(distance)).toBe(duration);
    const plan: ScrollToBottomPlan = {
      from: 0,
      target: distance,
      startTime: 1000,
      durationMs: duration,
    };
    const dt = 16.7;
    const positions: number[] = [];
    let doneAt = -1;
    for (let i = 0; i < 400; i++) {
      const { position, done } = scrollToBottomPositionAt(plan, 1000 + i * dt);
      positions.push(position);
      if (done) {
        doneAt = i * dt;
        break;
      }
    }
    expect(doneAt).toBeGreaterThanOrEqual(duration);
    expect(doneAt).toBeLessThan(duration + dt);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThanOrEqual(positions[i - 1]!);
    }
    for (const p of positions) {
      expect(p).toBeLessThanOrEqual(distance);
    }
    expect(positions[positions.length - 1]).toBe(distance);
  });
});

describe('R12-5：斜坡模拟（帧预算制张开，有限帧内开满）', () => {
  function simulate(increments: number[], target: number): number[] {
    const values: number[] = [];
    let current = 0;
    let frame = 0;
    while (current < target && frame < 1000) {
      const inc = increments[Math.min(frame, increments.length - 1)] ?? 0;
      const step = resolveTailBufferRampStepPx(inc, target - current);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThanOrEqual(Math.max(inc * 0.25, 12));
      expect(step).toBeLessThanOrEqual(24);
      current += step;
      values.push(current);
      frame++;
    }
    return values;
  }

  it('内容停长时以 12px/帧兜底：224px 开满恰 19 帧且单调', () => {
    const values = simulate([0], 224);
    expect(values).toHaveLength(19);
    expect(values[values.length - 1]).toBe(224);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it('内容高速生长（200px/帧）时步长封顶 24px：224px 开满恰 10 帧', () => {
    const values = simulate([200], 224);
    expect(values).toHaveLength(10);
    expect(values[values.length - 1]).toBe(224);
  });

  it('R12b 收合模拟：effB 224 → 0 按与 FAB 同一定时律单调递减、末值精确 0、时长入界', () => {
    const from = 224;
    const duration = resolveScrollToBottomDurationMs(from);
    expect(duration).toBeGreaterThanOrEqual(120);
    expect(duration).toBeLessThanOrEqual(450);
    const plan: ScrollToBottomPlan = {
      from,
      target: 0,
      startTime: 5000,
      durationMs: duration,
    };
    const dt = 16.7;
    const values: number[] = [];
    let doneAt = -1;
    for (let i = 0; i < 400; i++) {
      const { position, done } = planPositionAt(plan, 5000 + i * dt);
      values.push(position);
      if (done) {
        doneAt = i * dt;
        break;
      }
    }
    expect(doneAt).toBeGreaterThanOrEqual(duration);
    expect(doneAt).toBeLessThan(duration + dt);
    // 单调递减、无过冲（不越过 0、不回升）、末值精确 0
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(from);
    }
    expect(values[values.length - 1]).toBe(0);
  });
});

/** handlers hook 夹具：scrollHeight 2000 / clientHeight 400 → maxScroll 1600 */
function makeHandlersFixture() {
  const el = {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 400,
    scrollTo: vi.fn(),
  };
  const committed: number[] = [];
  const isAtBottomRef = { current: false };
  const isAtTopRef = { current: false };
  const observedTopRef = { current: 0 };
  const setIsAtBottom = vi.fn();
  const setIsAtTop = vi.fn();
  const setShowFloorButton = vi.fn();
  const params = {
    containerRef: { current: el },
    vs: {
      onScroll: vi.fn(),
      isGestureActive: () => false,
      viewportHeight: 400,
      cancelProgrammaticScroll: vi.fn(),
      performProgrammaticScroll: (_c: unknown, top: number) => {
        el.scrollTop = top;
        committed.push(top);
      },
    },
    totalHeightRef: { current: 2000 },
    isAnchorLocked: () => false,
    fastScroll: { onScrollSample: vi.fn() },
    isAtBottomRef,
    isAtTopRef,
    observedTopRef,
    setIsAtBottom,
    setIsAtTop,
    setShowFloorButton,
    touchStartYRef: { current: 0 },
  } as unknown as VirtualizerScrollHandlersParams;
  return {
    el,
    committed,
    params,
    isAtBottomRef,
    observedTopRef,
    setIsAtBottom,
    setShowFloorButton,
  };
}

describe('R12-6：handleScroll 物理底语义（贴底翻转 / FAB 阈值按距物理底计量）', () => {
  it('缓冲带中段（距物理底 199）不再视为贴底：不翻转为贴底', () => {
    // R12 内容底口径下此处曾判贴底；R12b 物理底口径下用户主动停在缓冲带
    // 中段即离底——其后内容生长不拽走他，窗口结束收合时被钳到真底
    const f = makeHandlersFixture();
    f.isAtBottomRef.current = false;
    f.observedTopRef.current = 1400;
    f.el.scrollTop = 1401; // 距物理底 1600−1401 = 199
    const { result } = renderHook(() => useVirtualizerScrollHandlers(f.params));
    act(() => {
      result.current.handleScroll({
        currentTarget: f.el,
      } as unknown as React.UIEvent<HTMLDivElement>);
    });
    expect(f.isAtBottomRef.current).toBe(false);
    expect(f.setIsAtBottom).not.toHaveBeenCalledWith(true);
  });

  it('距物理底 121px 上滚：FAB 亮（>120）；距物理底 119px：FAB 不亮', () => {
    const above = makeHandlersFixture();
    above.isAtBottomRef.current = true;
    above.observedTopRef.current = 1600;
    above.el.scrollTop = 1479; // 距物理底 121
    const r1 = renderHook(() => useVirtualizerScrollHandlers(above.params));
    act(() => {
      r1.result.current.handleScroll({
        currentTarget: above.el,
      } as unknown as React.UIEvent<HTMLDivElement>);
    });
    expect(above.setIsAtBottom).toHaveBeenCalledWith(false);
    expect(above.setShowFloorButton).toHaveBeenCalledWith(true);

    const within = makeHandlersFixture();
    within.isAtBottomRef.current = true;
    within.observedTopRef.current = 1600;
    within.el.scrollTop = 1481; // 距物理底 119
    const r2 = renderHook(() => useVirtualizerScrollHandlers(within.params));
    act(() => {
      r2.result.current.handleScroll({
        currentTarget: within.el,
      } as unknown as React.UIEvent<HTMLDivElement>);
    });
    expect(within.setShowFloorButton).toHaveBeenCalledWith(false);
  });

  it('物理底仍是贴底（缓冲带远端）；与 R12 前物理口径逐值等价', () => {
    const phys = makeHandlersFixture();
    phys.isAtBottomRef.current = true;
    phys.observedTopRef.current = 1500;
    phys.el.scrollTop = 1600;
    const r1 = renderHook(() => useVirtualizerScrollHandlers(phys.params));
    act(() => {
      r1.result.current.handleScroll({
        currentTarget: phys.el,
      } as unknown as React.UIEvent<HTMLDivElement>);
    });
    expect(phys.setIsAtBottom).not.toHaveBeenCalledWith(false);
    expect(phys.setShowFloorButton).toHaveBeenCalledWith(false);

    const legacy = makeHandlersFixture();
    legacy.isAtBottomRef.current = true;
    legacy.observedTopRef.current = 1500;
    legacy.el.scrollTop = 1479; // 距底 121（与内容底口径时代的等价例同值）
    const r2 = renderHook(() => useVirtualizerScrollHandlers(legacy.params));
    act(() => {
      r2.result.current.handleScroll({
        currentTarget: legacy.el,
      } as unknown as React.UIEvent<HTMLDivElement>);
    });
    expect(legacy.setShowFloorButton).toHaveBeenCalledWith(true);
  });
});

describe('R12-7：回底驱动（机制 B 逐帧提交 / 原生 smooth 退休 / 减少动效塌缩）', () => {
  let now = 0;
  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;
  let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let rafSeq = 0;

  function stubRaf() {
    rafQueue = [];
    rafSeq = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++rafSeq;
      rafQueue.push({ id, cb });
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafQueue = rafQueue.filter((f) => f.id !== id);
    });
  }

  function pumpFrames(stepMs = 16.7, max = 300) {
    let guard = 0;
    while (rafQueue.length > 0 && guard++ < max) {
      now += stepMs;
      const frames = rafQueue;
      rafQueue = [];
      for (const f of frames) f.cb(now);
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    nowSpy?.mockRestore();
    nowSpy = null;
  });

  it('长距离回底：逐帧单调提交、末帧精确 1600、总时长 450ms 档、scrollTo 零调用', () => {
    stubRaf();
    now = 10_000;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = makeHandlersFixture();
    f.el.scrollTop = 0;
    const { result } = renderHook(() => useVirtualizerScrollHandlers(f.params));
    act(() => {
      result.current.handleScrollToBottom();
    });
    pumpFrames();
    expect(f.committed.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < f.committed.length; i++) {
      expect(f.committed[i]!).toBeGreaterThan(f.committed[i - 1]!);
    }
    expect(f.committed[f.committed.length - 1]).toBe(1600);
    expect(now - 10_000).toBeGreaterThanOrEqual(450);
    expect(now - 10_000).toBeLessThan(450 + 16.7);
    expect(f.el.scrollTo).not.toHaveBeenCalled();
    expect(f.isAtBottomRef.current).toBe(true);
  });

  it('减少动效：单次同步提交到位，不排 rAF', () => {
    stubRaf();
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const f = makeHandlersFixture();
      f.el.scrollTop = 300;
      const { result } = renderHook(() =>
        useVirtualizerScrollHandlers(f.params)
      );
      act(() => {
        result.current.handleScrollToBottom();
      });
      expect(f.committed).toEqual([1600]);
      expect(rafQueue).toHaveLength(0);
      expect(f.isAtBottomRef.current).toBe(true);
      expect(f.el.scrollTo).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });
});
