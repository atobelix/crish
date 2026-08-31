// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { usePinnedScroll, resolveMaxHeight, BOTTOM_THRESHOLD_PX } from '../usePinnedScroll';

describe('usePinnedScroll and resolveMaxHeight', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, opts: ScrollToOptions | number, y?: number) {
      if (typeof opts === 'object' && opts.top !== undefined) {
        this.scrollTop = opts.top;
      } else if (typeof opts === 'number') {
        this.scrollTop = y ?? 0;
      }
    });
  });
  describe('resolveMaxHeight', () => {
    it('正确解析数值与字符串高度', () => {
      expect(resolveMaxHeight(480)).toBe('480px');
      expect(resolveMaxHeight('50vh')).toBe('50vh');
      expect(resolveMaxHeight('100%')).toBe('100%');
      expect(resolveMaxHeight(0)).toBeUndefined();
      expect(resolveMaxHeight(-50)).toBeUndefined();
      expect(resolveMaxHeight(Number.POSITIVE_INFINITY)).toBeUndefined();
      expect(resolveMaxHeight(Number.NaN)).toBeUndefined();
      expect(resolveMaxHeight('0')).toBeUndefined();
      expect(resolveMaxHeight('none')).toBeUndefined();
      expect(resolveMaxHeight('Infinity')).toBeUndefined();
      expect(resolveMaxHeight('')).toBeUndefined();
      expect(resolveMaxHeight(undefined)).toBeUndefined();
    });
  });

  describe('usePinnedScroll 视口锚定与吸底机制', () => {
    function setupScrollElement(el: HTMLDivElement) {
      Object.defineProperty(el, 'scrollHeight', { value: 1000, writable: true, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 300, writable: true, configurable: true });
      Object.defineProperty(el, 'scrollTop', { value: 700, writable: true, configurable: true }); // exactly at bottom (1000 - 700 - 300 = 0)
      el.scrollTo = vi.fn((opts: ScrollToOptions | number, y?: number) => {
        if (typeof opts === 'object' && opts.top !== undefined) {
          el.scrollTop = opts.top;
        } else if (typeof opts === 'number') {
          el.scrollTop = y ?? 0;
        }
      });
      return el;
    }

    function TestScrollComponent(props: {
      isActive: boolean;
      enabled: boolean;
      contentKey?: unknown;
    }) {
      const ref = usePinnedScroll(props);
      return React.createElement('div', { ref, 'data-testid': 'viewport' });
    }

    it('流式更新时若处于吸底态，以 instant 瞬时定位滚动到底部', () => {
      const { getByTestId, rerender } = render(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-1',
        })
      );

      const el = getByTestId('viewport') as HTMLDivElement;
      setupScrollElement(el);

      // Simulate content growth
      el.scrollHeight = 1200;
      rerender(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-2',
        })
      );

      expect(el.scrollTo).toHaveBeenCalledWith({
        top: 1200,
        behavior: 'instant',
      });
    });

    it('用户滚轮上滑时通过 Capture 阶段立即解除吸底锁定，后续内容增长不强制扯回底部', () => {
      const { getByTestId, rerender } = render(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-1',
        })
      );

      const el = getByTestId('viewport') as HTMLDivElement;
      setupScrollElement(el);

      // User scrolls up (deltaY < 0)
      const wheelEvent = new WheelEvent('wheel', { deltaY: -50, bubbles: true });
      el.dispatchEvent(wheelEvent);

      vi.mocked(el.scrollTo).mockClear();

      // Content grows
      el.scrollHeight = 1400;
      rerender(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-2',
        })
      );

      // Should NOT scroll to bottom because isPinned was unlocked by wheel
      expect(el.scrollTo).not.toHaveBeenCalled();
    });

    it('8px 容差吸底判断：距离底部 < 8px 维持/恢复锁定，>= 8px 解锁', () => {
      const { getByTestId, rerender } = render(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-1',
        })
      );

      const el = getByTestId('viewport') as HTMLDivElement;
      setupScrollElement(el);

      // User scrolled up: scrollHeight = 1000, clientHeight = 300, scrollTop = 680
      // distanceToBottom = 1000 - 680 - 300 = 20px (>= 8px) -> unlocked
      el.scrollTop = 680;
      el.dispatchEvent(new Event('scroll'));

      vi.mocked(el.scrollTo).mockClear();
      el.scrollHeight = 1100;
      rerender(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-2',
        })
      );
      expect(el.scrollTo).not.toHaveBeenCalled();

      // User scrolled back near bottom: scrollTop = 795, scrollHeight = 1100, clientHeight = 300
      // distanceToBottom = 1100 - 795 - 300 = 5px (< 8px) -> re-locked
      el.scrollTop = 795;
      el.dispatchEvent(new Event('scroll'));

      // Next chunk arrives -> should auto scroll to bottom
      el.scrollHeight = 1300;
      rerender(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-3',
        })
      );
      expect(el.scrollTo).toHaveBeenCalledWith({
        top: 1300,
        behavior: 'instant',
      });
    });

    it('触控板/移动端 touchmove 上滑时在 Capture 阶段解锁吸底', () => {
      const { getByTestId, rerender } = render(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-1',
        })
      );

      const el = getByTestId('viewport') as HTMLDivElement;
      setupScrollElement(el);

      // Simulate touchstart then touchmove downward (content scrolls up)
      const touchStart = new Event('touchstart') as any;
      touchStart.touches = [{ clientY: 200 }];
      el.dispatchEvent(touchStart);

      const touchMove = new Event('touchmove') as any;
      touchMove.touches = [{ clientY: 260 }]; // moved down 60px
      el.dispatchEvent(touchMove);

      vi.mocked(el.scrollTo).mockClear();
      el.scrollHeight = 1500;
      rerender(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'chunk-2',
        })
      );
      expect(el.scrollTo).not.toHaveBeenCalled();
    });

    it('当流式重新开启时（isActive 从 false 变为 true），自动恢复吸底锁定', () => {
      const { getByTestId, rerender } = render(
        React.createElement(TestScrollComponent, {
          isActive: false,
          enabled: true,
          contentKey: 'initial',
        })
      );

      const el = getByTestId('viewport') as HTMLDivElement;
      setupScrollElement(el);

      // Unlock manually
      const wheelEvent = new WheelEvent('wheel', { deltaY: -50, bubbles: true });
      el.dispatchEvent(wheelEvent);

      // Start new stream
      rerender(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: true,
          contentKey: 'stream-chunk-1',
        })
      );

      expect(el.scrollTo).toHaveBeenCalledWith({
        top: 1000,
        behavior: 'instant',
      });
    });

    it('当 enabled 为 false 时，不执行 scrollTo', () => {
      const { getByTestId, rerender } = render(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: false,
          contentKey: 'chunk-1',
        })
      );

      const el = getByTestId('viewport') as HTMLDivElement;
      setupScrollElement(el);

      el.scrollHeight = 1200;
      rerender(
        React.createElement(TestScrollComponent, {
          isActive: true,
          enabled: false,
          contentKey: 'chunk-2',
        })
      );
      expect(el.scrollTo).not.toHaveBeenCalled();
    });
  });
});
