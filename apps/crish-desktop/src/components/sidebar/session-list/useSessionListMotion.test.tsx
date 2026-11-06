// @vitest-environment jsdom
/**
 * useSessionListMotion 测试（S6）
 * 覆盖：入场标记、退场快照（位置锚点 + 到期摘除）、重排 FLIP（位移量与整移跳过）、
 * 混合大改静默同步、搜索/拖拽/窗口化抑制、减动效直落。
 *
 * 注意：jsdom 无布局，getBoundingClientRect 与 Element.animate 均以 mock 注入；
 * FLIP 断言的是 hook 发出的 WAAPI 调用参数（位移量），真实逐帧轨迹由实机验收覆盖。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { render, cleanup } from '@testing-library/react';
import type { SessionState } from '../../../store/types';
import {
  useSessionListMotion,
  SESSION_ROW_LEAVE_MS,
  type UseSessionListMotionOptions,
} from './useSessionListMotion';
import {
  SESSION_ROW_SHIFT_DURATION_MS,
  SESSION_ROW_SHIFT_EASING,
} from './sessionListDragShift';

function makeSession(id: string): SessionState {
  return { id } as SessionState;
}

function idsOf(display: Array<{ s: SessionState }>): string[] {
  return display.map((d) => d.s.id);
}

const animateMock = vi.fn(() => ({ cancel: vi.fn() }));
const topsById = new Map<string, number>();
/** jsdom 未实现 Web Animations API：Element.prototype.animate 根本不存在，
 *  vi.spyOn 会对缺失方法抛错（"animate does not exist"），故直接赋值 mock、
 *  并在 afterEach 手动还原（不可用 spyOn/restoreAllMocks 管理它）。 */
let originalAnimate: typeof Element.prototype.animate | undefined;

function installDomMocks() {
  originalAnimate = Element.prototype.animate;
  Element.prototype.animate = animateMock as unknown as typeof Element.prototype.animate;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      const id = this.getAttribute('data-session-id');
      const top = (id && topsById.get(id)) ?? 0;
      return {
        top,
        left: 0,
        bottom: top + 28,
        right: 200,
        width: 200,
        height: 28,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    }
  );
}

beforeEach(() => {
  animateMock.mockClear();
  topsById.clear();
  installDomMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  if (originalAnimate === undefined) {
    delete (Element.prototype as unknown as Record<string, unknown>).animate;
  } else {
    Element.prototype.animate = originalAnimate;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useSessionListMotion 入场/退场', () => {
  it('首挂载：全部 steady，不做入场', () => {
    const { result } = renderHook(() =>
      useSessionListMotion([makeSession('a'), makeSession('b')])
    );
    expect(idsOf(result.current.displaySessions)).toEqual(['a', 'b']);
    expect(
      result.current.displaySessions.every((d) => d.motion.kind === 'steady')
    ).toBe(true);
  });

  it('新增行：标记 enter，gapAfter 按展示顺序计算', () => {
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions),
      { initialProps: { sessions: [makeSession('a'), makeSession('b')] } }
    );
    rerender({
      sessions: [makeSession('n'), makeSession('a'), makeSession('b')],
    });
    const display = result.current.displaySessions;
    expect(idsOf(display)).toEqual(['n', 'a', 'b']);
    expect(display[0]!.motion).toEqual({ kind: 'enter', gapAfter: true });
    expect(display[1]!.motion.kind).toBe('steady');
    // 入场标记 250ms 后回收
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(
      result.current.displaySessions.every((d) => d.motion.kind === 'steady')
    ).toBe(true);
  });

  it('空表首行不做入场（首挂载填充门控）', () => {
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions),
      { initialProps: { sessions: [] } }
    );
    rerender({ sessions: [makeSession('a')] });
    expect(result.current.displaySessions[0]!.motion.kind).toBe('steady');
  });

  it('删除行：快照插回原位（afterId 锚点），200ms 后摘除', () => {
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions),
      {
        initialProps: {
          sessions: [makeSession('a'), makeSession('b'), makeSession('c')],
        },
      }
    );
    rerender({ sessions: [makeSession('a'), makeSession('c')] });
    const display = result.current.displaySessions;
    expect(idsOf(display)).toEqual(['a', 'b', 'c']);
    expect(display[1]!.motion.kind).toBe('leaving');
    expect(display[1]!.motion.gapAfter).toBe(true);
    expect(display[2]!.motion.kind).toBe('steady');
    act(() => {
      vi.advanceTimersByTime(SESSION_ROW_LEAVE_MS);
    });
    expect(idsOf(result.current.displaySessions)).toEqual(['a', 'c']);
  });

  it('删除末尾行：快照 gapAfter 为 false', () => {
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions),
      {
        initialProps: {
          sessions: [makeSession('a'), makeSession('b')],
        },
      }
    );
    rerender({ sessions: [makeSession('a')] });
    const display = result.current.displaySessions;
    expect(idsOf(display)).toEqual(['a', 'b']);
    expect(display[1]!.motion).toEqual({ kind: 'leaving', gapAfter: false });
  });

  it('连续删除链：快照沿锚点链传递解析，全部原位呈现（折叠收起回归）', () => {
    // wysiwygFlowLayout 回归：收起 24→10 时 14 行互为锚点，旧实现只留末尾 1 个
    // （li 计数 10+1=11）；锚点须沿链解析到存活行/null，14 个快照全数原位呈现。
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions),
      {
        initialProps: {
          sessions: [
            makeSession('a'),
            makeSession('b'),
            makeSession('c'),
            makeSession('d'),
            makeSession('e'),
          ],
        },
      }
    );
    rerender({ sessions: [makeSession('a'), makeSession('b')] });
    const display = result.current.displaySessions;
    expect(idsOf(display)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(display[2]!.motion.kind).toBe('leaving');
    expect(display[3]!.motion.kind).toBe('leaving');
    expect(display[4]!.motion.kind).toBe('leaving');
    expect(display[4]!.motion.gapAfter).toBe(false);
    act(() => {
      vi.advanceTimersByTime(SESSION_ROW_LEAVE_MS);
    });
    expect(idsOf(result.current.displaySessions)).toEqual(['a', 'b']);
  });

  it('连续删除链锚到中间存活行：快照按原位插在存活行之前', () => {
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions),
      {
        initialProps: {
          sessions: [
            makeSession('a'),
            makeSession('b'),
            makeSession('c'),
            makeSession('d'),
            makeSession('e'),
            makeSession('f'),
          ],
        },
      }
    );
    rerender({ sessions: [makeSession('a'), makeSession('f')] });
    const display = result.current.displaySessions;
    expect(idsOf(display)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(display.slice(1, 5).every((d) => d.motion.kind === 'leaving')).toBe(
      true
    );
    expect(display[5]!.motion.kind).toBe('steady');
  });

  it('重排：顺序跟随新数组，全部 steady（FLIP 由布局 effect 另行驱动）', () => {
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions),
      {
        initialProps: {
          sessions: [makeSession('a'), makeSession('b'), makeSession('c')],
        },
      }
    );
    rerender({
      sessions: [makeSession('c'), makeSession('a'), makeSession('b')],
    });
    expect(idsOf(result.current.displaySessions)).toEqual(['c', 'a', 'b']);
    expect(
      result.current.displaySessions.every((d) => d.motion.kind === 'steady')
    ).toBe(true);
  });

  it('混合大改（新增+删除共 13 条）：静默同步，无入场/退场标记', () => {
    const before = Array.from({ length: 10 }, (_, i) => makeSession(`s${i}`));
    const after = Array.from({ length: 10 }, (_, i) => makeSession(`t${i}`));
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions),
      { initialProps: { sessions: before } }
    );
    // 10 删 + 3 增 = 13 > 阈值 12
    rerender({ sessions: after.slice(0, 3) });
    expect(idsOf(result.current.displaySessions)).toEqual([
      't0',
      't1',
      't2',
    ]);
    expect(
      result.current.displaySessions.every((d) => d.motion.kind === 'steady')
    ).toBe(true);
  });

  it('disabled 期间的变化静默同步；恢复后当次也不补动画', () => {
    const { result, rerender } = renderHook(
      ({
        sessions,
        disabled,
      }: {
        sessions: SessionState[];
        disabled: boolean;
      }) => useSessionListMotion(sessions, { disabled }),
      {
        initialProps: {
          sessions: [makeSession('a'), makeSession('b')],
          disabled: false,
        },
      }
    );
    rerender({
      sessions: [makeSession('a'), makeSession('b')],
      disabled: true,
    });
    rerender({
      sessions: [makeSession('a'), makeSession('c')],
      disabled: true,
    });
    expect(idsOf(result.current.displaySessions)).toEqual(['a', 'c']);
    expect(
      result.current.displaySessions.every((d) => d.motion.kind === 'steady')
    ).toBe(true);
    // 恢复非 disabled：当次以新表为基线，不补入场
    rerender({
      sessions: [makeSession('a'), makeSession('c')],
      disabled: false,
    });
    expect(
      result.current.displaySessions.every((d) => d.motion.kind === 'steady')
    ).toBe(true);
  });

  it('windowed 直通：增删均无标记', () => {
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionState[] }) =>
        useSessionListMotion(sessions, { windowed: true }),
      {
        initialProps: {
          sessions: [makeSession('a'), makeSession('b')],
        },
      }
    );
    rerender({ sessions: [makeSession('a'), makeSession('c')] });
    expect(idsOf(result.current.displaySessions)).toEqual(['a', 'c']);
    expect(
      result.current.displaySessions.every((d) => d.motion.kind === 'steady')
    ).toBe(true);
  });
});

describe('useSessionListMotion FLIP', () => {
  function Harness({
    sessions,
    options,
  }: {
    sessions: SessionState[];
    options?: UseSessionListMotionOptions;
  }) {
    const { displaySessions, listRef } = useSessionListMotion(
      sessions,
      options
    );
    return (
      <ul ref={listRef}>
        {displaySessions.map(({ s, motion }) => (
          <li
            key={s.id}
            data-session-id={s.id}
            data-motion={motion.kind === 'steady' ? undefined : motion.kind}
          >
            {s.id}
          </li>
        ))}
      </ul>
    );
  }

  it('重排：位移行收到 WAAPI 调用，位移量 = 旧 top − 新 top', () => {
    topsById.set('a', 0).set('b', 31).set('c', 62);
    const { rerender } = render(
      <Harness
        sessions={[makeSession('a'), makeSession('b'), makeSession('c')]}
      />
    );
    expect(animateMock).not.toHaveBeenCalled();
    topsById.set('c', 0).set('a', 31).set('b', 62);
    rerender(
      <Harness
        sessions={[makeSession('c'), makeSession('a'), makeSession('b')]}
      />
    );
    expect(animateMock).toHaveBeenCalledTimes(3);
    const calls = animateMock.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual([
      { transform: 'translateY(62px)' },
      { transform: 'translateY(0px)' },
    ]);
    expect(calls).toContainEqual([
      { transform: 'translateY(-31px)' },
      { transform: 'translateY(0px)' },
    ]);
    for (const call of animateMock.mock.calls) {
      expect(call[1]).toEqual({
        duration: SESSION_ROW_SHIFT_DURATION_MS,
        easing: SESSION_ROW_SHIFT_EASING,
      });
    }
  });

  /** 以 tyById 模拟在飞 FLIP 的计算样式位移（rect 由 topsById 同步给出视觉值）。 */
  function stubComputedTranslateY(tyById: Map<string, number>) {
    const origGCS = window.getComputedStyle.bind(window);
    return vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation(((el: Element) => {
        const cs = origGCS(el);
        const id = el.getAttribute?.('data-session-id');
        const ty = (id && tyById.get(id)) || 0;
        if (!ty) return cs;
        return { ...cs, transform: `matrix(1, 0, 0, 1, 0, ${ty})` };
      }) as typeof window.getComputedStyle);
  }

  it('FLIP 在飞时后续提交不重发：位移经计算样式扣除，不反号、不取消', () => {
    topsById.set('a', 0).set('b', 31);
    const { rerender } = render(
      <Harness sessions={[makeSession('a'), makeSession('b')]} />
    );
    topsById.set('b', 0).set('a', 31);
    rerender(<Harness sessions={[makeSession('b'), makeSession('a')]} />);
    expect(animateMock).toHaveBeenCalledTimes(2);
    const anims = animateMock.mock.results.map(
      (r) => r.value as { cancel: ReturnType<typeof vi.fn> }
    );
    // 在飞首帧：rect 含动画位移（b 视觉 = 布局 0 + 31；a 视觉 = 布局 31 − 31）
    topsById.set('b', 31).set('a', 0);
    const gcsSpy = stubComputedTranslateY(
      new Map([
        ['b', 31],
        ['a', -31],
      ])
    );
    // 数据未变的后续提交（如回合流式刷新）：不得取消在飞动画、不得新发动画
    rerender(<Harness sessions={[makeSession('b'), makeSession('a')]} />);
    expect(animateMock).toHaveBeenCalledTimes(2);
    for (const a of anims) expect(a.cancel).not.toHaveBeenCalled();
    gcsSpy.mockRestore();
  });

  it('FLIP 在飞时再次重排：起始帧取当前视觉位置（连续重定向）', () => {
    topsById.set('a', 0).set('b', 31);
    const { rerender } = render(
      <Harness sessions={[makeSession('a'), makeSession('b')]} />
    );
    topsById.set('b', 0).set('a', 31);
    rerender(<Harness sessions={[makeSession('b'), makeSession('a')]} />);
    expect(animateMock).toHaveBeenCalledTimes(2);
    animateMock.mockClear();
    // 在飞中途顺序换回 [a, b]：布局回到 a=0 / b=31，旧动画当前位移 a=−10 / b=+10，
    // 故视觉位置为 a=−10 / b=41（rect 值），计算样式同步给出该位移
    topsById.set('a', -10).set('b', 41);
    const gcsSpy = stubComputedTranslateY(
      new Map([
        ['a', -10],
        ['b', 10],
      ])
    );
    rerender(<Harness sessions={[makeSession('a'), makeSession('b')]} />);
    // 起始位移 = 当前视觉 − 新布局：a: −10 − 0 = −10；b: 41 − 31 = +10
    const calls = animateMock.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual([
      { transform: 'translateY(-10px)' },
      { transform: 'translateY(0px)' },
    ]);
    expect(calls).toContainEqual([
      { transform: 'translateY(10px)' },
      { transform: 'translateY(0px)' },
    ]);
    gcsSpy.mockRestore();
  });

  it('全部行同量位移（容器整体移动）：不做 FLIP', () => {    topsById.set('a', 0).set('b', 31);
    const { rerender } = render(
      <Harness sessions={[makeSession('a'), makeSession('b')]} />
    );
    topsById.set('a', 100).set('b', 131);
    // 顺序不变、仅整体下移 100px（如上方分区折叠/滚动）
    rerender(<Harness sessions={[makeSession('a'), makeSession('b')]} />);
    expect(animateMock).not.toHaveBeenCalled();
  });

  it('减动效：不做 FLIP', () => {
    topsById.set('a', 0).set('b', 31);
    const { rerender } = render(
      <Harness sessions={[makeSession('a'), makeSession('b')]} />
    );
    // 首轮已建基线；此刻再开减动效，重排应直落
    const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal(
      'matchMedia',
      matchMediaMock as unknown as typeof window.matchMedia
    );
    topsById.set('a', 31).set('b', 0);
    rerender(<Harness sessions={[makeSession('b'), makeSession('a')]} />);
    expect(animateMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
