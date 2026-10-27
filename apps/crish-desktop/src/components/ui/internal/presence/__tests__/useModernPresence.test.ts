// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useModernPresence,
  computeSafetyTimeout,
  isJSDOMEnvironment,
} from '../useModernPresence';

describe('useModernPresence 动效生命期与自愈兜底机制', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('1. 辅助函数与标尺计算断言 (computeSafetyTimeout & isJSDOMEnvironment)', () => {
    it('显式传入 safetyTimeoutMs 时优先使用配置值', () => {
      expect(computeSafetyTimeout({ safetyTimeoutMs: 500 })).toBe(500);
      expect(computeSafetyTimeout({ safetyTimeoutMs: 0 })).toBe(0);
      expect(
        computeSafetyTimeout({ safetyTimeoutMs: 450, duration: 200 })
      ).toBe(450);
    });

    it('根据 durationMs 或 duration 按 max(duration, 150) + 50ms 计算安全天花板', () => {
      // duration < 150: max(100, 150) + 50 = 200ms
      expect(computeSafetyTimeout({ duration: 100 })).toBe(200);
      expect(computeSafetyTimeout({ durationMs: 120 })).toBe(200);

      // duration = 200: max(200, 150) + 50 = 250ms
      expect(computeSafetyTimeout({ duration: 200 })).toBe(250);
      expect(computeSafetyTimeout({ durationMs: 200 })).toBe(250);

      // duration = 260 (Conex spring duration): max(260, 150) + 50 = 310ms
      expect(computeSafetyTimeout({ duration: 260 })).toBe(310);
      expect(computeSafetyTimeout({ durationMs: 260 })).toBe(310);
    });

    it('未指定任何时长参数时默认返回 300ms 安全兜底', () => {
      expect(computeSafetyTimeout({})).toBe(300);
    });

    it('在 JSDOM 自动化测试环境中 isJSDOMEnvironment 返回 true', () => {
      expect(isJSDOMEnvironment()).toBe(true);
    });
  });

  describe('2. 初始挂载与属性派发 (Initial Mounting & Ergonomics)', () => {
    it('当 visible 为 false 时，初始状态未挂载且 data-state 为 closed', () => {
      const { result } = renderHook(() =>
        useModernPresence({
          visible: false,
        })
      );

      expect(result.current.isMounted).toBe(false);
      expect(result.current.dataState).toBe('closed');
      expect(result.current.presenceProps['data-state']).toBe('closed');
      expect(typeof result.current.presenceProps.onTransitionEnd).toBe(
        'function'
      );
    });

    it('当 visible 为 true 时，初始状态已挂载且 data-state 为 open', () => {
      const { result } = renderHook(() =>
        useModernPresence({
          visible: true,
        })
      );

      expect(result.current.isMounted).toBe(true);
      expect(result.current.dataState).toBe('open');
      expect(result.current.presenceProps['data-state']).toBe('open');
    });
  });

  describe('3. JSDOM 测试环境自愈与旁路测试 (JSDOM Auto-Bypass)', () => {
    it('默认在 JSDOM 环境下 visible 从 true 变 false 立即同步卸载，杜绝单测被挂死', () => {
      const onExitComplete = vi.fn();
      const { result, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      expect(result.current.isMounted).toBe(true);
      expect(result.current.dataState).toBe('open');

      // 切换为关闭状态
      act(() => {
        rerender({ visible: false });
      });

      // JSDOM 自愈探测生效：同步卸载且触发 onExitComplete，无需等待定时器
      expect(result.current.isMounted).toBe(false);
      expect(result.current.dataState).toBe('closed');
      expect(result.current.presenceProps['data-state']).toBe('closed');
      expect(onExitComplete).toHaveBeenCalledTimes(1);
    });

    it('显式设置 bypassInTest: true 同样立即同步卸载', () => {
      const onExitComplete = vi.fn();
      const { result, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            bypassInTest: true,
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      expect(result.current.isMounted).toBe(true);

      act(() => {
        rerender({ visible: false });
      });

      expect(result.current.isMounted).toBe(false);
      expect(onExitComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. 正常生命期测试 (Real Browser Simulation with bypassInTest: false)', () => {
    it('visible 变为 false 时保持 isMounted 为 true，等待 transitionend 触发物理卸载', () => {
      const onExitComplete = vi.fn();
      const { result, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            bypassInTest: false,
            duration: 200,
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      expect(result.current.isMounted).toBe(true);

      act(() => {
        rerender({ visible: false });
      });

      // 刚进入退出阶段：处于过渡状态，DOM 仍挂载，但 data-state 变为 closed
      expect(result.current.isMounted).toBe(true);
      expect(result.current.dataState).toBe('closed');
      expect(result.current.presenceProps['data-state']).toBe('closed');
      expect(onExitComplete).not.toHaveBeenCalled();

      // 模拟当前宿主 DOM 元素派发 transitionend 事件
      const hostElement = document.createElement('div');
      act(() => {
        result.current.presenceProps.onTransitionEnd({
          target: hostElement,
          currentTarget: hostElement,
          propertyName: 'opacity',
        } as any);
      });

      // 动画顺利结束：物理卸载完成
      expect(result.current.isMounted).toBe(false);
      expect(onExitComplete).toHaveBeenCalledTimes(1);
    });

    it('严格过滤子元素过渡冒泡事件 (target !== currentTarget 时禁止误卸载)', () => {
      const onExitComplete = vi.fn();
      const { result, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            bypassInTest: false,
            duration: 200,
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      act(() => {
        rerender({ visible: false });
      });

      expect(result.current.isMounted).toBe(true);

      // 模拟子元素（如弹窗内部按钮悬停颜色过渡完成）冒泡上来的 transitionend
      const hostElement = document.createElement('div');
      const childButton = document.createElement('button');
      act(() => {
        result.current.presenceProps.onTransitionEnd({
          target: childButton,
          currentTarget: hostElement,
          propertyName: 'background-color',
        } as any);
      });

      // 容器绝不提前卸载
      expect(result.current.isMounted).toBe(true);
      expect(onExitComplete).not.toHaveBeenCalled();

      // 宿主自身的过渡结束时才正式卸载
      act(() => {
        result.current.presenceProps.onTransitionEnd({
          target: hostElement,
          currentTarget: hostElement,
          propertyName: 'opacity',
        } as any);
      });

      expect(result.current.isMounted).toBe(false);
      expect(onExitComplete).toHaveBeenCalledTimes(1);
    });

    it('支持 exitProperty 精准多属性过渡守卫', () => {
      const onExitComplete = vi.fn();
      const hostElement = document.createElement('div');
      const { result, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            bypassInTest: false,
            exitProperty: 'opacity',
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      act(() => {
        rerender({ visible: false });
      });

      // 元素先触发了更短的 transform 过渡结束
      act(() => {
        result.current.presenceProps.onTransitionEnd({
          target: hostElement,
          currentTarget: hostElement,
          propertyName: 'transform',
        } as any);
      });

      // 未命中 exitProperty，保持挂载
      expect(result.current.isMounted).toBe(true);
      expect(onExitComplete).not.toHaveBeenCalled();

      // 命中 exitProperty='opacity' 时完成卸载
      act(() => {
        result.current.presenceProps.onTransitionEnd({
          target: hostElement,
          currentTarget: hostElement,
          propertyName: 'opacity',
        } as any);
      });

      expect(result.current.isMounted).toBe(false);
      expect(onExitComplete).toHaveBeenCalledTimes(1);
    });

    it('退出中途重新唤起（竞态防抖）：visible 恢复为 true 时取消退出并保持挂载', () => {
      const onExitComplete = vi.fn();
      const { result, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            bypassInTest: false,
            duration: 200,
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      // 1. 关闭弹窗
      act(() => {
        rerender({ visible: false });
      });
      expect(result.current.isMounted).toBe(true);
      expect(result.current.dataState).toBe('closed');

      // 2. 动效未结束前快速再次打开弹窗
      act(() => {
        rerender({ visible: true });
      });
      expect(result.current.isMounted).toBe(true);
      expect(result.current.dataState).toBe('open');

      // 3. 即使偶发收到旧的 transitionend 事件，也不会误卸载
      const hostElement = document.createElement('div');
      act(() => {
        result.current.presenceProps.onTransitionEnd({
          target: hostElement,
          currentTarget: hostElement,
          propertyName: 'opacity',
        } as any);
      });

      expect(result.current.isMounted).toBe(true);
      expect(result.current.dataState).toBe('open');
      expect(onExitComplete).not.toHaveBeenCalled();
    });
  });

  describe('5. 双重安全天花板兜底超时自愈测试 (Safety Timeout Ceiling)', () => {
    it('在 transitionend 丢失时（如 prefers-reduced-motion 或后台标签页），超时强制卸载', () => {
      const onExitComplete = vi.fn();
      // duration 200ms -> safetyTimeoutMs = max(200, 150) + 50 = 250ms
      const { result, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            bypassInTest: false,
            duration: 200,
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      act(() => {
        rerender({ visible: false });
      });

      expect(result.current.isMounted).toBe(true);

      // 前进 240ms：尚未到达安全天花板 250ms
      act(() => {
        vi.advanceTimersByTime(240);
      });
      expect(result.current.isMounted).toBe(true);
      expect(onExitComplete).not.toHaveBeenCalled();

      // 前进到 250ms：安全兜底定时器触发强制物理卸载
      act(() => {
        vi.advanceTimersByTime(10);
      });
      expect(result.current.isMounted).toBe(false);
      expect(onExitComplete).toHaveBeenCalledTimes(1);
    });

    it('显式配置 safetyTimeoutMs 时按指定时间强制自愈卸载', () => {
      const onExitComplete = vi.fn();
      const { result, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            bypassInTest: false,
            safetyTimeoutMs: 180,
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      act(() => {
        rerender({ visible: false });
      });

      act(() => {
        vi.advanceTimersByTime(179);
      });
      expect(result.current.isMounted).toBe(true);

      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(result.current.isMounted).toBe(false);
      expect(onExitComplete).toHaveBeenCalledTimes(1);
    });

    it('组件外部提前卸载时自动清理兜底定时器，防止内存泄漏', () => {
      const onExitComplete = vi.fn();
      const { unmount, rerender } = renderHook(
        ({ visible }) =>
          useModernPresence({
            visible,
            bypassInTest: false,
            duration: 200,
            onExitComplete,
          }),
        {
          initialProps: { visible: true },
        }
      );

      act(() => {
        rerender({ visible: false });
      });

      // 外部卸载组件
      unmount();

      // 快进时间，确保定时器已被清理，不会抛出状态更新错误或多余调用
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(onExitComplete).not.toHaveBeenCalled();
    });
  });
});
