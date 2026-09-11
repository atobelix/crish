// @vitest-environment jsdom
/**
 * ui/Tooltip 极限对抗压力与立体验证测试套件 (PE-04 T4.3)
 *
 * 覆盖四大对抗场景与负向红线断言：
 * 1. 高频快速扫射测试：
 *    - 模拟用户在 100ms 内快速划过 10 个按钮（每键 10ms 触发 mouseEnter -> mouseLeave）
 *    - 断言所有孤儿 rAF 被彻底拦截/注销，最终 DOM 树中 [data-tooltip-portal="true"] 节点数绝对为 0
 *    - 包含 default delayShow (350ms) 与 immediate (0ms) 进出场状态机双轨对抗
 * 2. 单槽强排他性测试：
 *    - 两个及多个 Tooltip 在 50ms 内先后触发/并发激活
 *    - MutationObserver 全程严密监控 DOM 突变，断言任何时刻页面 Tooltip 数量绝对 <= 1
 *    - 后发者弹出时前一个立刻被剥离
 * 3. 离屏/失焦/滚动自毁测试：
 *    - Tooltip 激活期间派发全局滚动事件（window scroll capture）、Escape 按键、window blur、window resize、外部 pointerdown
 *    - 断言立刻物理销毁，DOM 节点数为 0
 * 4. 快捷键徽标渲染测试：
 *    - 验证 shortcut="Ctrl+N" 能够渲染出 <kbd class="tooltipKbd"> 结构并携带正确的文本
 *    - 覆盖单字符快捷键 shortcut="?"（顶栏帮助按钮场景）
 *    - 覆盖按键数组 shortcut={['Ctrl', 'Shift', 'P']}
 *    - 负向用例：未传入 shortcut 时严禁渲染 <kbd class="tooltipKbd">
 */
/* eslint-disable max-lines-per-function, react/no-multi-comp */
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from '@testing-library/react';
import { Tooltip } from './Tooltip';
import {
  DEFAULT_DELAY_SHOW_MS,
  resetTooltipControllerForTests,
} from './tooltipController';
import { layerStackManager } from '../internal/layer-stack/LayerStackManager';
import styles from './Tooltip.module.css';

afterEach(() => {
  cleanup();
  resetTooltipControllerForTests();
  layerStackManager.dispose();
  document.documentElement.removeAttribute('data-floating-active');
  document.body?.removeAttribute('data-floating-active');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ui/Tooltip 极限对抗压力与立体验证测试套件', () => {
  describe('1. 高频快速扫射测试 (High-Frequency Rapid Sweep)', () => {
    it('模拟 100ms 内连续刷过 10 个默认延迟按钮（10ms 停留后离开）：零孤儿 rAF，最终 DOM 中 [data-tooltip-portal="true"] 严格为 0', () => {
      vi.useFakeTimers();

      render(
        <div data-testid="toolbar">
          {Array.from({ length: 10 }).map((_, i) => (
            <Tooltip key={i} content={`扫射提示-${i}`}>
              <button type="button" data-testid={`sweep-btn-${i}`}>
                按钮-{i}
              </button>
            </Tooltip>
          ))}
        </div>
      );

      // 100ms 内连续刷过 10 个按钮：每个按钮 mouseEnter -> 10ms -> mouseLeave
      for (let i = 0; i < 10; i++) {
        const btn = screen.getByTestId(`sweep-btn-${i}`);
        fireEvent.mouseEnter(btn);
        act(() => {
          vi.advanceTimersByTime(10);
        });
        fireEvent.mouseLeave(btn);
      }

      // 扫射结束后推进时间，超过意图停留时间（350ms）
      act(() => {
        vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS + 200);
      });

      // 负向断言：DOM 树中没有任何幽灵残留
      const portals = document.querySelectorAll('[data-tooltip-portal="true"]');
      expect(portals.length).toBe(0);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('零延迟（delayShow=0）高频扫射对抗：进入即触发出场动画但 10ms 后移开，断言孤儿 rAF 被全量注销，DOM 节点数为 0', () => {
      vi.useFakeTimers();

      render(
        <div data-testid="instant-toolbar">
          {Array.from({ length: 10 }).map((_, i) => (
            <Tooltip key={i} content={`立即提示-${i}`} delayShow={0}>
              <button type="button" data-testid={`instant-btn-${i}`}>
                即开-{i}
              </button>
            </Tooltip>
          ))}
        </div>
      );

      // 模拟用户光标极速划过每一个即开按钮（触发 commitShow 后 10ms 立刻离开）
      for (let i = 0; i < 10; i++) {
        const btn = screen.getByTestId(`instant-btn-${i}`);
        fireEvent.mouseEnter(btn);
        act(() => {
          vi.advanceTimersByTime(10);
        });
        fireEvent.mouseLeave(btn);
      }

      // 推进多帧，让挂起的所有 rAF 与定时器彻底流转
      act(() => {
        vi.advanceTimersByTime(300);
      });

      // 强断言：所有孤儿双重 rAF 必须已被 cancelAnimationFrame 拦截，不得复活挂载 portal
      const portals = document.querySelectorAll('[data-tooltip-portal="true"]');
      expect(portals.length).toBe(0);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('中途停顿激活后继续扫射：前 4 个快速略过，第 5 个停满 400ms 弹出，移开扫完剩余 5 个后全灭零残留', () => {
      vi.useFakeTimers();

      render(
        <div data-testid="dwell-toolbar">
          {Array.from({ length: 10 }).map((_, i) => (
            <Tooltip key={i} content={`停顿提示-${i}`} delayShow={DEFAULT_DELAY_SHOW_MS}>
              <button type="button" data-testid={`dwell-btn-${i}`}>
                按键-{i}
              </button>
            </Tooltip>
          ))}
        </div>
      );

      // 前 4 个快速划过（各 10ms）
      for (let i = 0; i < 4; i++) {
        const btn = screen.getByTestId(`dwell-btn-${i}`);
        fireEvent.mouseEnter(btn);
        act(() => {
          vi.advanceTimersByTime(10);
        });
        fireEvent.mouseLeave(btn);
      }

      // 第 5 个停满 400ms（超过 350ms）
      const btn4 = screen.getByTestId('dwell-btn-4');
      fireEvent.mouseEnter(btn4);
      act(() => {
        vi.advanceTimersByTime(400);
      });

      // 此时第 5 个处于激活显示状态
      expect(document.querySelectorAll('[data-tooltip-portal="true"]').length).toBe(1);
      expect(screen.getByRole('tooltip')).toHaveTextContent('停顿提示-4');

      // 移开第 5 个，继续极速扫过剩余 5 个
      fireEvent.mouseLeave(btn4);
      for (let i = 5; i < 10; i++) {
        const btn = screen.getByTestId(`dwell-btn-${i}`);
        fireEvent.mouseEnter(btn);
        act(() => {
          vi.advanceTimersByTime(10);
        });
        fireEvent.mouseLeave(btn);
      }

      act(() => {
        vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS + 200);
      });

      // 最终 DOM 中绝对零残留
      expect(document.querySelectorAll('[data-tooltip-portal="true"]').length).toBe(0);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  describe('2. 单槽强排他性测试 (Single-Slot Exclusivity)', () => {
    it('两个 Tooltip 在 50ms 内先后触发：后发者弹出时前一个立刻被剥离，任何时刻页面 Tooltip 数量绝对 <= 1', () => {
      vi.useFakeTimers();

      let maxPortalsObserved = 0;
      const observer = new MutationObserver(() => {
        const count = document.querySelectorAll('[data-tooltip-portal="true"]').length;
        if (count > maxPortalsObserved) {
          maxPortalsObserved = count;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      render(
        <div>
          <Tooltip content="第一项提示" delayShow={20}>
            <button type="button" data-testid="excl-btn-1">
              按钮一
            </button>
          </Tooltip>
          <Tooltip content="第二项提示" delayShow={20}>
            <button type="button" data-testid="excl-btn-2">
              按钮二
            </button>
          </Tooltip>
        </div>
      );

      // 触发第一个 Tooltip
      fireEvent.mouseEnter(screen.getByTestId('excl-btn-1'));
      act(() => {
        vi.advanceTimersByTime(25);
      });

      // 第一个已显示
      expect(document.querySelectorAll('[data-tooltip-portal="true"]').length).toBe(1);
      expect(screen.getByRole('tooltip')).toHaveTextContent('第一项提示');

      // 20ms 后（处于 50ms 窗口内）触发第二个 Tooltip
      act(() => {
        vi.advanceTimersByTime(20);
      });
      fireEvent.mouseEnter(screen.getByTestId('excl-btn-2'));
      act(() => {
        vi.advanceTimersByTime(25);
      });

      // 后发者抢占插槽后，前一个立刻被剥离
      const portals = document.querySelectorAll('[data-tooltip-portal="true"]');
      expect(portals.length).toBe(1);
      expect(screen.getByRole('tooltip')).toHaveTextContent('第二项提示');
      expect(screen.queryByText('第一项提示')).toBeNull();

      // MutationObserver 全程监控的不变式：任何瞬间绝对不能超过 1
      expect(maxPortalsObserved).toBeLessThanOrEqual(1);

      observer.disconnect();
    });

    it('多项交替高频争抢单槽：无论如何并发触发，页面中活跃 Tooltip 数量始终严格 <= 1', () => {
      vi.useFakeTimers();

      let maxCount = 0;
      const checkMax = () => {
        const current = document.querySelectorAll('[data-tooltip-portal="true"]').length;
        if (current > maxCount) maxCount = current;
        expect(current).toBeLessThanOrEqual(1);
      };

      render(
        <div>
          {Array.from({ length: 5 }).map((_, i) => (
            <Tooltip key={i} content={`争抢提示-${i}`} delayShow={10}>
              <button type="button" data-testid={`race-btn-${i}`}>
                争抢-{i}
              </button>
            </Tooltip>
          ))}
        </div>
      );

      // 在微秒/毫秒级时间差内交替派发 mouseEnter
      for (let i = 0; i < 5; i++) {
        fireEvent.mouseEnter(screen.getByTestId(`race-btn-${i}`));
        act(() => {
          vi.advanceTimersByTime(12);
        });
        checkMax();
      }

      // 最终应该只有最后一个 Tooltip 挂载在 DOM 树
      const portals = document.querySelectorAll('[data-tooltip-portal="true"]');
      expect(portals.length).toBe(1);
      expect(screen.getByRole('tooltip')).toHaveTextContent('争抢提示-4');
      expect(maxCount).toBeLessThanOrEqual(1);
    });
  });

  describe('3. 离屏/失焦/滚动自毁测试 (Off-screen / Blur / Scroll Self-Destruction)', () => {
    it('全局滚动事件派发时立刻物理销毁当前 Tooltip', () => {
      render(
        <Tooltip content="滚动即灭提示" delayShow={0}>
          <button type="button">滚动测试按钮</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('滚动测试按钮'));
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeInTheDocument();

      // 全局滚动触发
      fireEvent.scroll(window);
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeNull();
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('按下 Escape 键时立刻物理销毁当前 Tooltip', () => {
      render(
        <Tooltip content="Esc即灭提示" delayShow={0}>
          <button type="button">Esc测试按钮</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('Esc测试按钮'));
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeInTheDocument();

      // Escape 键触发
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeNull();
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('窗口失焦 (window blur) 时立刻物理销毁当前 Tooltip', () => {
      render(
        <Tooltip content="失焦即灭提示" delayShow={0}>
          <button type="button">失焦测试按钮</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('失焦测试按钮'));
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeNull();
    });

    it('窗口尺寸变化 (window resize) 时立刻物理销毁当前 Tooltip', () => {
      render(
        <Tooltip content="尺寸变化即灭提示" delayShow={0}>
          <button type="button">调整尺寸按钮</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('调整尺寸按钮'));
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeNull();
    });

    it('外部指针按下 (pointerdown on document) 时立刻物理销毁当前 Tooltip', () => {
      render(
        <Tooltip content="点击即灭提示" delayShow={0}>
          <button type="button">点击测试按钮</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('点击测试按钮'));
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeInTheDocument();

      fireEvent.pointerDown(document.body);
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeNull();
    });

    it('宿主元素卸载/离开 DOM 树时，Tooltip 同步自毁不留孤儿 DOM', () => {
      function DynamicHost() {
        const [mounted, setMounted] = useState(true);
        return (
          <div>
            <button type="button" onClick={() => setMounted(false)}>
              卸载宿主
            </button>
            {mounted && (
              <Tooltip content="动态宿主提示" delayShow={0}>
                <button type="button">宿主按钮</button>
              </Tooltip>
            )}
          </div>
        );
      }

      render(<DynamicHost />);
      fireEvent.mouseEnter(screen.getByText('宿主按钮'));
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeInTheDocument();

      // 卸载宿主组件
      fireEvent.click(screen.getByText('卸载宿主'));
      expect(document.querySelector('[data-tooltip-portal="true"]')).toBeNull();
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  describe('4. 快捷键徽标渲染测试 (Shortcut Badge Rendering)', () => {
    it('shortcut="Ctrl+N" 能够渲染出 <kbd class="tooltipKbd"> 结构并携带正确的文本', () => {
      render(
        <Tooltip content="新建对话" shortcut="Ctrl+N" delayShow={0}>
          <button type="button">新建</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('新建'));
      const tip = screen.getByRole('tooltip');
      expect(tip).toBeInTheDocument();
      expect(tip).toHaveTextContent('新建对话');

      const kbd = tip.querySelector('kbd');
      expect(kbd).toBeInTheDocument();
      expect(kbd).toHaveTextContent('Ctrl+N');

      // 验证类名携带 tooltipKbd（兼容 CSS Modules 哈希化与原始类名）
      const hasKbdClass =
        Boolean(styles.tooltipKbd && kbd?.classList.contains(styles.tooltipKbd)) ||
        Boolean(kbd?.classList.contains('tooltipKbd')) ||
        Boolean(kbd?.className.includes('tooltipKbd'));
      expect(hasKbdClass).toBe(true);
    });

    it('单字符快捷键 shortcut="?"（顶栏帮助按钮场景）正常渲染', () => {
      render(
        <Tooltip content="快捷键与帮助" shortcut="?" delayShow={0}>
          <button type="button">帮助</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('帮助'));
      const tip = screen.getByRole('tooltip');
      const kbd = tip.querySelector('kbd');
      expect(kbd).toBeInTheDocument();
      expect(kbd).toHaveTextContent('?');
    });

    it('按键数组 shortcut={["Ctrl", "Shift", "P"]} 正常拼接渲染', () => {
      render(
        <Tooltip content="命令面板" shortcut={['Ctrl', 'Shift', 'P']} delayShow={0}>
          <button type="button">命令</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('命令'));
      const tip = screen.getByRole('tooltip');
      const kbd = tip.querySelector('kbd');
      expect(kbd).toBeInTheDocument();
      expect(kbd?.textContent).toMatch(/Ctrl.*Shift.*P/);
    });

    it('负向断言：未传入 shortcut 时严禁渲染任何 <kbd class="tooltipKbd"> 节点', () => {
      render(
        <Tooltip content="纯文本提示" delayShow={0}>
          <button type="button">无快捷键按钮</button>
        </Tooltip>
      );

      fireEvent.mouseEnter(screen.getByText('无快捷键按钮'));
      const tip = screen.getByRole('tooltip');
      expect(tip).toBeInTheDocument();
      expect(tip.querySelector('kbd')).toBeNull();
    });
  });
});
