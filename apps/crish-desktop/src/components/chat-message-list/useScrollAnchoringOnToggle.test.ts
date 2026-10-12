/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useScrollAnchoringOnToggle,
  isRecordEqual,
  TOGGLE_INTERACTIVE_SELECTOR,
  SCROLLBAR_TRACK_HIT_WIDTH_PX,
  ANCHOR_GUARD_LOCK_WINDOW_MS,
} from './useScrollAnchoringOnToggle';
import type { SessionMessage } from '../../store/types';

describe('useScrollAnchoringOnToggle', () => {
  function setup(
    initialProps: {
      messages?: SessionMessage[];
      expandedUserMsgs?: Record<string, boolean>;
      expandedTools?: Record<string, boolean>;
    } = {}
  ) {
    const isAtBottomRef = { current: true };
    const setIsAtBottom = vi.fn((val: boolean) => {
      isAtBottomRef.current = val;
    });
    const cancelProgrammaticScroll = vi.fn();
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {
      value: 600,
      configurable: true,
    });
    const containerRef = { current: container };

    const { result, rerender } = renderHook(
      (props) =>
        useScrollAnchoringOnToggle({
          containerRef,
          isAtBottomRef,
          setIsAtBottom,
          cancelProgrammaticScroll,
          ...props,
        }),
      { initialProps }
    );

    return {
      result,
      rerender,
      isAtBottomRef,
      setIsAtBottom,
      cancelProgrammaticScroll,
      container,
    };
  }

  describe('isRecordEqual 工具函数', () => {
    it('相同引用或双空时返回 true', () => {
      expect(isRecordEqual(undefined, undefined)).toBe(true);
      expect(isRecordEqual({}, {})).toBe(true);
      expect(isRecordEqual(undefined, {})).toBe(true);
      expect(isRecordEqual({}, undefined)).toBe(true);
      const obj = { a: true };
      expect(isRecordEqual(obj, obj)).toBe(true);
      expect(isRecordEqual({ a: true }, { a: true })).toBe(true);
    });

    it('内容不同时返回 false', () => {
      expect(isRecordEqual({ a: true }, { a: false })).toBe(false);
      expect(isRecordEqual({ a: true }, { b: true })).toBe(false);
      expect(isRecordEqual({ a: true }, {})).toBe(false);
      expect(isRecordEqual({}, { a: true })).toBe(false);
    });
  });

  it('点击右侧滚动条轨道时：解除吸底，取消程序滚动', () => {
    const {
      result,
      isAtBottomRef,
      setIsAtBottom,
      cancelProgrammaticScroll,
      container,
    } = setup();

    const mockEvent = {
      nativeEvent: {
        offsetX: 600 - SCROLLBAR_TRACK_HIT_WIDTH_PX + 2, // 命中滚动条
      },
      currentTarget: container,
      target: container,
    } as unknown as React.PointerEvent<HTMLDivElement>;

    act(() => {
      result.current.handlePointerDownCapture(mockEvent);
    });

    expect(cancelProgrammaticScroll).toHaveBeenCalled();
    expect(isAtBottomRef.current).toBe(false);
    expect(setIsAtBottom).toHaveBeenCalledWith(false);
  });

  it('点击折叠/展开控件（role="button", aria-expanded, details, summary等）时：解除吸底，使内容自然向下展开', () => {
    const {
      result,
      isAtBottomRef,
      setIsAtBottom,
      cancelProgrammaticScroll,
      container,
    } = setup();

    const toggleBtn = document.createElement('div');
    toggleBtn.setAttribute('role', 'button');
    toggleBtn.setAttribute('aria-expanded', 'false');
    const childSpan = document.createElement('span');
    toggleBtn.appendChild(childSpan);
    container.appendChild(toggleBtn);

    const mockEvent = {
      nativeEvent: { offsetX: 100 }, // 非滚动条位置
      currentTarget: container,
      target: childSpan, // 点击子元素经 .closest 向上匹配
    } as unknown as React.PointerEvent<HTMLDivElement>;

    act(() => {
      result.current.handlePointerDownCapture(mockEvent);
    });

    expect(cancelProgrammaticScroll).toHaveBeenCalled();
    expect(isAtBottomRef.current).toBe(false);
    expect(setIsAtBottom).toHaveBeenCalledWith(false);
  });

  it('点击普通文本或无交互段落时：不触发解除吸底', () => {
    const {
      result,
      isAtBottomRef,
      setIsAtBottom,
      cancelProgrammaticScroll,
      container,
    } = setup();

    const plainP = document.createElement('p');
    container.appendChild(plainP);

    const mockEvent = {
      nativeEvent: { offsetX: 100 },
      currentTarget: container,
      target: plainP,
    } as unknown as React.PointerEvent<HTMLDivElement>;

    act(() => {
      result.current.handlePointerDownCapture(mockEvent);
    });

    expect(cancelProgrammaticScroll).toHaveBeenCalled();
    expect(isAtBottomRef.current).toBe(true);
    expect(setIsAtBottom).not.toHaveBeenCalled();
  });

  it('键盘 Enter 或 Space 聚焦触发折叠/展开时：解除吸底', () => {
    const {
      result,
      isAtBottomRef,
      setIsAtBottom,
      cancelProgrammaticScroll,
      container,
    } = setup();

    const summaryEl = document.createElement('summary');
    container.appendChild(summaryEl);

    const mockEvent = {
      key: 'Enter',
      target: summaryEl,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    act(() => {
      result.current.handleKeyDownCapture(mockEvent);
    });

    expect(cancelProgrammaticScroll).toHaveBeenCalled();
    expect(isAtBottomRef.current).toBe(false);
    expect(setIsAtBottom).toHaveBeenCalledWith(false);
  });

  it('原生 <details> toggle 事件触发时：解除吸底', () => {
    const {
      isAtBottomRef,
      setIsAtBottom,
      cancelProgrammaticScroll,
      container,
    } = setup();

    const detailsEl = document.createElement('details');
    container.appendChild(detailsEl);

    act(() => {
      detailsEl.dispatchEvent(new Event('toggle', { bubbles: false }));
    });

    expect(cancelProgrammaticScroll).toHaveBeenCalled();
    expect(isAtBottomRef.current).toBe(false);
    expect(setIsAtBottom).toHaveBeenCalledWith(false);
  });

  it('外部展开状态（expandedUserMsgs / expandedTools）真实变更时：解除吸底', () => {
    const { rerender, isAtBottomRef, setIsAtBottom, cancelProgrammaticScroll } =
      setup({
        expandedUserMsgs: { m1: false },
      });

    expect(isAtBottomRef.current).toBe(true);

    // 传入等价空对象时不应触发
    act(() => {
      rerender({ expandedUserMsgs: { m1: false } });
    });
    expect(isAtBottomRef.current).toBe(true);

    // 真正翻转状态时触发解除吸底
    act(() => {
      rerender({ expandedUserMsgs: { m1: true } });
    });

    expect(cancelProgrammaticScroll).toHaveBeenCalled();
    expect(isAtBottomRef.current).toBe(false);
    expect(setIsAtBottom).toHaveBeenCalledWith(false);
  });

  it('用户主动发送新消息时：恢复吸底', () => {
    const initialMsgs: SessionMessage[] = [
      { id: 'm1', sender: 'user', text: '你好', timestamp: 1000 },
    ];
    const { rerender, isAtBottomRef, setIsAtBottom } = setup({
      messages: initialMsgs,
    });

    // 假设刚才用户点击折叠解除了吸底
    isAtBottomRef.current = false;

    // 用户在输入框发送了一条新提问
    const updatedMsgs: SessionMessage[] = [
      ...initialMsgs,
      { id: 'm2', sender: 'assistant', text: '你好！', timestamp: 2000 },
      { id: 'm3', sender: 'user', text: '第二条提问', timestamp: 3000 },
    ];

    act(() => {
      rerender({ messages: updatedMsgs });
    });

    expect(isAtBottomRef.current).toBe(true);
    expect(setIsAtBottom).toHaveBeenCalledWith(true);
  });

  describe('500ms 锚定保护锁（Anchor Guard Lock）', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('初始状态下 isAnchorLocked() 返回 false', () => {
      const { result } = setup();
      expect(result.current.isAnchorLocked()).toBe(false);
    });

    it('点击折叠/展开控件后：isAnchorLocked() 在 500ms 内返回 true，500ms 超时后返回 false', () => {
      vi.useFakeTimers();
      const { result, container } = setup();

      const toggleBtn = document.createElement('button');
      toggleBtn.setAttribute('data-testid', 'toggle-btn');
      container.appendChild(toggleBtn);

      const mockEvent = {
        nativeEvent: { offsetX: 50 },
        currentTarget: container,
        target: toggleBtn,
      } as unknown as React.PointerEvent<HTMLDivElement>;

      act(() => {
        result.current.handlePointerDownCapture(mockEvent);
      });

      // 刚触发时：处于 500ms 锁定窗口内
      expect(result.current.isAnchorLocked()).toBe(true);

      // 前进 250ms：仍在锁定窗口内
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(result.current.isAnchorLocked()).toBe(true);

      // 前进 251ms（累计 501ms > 500ms）：保护锁已过期
      act(() => {
        vi.advanceTimersByTime(251);
      });
      expect(result.current.isAnchorLocked()).toBe(false);
    });

    it('键盘 Enter 激活折叠/展开：触发 500ms 保护锁，超时后解锁', () => {
      vi.useFakeTimers();
      const { result, container } = setup();

      const summaryEl = document.createElement('summary');
      container.appendChild(summaryEl);

      const mockEvent = {
        key: 'Enter',
        target: summaryEl,
      } as unknown as React.KeyboardEvent<HTMLDivElement>;

      act(() => {
        result.current.handleKeyDownCapture(mockEvent);
      });

      expect(result.current.isAnchorLocked()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(ANCHOR_GUARD_LOCK_WINDOW_MS + 1);
      });
      expect(result.current.isAnchorLocked()).toBe(false);
    });

    it('原生 details toggle 事件与外部展开状态变更均激活 500ms 保护锁', () => {
      vi.useFakeTimers();
      const { result, rerender, container } = setup({
        expandedTools: { tool_1: false },
      });

      // (a) 原生 details toggle
      const detailsEl = document.createElement('details');
      container.appendChild(detailsEl);
      act(() => {
        detailsEl.dispatchEvent(new Event('toggle', { bubbles: false }));
      });
      expect(result.current.isAnchorLocked()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(ANCHOR_GUARD_LOCK_WINDOW_MS + 1);
      });
      expect(result.current.isAnchorLocked()).toBe(false);

      // (b) 外部 expandedTools 状态变更
      act(() => {
        rerender({ expandedTools: { tool_1: true } });
      });
      expect(result.current.isAnchorLocked()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(ANCHOR_GUARD_LOCK_WINDOW_MS + 1);
      });
      expect(result.current.isAnchorLocked()).toBe(false);
    });

    it('用户发送新消息时：重置锚定锁并恢复吸底', () => {
      vi.useFakeTimers();
      const initialMsgs: SessionMessage[] = [
        { id: 'm1', sender: 'user', text: '你好', timestamp: 1000 },
      ];
      const { result, rerender, isAtBottomRef, container } = setup({
        messages: initialMsgs,
      });

      // 触发一次折叠/展开点击
      const toggleBtn = document.createElement('button');
      toggleBtn.setAttribute('data-testid', 'toggle-btn');
      container.appendChild(toggleBtn);
      act(() => {
        result.current.handlePointerDownCapture({
          nativeEvent: { offsetX: 50 },
          currentTarget: container,
          target: toggleBtn,
        } as unknown as React.PointerEvent<HTMLDivElement>);
      });

      expect(result.current.isAnchorLocked()).toBe(true);
      expect(isAtBottomRef.current).toBe(false);

      // 用户发送新提问
      const updatedMsgs: SessionMessage[] = [
        ...initialMsgs,
        { id: 'm2', sender: 'assistant', text: '回答', timestamp: 2000 },
        { id: 'm3', sender: 'user', text: '新问题', timestamp: 3000 },
      ];
      act(() => {
        rerender({ messages: updatedMsgs });
      });

      expect(result.current.isAnchorLocked()).toBe(false);
      expect(isAtBottomRef.current).toBe(true);
    });
  });
});
