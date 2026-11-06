// @vitest-environment jsdom
/**
 * Toast 堆叠几何的 motion 接线测试（2026-11-06 真源裁定：变换只走 motion 层）。
 *
 * 为什么 mock motion：motion 的帧循环调度器在 jsdom 里写不出 ToastCard 根
 * 节点的 transform——同文件内裸 motion.div 可以、ToastCard 不行（探针：
 * Mimic 同款 motion props 通过，ToastCard 恒为 none；原因未定位到 motion
 * 内部，疑似 ToastCard 渲染树内 AnimatePresence/G2Surface/倒计时 effect
 * 与 jsdom 帧循环的交互；真浏览器里同一接线实测正常，见修复报告的活测
 * 轨迹）。jsdom 里断言内联 transform 测的是环境，不是接线。
 * 因此本文件把 `m` 桩成普通 div，只断言接线本身：ToastCard 把 layoutStack
 * 的 target.y/scale 原样交给了 motion 的 animate，且目标变化时跟随更新。
 * 动画引擎本身由活测（MCP 轨迹 + 截图）覆盖。
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppToast } from '../../../services/toast/types';
import type { StackTarget } from '../toastStackMath';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  const ReactMod = await import('react');

  const flattenStyle = (
    style: Record<string, unknown> | undefined
  ): ReactMod.CSSProperties | undefined => {
    if (!style) return undefined;
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(style)) {
      // MotionValue → 当前值；x 不是 CSS 属性，真实组件里由 motion 的
      // transform 管线消费，桩里丢弃。
      if (k === 'x') continue;
      const value =
        v !== null &&
        typeof v === 'object' &&
        typeof (v as { get?: unknown }).get === 'function'
          ? (v as { get: () => unknown }).get()
          : v;
      out[k] = typeof value === 'number' ? value : String(value);
    }
    return out as unknown as ReactMod.CSSProperties;
  };

  const MotionStub = ReactMod.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) => {
      const {
        animate,
        transition,
        exit: _exit,
        initial: _initial,
        whileHover: _whileHover,
        whileTap: _whileTap,
        layout: _layout,
        ...rest
      } = props as Record<string, unknown> & {
        animate?: unknown;
        transition?: unknown;
      };
      return ReactMod.createElement('div', {
        ...(rest as Record<string, unknown>),
        ref,
        style: flattenStyle(
          (props as { style?: Record<string, unknown> }).style
        ),
        'data-animate':
          animate !== undefined ? JSON.stringify(animate) : undefined,
        'data-transition':
          transition !== undefined ? JSON.stringify(transition) : undefined,
      });
    }
  );

  return {
    ...actual,
    m: { div: MotionStub, span: MotionStub },
    motion: { div: MotionStub, span: MotionStub },
  };
});

import { ToastCard } from '../ToastCard';

const mockToast = (
  partial: Partial<AppToast> & Pick<AppToast, 'id' | 'message'>
): AppToast => ({
  type: 'info',
  duration: 3000,
  ariaLive: 'polite',
  timestamp: Date.now(),
  updateKey: Date.now(),
  ...partial,
});

describe('Toast 堆叠几何走 motion 层（接线）', () => {
  afterEach(() => {
    cleanup();
  });

  it('target.y/scale 原样交给 motion 的 animate', () => {
    const target: StackTarget = {
      y: 28,
      scale: 0.9,
      height: 56,
      opacity: 1,
      content: 0,
      origin: '50% 0',
    };
    const { container } = render(
      <ToastCard
        toast={mockToast({ id: 't-motion', message: '层叠卡片' })}
        index={2}
        target={target}
        frontmostHeight={56}
        offsetY={120}
        isPaused={false}
        onHeightMeasure={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const card = container.querySelector('[role="status"]') as HTMLElement;
    expect(JSON.parse(card.getAttribute('data-animate') ?? '{}')).toEqual({
      y: 28,
      scale: 0.9,
    });
    expect(JSON.parse(card.getAttribute('data-transition') ?? '{}')).toEqual({
      duration: 0.2,
      ease: [0.2, 0, 0, 1],
    });
  });

  it('堆叠目标变化时 animate 跟随更新', () => {
    const targetA: StackTarget = {
      y: 28,
      scale: 0.9,
      height: 56,
      opacity: 1,
      content: 0,
      origin: '50% 0',
    };
    const targetB: StackTarget = {
      y: 0,
      scale: 1,
      height: 56,
      opacity: 1,
      content: 1,
      origin: '50% 0',
    };
    const props = {
      toast: mockToast({ id: 't-motion-2', message: '跟随卡片' }),
      index: 1,
      frontmostHeight: 56,
      offsetY: 68,
      isPaused: false,
      onHeightMeasure: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { container, rerender } = render(
      <ToastCard {...props} target={targetA} />
    );
    const card = container.querySelector('[role="status"]') as HTMLElement;
    expect(JSON.parse(card.getAttribute('data-animate') ?? '{}')).toEqual({
      y: 28,
      scale: 0.9,
    });

    rerender(<ToastCard {...props} target={targetB} />);
    expect(JSON.parse(card.getAttribute('data-animate') ?? '{}')).toEqual({
      y: 0,
      scale: 1,
    });
  });

  it('无 target 时 animate 为原点（y 0 / scale 1）', () => {
    const { container } = render(
      <ToastCard
        toast={mockToast({ id: 't-motion-3', message: '单卡片' })}
        index={0}
        frontmostHeight={56}
        offsetY={0}
        isPaused={false}
        onHeightMeasure={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const card = container.querySelector('[role="status"]') as HTMLElement;
    expect(JSON.parse(card.getAttribute('data-animate') ?? '{}')).toEqual({
      y: 0,
      scale: 1,
    });
  });
});
