/**
 * useComposerNotice 专属单元测试
 * 覆盖两阶段平滑退场状态机、120ms 延时保护、退场被打断即刻恢复等关键契约
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useComposerNotice } from '../useComposerNotice';
import type { ComposerNotice } from '../ComposerNoticeBar';

describe('useComposerNotice 状态机契约', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const testNotice1: ComposerNotice = {
    id: 'notice-1',
    type: 'warning',
    message: '警告：网络处于弱网模式',
  };

  const testNotice2: ComposerNotice = {
    id: 'notice-2',
    type: 'error',
    message: '错误：请求被拒绝',
  };

  it('1. 初始化时正确反映 noticeProp 状态', () => {
    const { result, rerender } = renderHook(
      ({ notice }) =>
        useComposerNotice({
          attachments: [],
          noticeProp: notice,
        }),
      {
        initialProps: { notice: testNotice1 as ComposerNotice | null },
      }
    );

    expect(result.current.effectiveNotice).toEqual(testNotice1);
    expect(result.current.isClosing).toBe(false);

    rerender({ notice: null });
    expect(result.current.effectiveNotice).toBeNull();
    expect(result.current.isClosing).toBe(false);
  });

  it('2. 点击 dismiss 触发两阶段退场：先 isClosing=true (维持 notice)，120ms 后 unmount (置 null)', () => {
    const onDismissNotice = vi.fn();
    const { result } = renderHook(() =>
      useComposerNotice({
        attachments: [],
        noticeProp: testNotice1,
        onDismissNotice,
      })
    );

    expect(result.current.effectiveNotice).toEqual(testNotice1);
    expect(result.current.isClosing).toBe(false);

    // 触发 dismiss
    act(() => {
      result.current.handleDismissNotice();
    });

    // 第一阶段：立即置位 isClosing=true，通知依然保留供 CSS 退场动画渲染
    expect(result.current.isClosing).toBe(true);
    expect(result.current.effectiveNotice).toEqual(testNotice1);
    expect(onDismissNotice).toHaveBeenCalledTimes(1);

    // 100ms 时仍然在退场中
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.isClosing).toBe(true);
    expect(result.current.effectiveNotice).toEqual(testNotice1);

    // 满 120ms 后：第二阶段完成，彻底卸载
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(result.current.isClosing).toBe(false);
    expect(result.current.effectiveNotice).toBeNull();
  });

  it('3. 退场期间若父组件传入新 noticeProp，立即打断退出状态机并展示新通知', () => {
    const { result, rerender } = renderHook(
      ({ notice }) =>
        useComposerNotice({
          attachments: [],
          noticeProp: notice,
        }),
      {
        initialProps: { notice: testNotice1 as ComposerNotice | null },
      }
    );

    // 触发 dismiss
    act(() => {
      result.current.handleDismissNotice();
    });
    expect(result.current.isClosing).toBe(true);

    // 60ms 时（退场进行中），外部突发新的 error 通知
    act(() => {
      vi.advanceTimersByTime(60);
    });
    rerender({ notice: testNotice2 });

    // 状态机应立即复位：isClosing=false，effectiveNotice=testNotice2
    expect(result.current.isClosing).toBe(false);
    expect(result.current.effectiveNotice).toEqual(testNotice2);

    // 再过 120ms 也不应该被原先的 timer 置空
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.isClosing).toBe(false);
    expect(result.current.effectiveNotice).toEqual(testNotice2);
  });

  it('4. 退场期间外部将 noticeProp 置为 null，不提前中断 120ms 动画', () => {
    const { result, rerender } = renderHook(
      ({ notice }) =>
        useComposerNotice({
          attachments: [],
          noticeProp: notice,
        }),
      {
        initialProps: { notice: testNotice1 as ComposerNotice | null },
      }
    );

    // 触发 dismiss
    act(() => {
      result.current.handleDismissNotice();
    });
    expect(result.current.isClosing).toBe(true);

    // 父组件响应式地将 noticeProp 置 null
    rerender({ notice: null });

    // 在 120ms 满之前，仍保持 isClosing=true 与旧 notice
    expect(result.current.isClosing).toBe(true);
    expect(result.current.effectiveNotice).toEqual(testNotice1);

    // 满 120ms 后正常完成退出
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(result.current.isClosing).toBe(false);
    expect(result.current.effectiveNotice).toBeNull();
  });

  it('5. 组件卸载安全清理定时器', () => {
    const { result, unmount } = renderHook(() =>
      useComposerNotice({
        attachments: [],
        noticeProp: testNotice1,
      })
    );

    act(() => {
      result.current.handleDismissNotice();
    });
    expect(result.current.isClosing).toBe(true);

    // 卸载
    unmount();

    // 推进定时器不应抛出错误
    expect(() => {
      vi.advanceTimersByTime(200);
    }).not.toThrow();
  });
});
