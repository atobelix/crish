// @vitest-environment jsdom
/**
 * useComposerMultiline 单元测试：
 * 1. 单例 Canvas 2D 离屏度量
 * 2. 虚拟单行基准解耦（Decoupled Baseline）
 * 3. 24px 双门限施密特迟滞区间（Schmitt Trigger Deadband）
 * 4. 120ms 振荡熔断与 400ms 自愈保护
 * 5. ResizeObserver + RAF 防抖调度
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLIP_THRESHOLD,
  FLIP_WINDOW_MS,
  GRID_GUTTER_PX,
  HYSTERESIS_BUFFER_PX,
  LOCKOUT_DURATION_MS,
  MIN_CAPACITY_PX,
  measureTextWidthCanvas,
  useComposerMultiline,
} from './useComposerMultiline';

describe('useComposerMultiline 状态机与交互优化', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
      contextId: string
    ) => {
      if (contextId === '2d') {
        return {
          font: '',
          measureText: (text: string) => ({
            width: text.length * 10, // 每个字符 10px 宽度
          }),
        } as any;
      }
      return null;
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('measureTextWidthCanvas: 使用单例 Canvas 2D 离屏度量文本宽度', () => {
    const width = measureTextWidthCanvas('hello', '14px sans-serif');
    expect(width).toBe(50); // 5 * 10px
  });

  it('附件或显式换行时正常展开多行态', () => {
    const layoutRef = { current: null };

    // 初始有换行符
    const { result: r1 } = renderHook(() =>
      useComposerMultiline({
        text: 'hello\nworld',
        hasAttachments: false,
        layoutRef,
      })
    );
    expect(r1.current).toBe(true);

    // 初始有附件：正常展开为多行态
    const { result: r2 } = renderHook(() =>
      useComposerMultiline({
        text: 'single line',
        hasAttachments: true,
        layoutRef,
      })
    );
    expect(r2.current).toBe(true);
  });

  it('虚拟单行基准解耦与单行/多行切换：capacity = layoutW - used', () => {
    // 创建虚拟 DOM 容器
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 500,
    });

    const left = document.createElement('div');
    left.setAttribute('data-composer-grid', 'left');
    Object.defineProperty(left, 'offsetWidth', {
      configurable: true,
      value: 50,
    });
    container.appendChild(left);

    const perm = document.createElement('div');
    perm.setAttribute('data-composer-grid', 'perm');
    Object.defineProperty(perm, 'offsetWidth', {
      configurable: true,
      value: 50,
    });
    container.appendChild(perm);

    const right = document.createElement('div');
    right.setAttribute('data-composer-grid', 'right');
    Object.defineProperty(right, 'offsetWidth', {
      configurable: true,
      value: 50,
    });
    container.appendChild(right);

    // used = 50 + 50 + 50 + 18 = 168
    // capacity = Math.max(200, 500 - 168) = 332px

    const layoutRef = { current: container };

    // 文本宽度 300px (30 字符 * 10) < capacity (332) -> false (单行)
    const { result, rerender } = renderHook(
      ({ text, hasAttachments }) =>
        useComposerMultiline({ text, hasAttachments, layoutRef }),
      {
        initialProps: {
          text: 'a'.repeat(30),
          hasAttachments: false,
        },
      }
    );
    expect(result.current).toBe(false);

    // 突破上门限：文本宽度 340px (34 字符 * 10) >= capacity (332) -> true (多行)
    rerender({
      text: 'a'.repeat(34),
      hasAttachments: false,
    });
    expect(result.current).toBe(true);
  });

  it('施密特迟滞死区（HYSTERESIS_BUFFER_PX = 24）：在 [capacity - 24, capacity] 内保持上一帧状态', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 400,
    });

    // used = 18 (GUTTER), capacity = Math.max(200, 400 - 18) = 382px
    // 上门限 = 382px (38.2 字符)
    // 下门限 = 382 - 24 = 358px (35.8 字符)
    // 死区 = [358px, 382px] -> [36 字符 (360px), 38 字符 (380px)]

    const layoutRef = { current: container };

    // 1. 从单行态进入死区 (360px < 382px) -> 依然保持单行态 false
    const { result, rerender } = renderHook(
      ({ text }) =>
        useComposerMultiline({ text, hasAttachments: false, layoutRef }),
      {
        initialProps: {
          text: 'a'.repeat(36), // 360px
        },
      }
    );
    expect(result.current).toBe(false);

    // 2. 突破上门限 (390px >= 382px) -> 切换为多行态 true
    rerender({ text: 'a'.repeat(39) });
    expect(result.current).toBe(true);

    // 3. 从多行态退回死区 (370px, 在 [358, 382] 区间) -> 依然保持多行态 true
    rerender({ text: 'a'.repeat(37) }); // 370px
    expect(result.current).toBe(true);

    // 4. 再次在死区微调 (360px, 在 [358, 382] 区间) -> 依然保持多行态 true
    rerender({ text: 'a'.repeat(36) }); // 360px
    expect(result.current).toBe(true);

    // 5. 跌破下门限 (350px < 358px) -> 触发收起，切换为单行态 false
    rerender({ text: 'a'.repeat(35) }); // 350px
    expect(result.current).toBe(false);
  });

  it('振荡熔断与自愈保护：120ms 内翻转 >= 3 次触发 400ms 强制锁定多行态', () => {
    let mockTime = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 400,
    });
    // capacity = 382px, 下门限 = 358px
    const layoutRef = { current: container };

    const { result, rerender } = renderHook(
      ({ text }) =>
        useComposerMultiline({ text, hasAttachments: false, layoutRef }),
      {
        initialProps: {
          text: 'a'.repeat(30), // 300px -> false (单行)
        },
      }
    );
    expect(result.current).toBe(false);

    // 翻转 1: 300px -> 390px (单行 -> 多行)
    mockTime += 10;
    rerender({ text: 'a'.repeat(39) });
    expect(result.current).toBe(true);

    // 翻转 2: 390px -> 300px (多行 -> 单行)
    mockTime += 20;
    rerender({ text: 'a'.repeat(30) });
    expect(result.current).toBe(false);

    // 翻转 3: 300px -> 390px (单行 -> 多行) -> 翻转达到 3 次，触发 400ms 熔断！
    mockTime += 20;
    rerender({ text: 'a'.repeat(39) });
    expect(result.current).toBe(true);

    // 熔断锁定中 (1050ms < 1050 + 400 = 1450ms)，即使输入跌破下门限 (300px)，仍强制保持多行态
    mockTime += 50; // 1100ms
    rerender({ text: 'a'.repeat(30) });
    expect(result.current).toBe(true);

    // 熔断解除后 (mockTime = 1500 > 1450)，再次触发 measure 恢复自愈单行判定
    mockTime += 400; // 1500ms
    rerender({ text: 'a'.repeat(29) });
    expect(result.current).toBe(false);
  });

  it('ResizeObserver 回调通过 RAF 防抖调度度量', () => {
    let roCallback: () => void = () => {};
    const observeMock = vi.fn();
    const disconnectMock = vi.fn();

    (globalThis as any).ResizeObserver = vi.fn().mockImplementation((cb) => {
      roCallback = cb;
      return {
        observe: observeMock,
        disconnect: disconnectMock,
      };
    });

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const container = document.createElement('div');
    const layoutRef = { current: container };

    const { unmount } = renderHook(() =>
      useComposerMultiline({ text: 'test', hasAttachments: false, layoutRef })
    );

    expect(observeMock).toHaveBeenCalledWith(container);

    // 触发 ResizeObserver
    act(() => {
      roCallback();
    });

    expect(rafSpy).toHaveBeenCalled();

    unmount();
    expect(disconnectMock).toHaveBeenCalled();
  });

  it('当 DOM 中出现多个段落或换行结构时立即判定为多行态且 input 事件触发 0ms 展开', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 600,
    });

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    container.appendChild(editable);

    const layoutRef = { current: container };

    // 初始单段落短文本：单行态
    const p1 = document.createElement('p');
    p1.textContent = 'hello';
    editable.appendChild(p1);

    const { result } = renderHook(() =>
      useComposerMultiline({ text: 'hello', hasAttachments: false, layoutRef })
    );
    expect(result.current).toBe(false);

    // 用户在富文本中按下回车，ProseMirror 产生第二个空段落并派发 input 事件
    act(() => {
      const p2 = document.createElement('p');
      const br = document.createElement('br');
      p2.appendChild(br);
      editable.appendChild(p2);

      editable.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(result.current).toBe(true);
  });
});
