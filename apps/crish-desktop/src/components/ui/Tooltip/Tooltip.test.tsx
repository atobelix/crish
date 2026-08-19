// @vitest-environment jsdom
/**
 * ui/Tooltip 测试：单例、delayShow 快移、滚动即灭、离屏不钳回
 */
/* eslint-disable max-lines-per-function, react/no-multi-comp */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from '@testing-library/react';
import { Tooltip, type TooltipProps } from './Tooltip';
import {
  DEFAULT_DELAY_SHOW_MS,
  resetTooltipControllerForTests,
} from './tooltipController';
import { isTriggerOffscreen } from './tooltipPositioning';
import { layerStackManager } from '../internal/layer-stack/LayerStackManager';
import styles from './Tooltip.module.css';
import { MockPhysicalGeometryEngine } from '../../../test-utils/MockPhysicalGeometryEngine';

/** 几何/透传用例跳过 delay，避免与意图停留断言缠在一起 */
function Tip(props: TooltipProps) {
  return <Tooltip {...props} delayShow={props.delayShow ?? 0} />;
}

afterEach(() => {
  cleanup();
  resetTooltipControllerForTests();
  layerStackManager.dispose();
  document.documentElement.removeAttribute('data-floating-active');
  document.body?.removeAttribute('data-floating-active');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ui/Tooltip', () => {
  it('mouseEnter 未满 delayShow 不渲染；停满才经 portal 出现', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="提示内容">
        <button type="button">悬停目标</button>
      </Tooltip>
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText('悬停目标'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS - 1);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('提示内容');
    expect(tip.parentElement).toBe(document.body);
  });

  it('快移未满 delayShow：一颗都不出', () => {
    vi.useFakeTimers();
    render(
      <>
        <Tooltip content="快移甲">
          <button type="button">快移目标甲</button>
        </Tooltip>
        <Tooltip content="快移乙">
          <button type="button">快移目标乙</button>
        </Tooltip>
      </>
    );
    fireEvent.mouseEnter(screen.getByText('快移目标甲'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByText('快移目标甲'));
    fireEvent.mouseEnter(screen.getByText('快移目标乙'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.mouseLeave(screen.getByText('快移目标乙'));
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS + 50);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('同时 hover 两颗只渲染一个 portal（后来者关掉前者）', () => {
    render(
      <>
        <Tip content="提示甲">
          <button type="button">目标甲</button>
        </Tip>
        <Tip content="提示乙">
          <button type="button">目标乙</button>
        </Tip>
      </>
    );
    fireEvent.mouseEnter(screen.getByText('目标甲'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('提示甲');
    fireEvent.mouseEnter(screen.getByText('目标乙'));
    const tips = screen.getAllByRole('tooltip');
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveTextContent('提示乙');
  });

  it('mouseLeave 后隐藏（含 delayHide 延迟）', () => {
    vi.useFakeTimers();
    render(
      <Tip content="延迟提示" delayHide={300}>
        <button type="button">延迟目标</button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('延迟目标'));
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByText('延迟目标'));
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('disabled 或空 content 时不渲染任何包裹行为', () => {
    const { rerender } = render(
      <Tip content="禁用提示" disabled>
        <button type="button">禁用目标</button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('禁用目标'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    rerender(
      <Tip content="">
        <button type="button">空内容目标</button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('空内容目标'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('ref 透传：子元素 ref 与 forwardRef 合并（历史修复回归）', () => {
    const btnRef = { current: null as HTMLButtonElement | null };
    function Harness() {
      return (
        <Tip
          content="ref 提示"
          ref={btnRef as React.RefObject<HTMLButtonElement>}
        >
          <button type="button">ref 目标</button>
        </Tip>
      );
    }
    render(<Harness />);
    expect(btnRef.current).toBe(screen.getByText('ref 目标'));
  });

  it('子元素自身 onClick 与外部注入事件均不被截断（历史修复回归）', () => {
    const childOnClick = vi.fn();
    render(
      <Tip content="事件提示">
        <button type="button" onClick={childOnClick}>
          事件目标
        </button>
      </Tip>
    );
    fireEvent.click(screen.getByText('事件目标'));
    expect(childOnClick).toHaveBeenCalledTimes(1);
    fireEvent.mouseEnter(screen.getByText('事件目标'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('side 定位类切换（CSS Modules 哈希类）', () => {
    const { rerender } = render(
      <Tip content="下侧" side="bottom">
        <button type="button">下侧目标</button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('下侧目标'));
    expect(screen.getByRole('tooltip')).toHaveClass(styles.bottom);
    rerender(
      <Tip content="右侧" side="right">
        <button type="button">右侧目标</button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('右侧目标'));
    expect(screen.getByRole('tooltip')).toHaveClass(styles.right);
  });

  it('键盘 focus/blur 触发与隐藏提示（F7-F8）', () => {
    vi.useFakeTimers();
    render(
      <Tip content="键盘提示">
        <button type="button">焦点目标</button>
      </Tip>
    );
    fireEvent.focus(screen.getByText('焦点目标'));
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.blur(screen.getByText('焦点目标'));
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('提示经 aria-describedby 关联触发元素（F7-F8）', () => {
    render(
      <Tip content="关联描述">
        <button type="button">关联目标</button>
      </Tip>
    );
    fireEvent.focus(screen.getByText('关联目标'));
    const tip = screen.getByRole('tooltip');
    const tipId = tip.getAttribute('id');
    expect(tipId).toBeTruthy();
    expect(screen.getByText('关联目标')).toHaveAttribute(
      'aria-describedby',
      tipId
    );
  });

  it('视口右缘钳位：提示不溢出视口（F7-F8）', () => {
    const engine = MockPhysicalGeometryEngine.getInstance();
    engine.setViewport({ width: 800, height: 600 });
    engine.registerSelectorRect('[role="tooltip"]', { width: 200, height: 40 });

    render(
      <Tip content="边缘提示" side="top">
        <button type="button" data-mock-rect="700,100,100,30">
          边缘目标
        </button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('边缘目标'));
    const tip = screen.getByRole('tooltip');
    expect(tip.style.left).toBe('692px');
    expect(tip.style.top).toBe('92px');
  });

  it('滚动 capture 立刻灭，不跟随重定位', () => {
    const engine = MockPhysicalGeometryEngine.getInstance();
    engine.setViewport({ width: 800, height: 600 });
    engine.registerSelectorRect('[role="tooltip"]', { width: 120, height: 40 });

    render(
      <Tip content="跟随提示" side="top">
        <button type="button" data-mock-rect="100,100,50,30">
          跟随目标
        </button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('跟随目标'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('resize / 窗口 blur 立刻灭', () => {
    render(
      <Tip content="失焦提示">
        <button type="button">失焦目标</button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('失焦目标'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByText('失焦目标'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('目标离屏：不渲染，不钳回视口当残影', () => {
    const engine = MockPhysicalGeometryEngine.getInstance();
    engine.setViewport({ width: 800, height: 600 });
    engine.registerSelectorRect('[role="tooltip"]', { width: 120, height: 40 });

    render(
      <Tip content="离屏提示" side="top">
        <button type="button" data-mock-rect="100,800,50,30">
          离屏目标
        </button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('离屏目标'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('isTriggerOffscreen：无交集为离屏，相交则否', () => {
    const engine = MockPhysicalGeometryEngine.getInstance();
    engine.setViewport({ width: 800, height: 600 });
    expect(isTriggerOffscreen(new DOMRect(100, 800, 50, 30))).toBe(true);
    expect(isTriggerOffscreen(new DOMRect(-200, 100, 50, 30))).toBe(true);
    expect(isTriggerOffscreen(new DOMRect(100, 100, 50, 30))).toBe(false);
  });

  it('菜单已开（isTooltipSilenced）时 hover 不显示', () => {
    vi.spyOn(layerStackManager, 'isTooltipSilenced').mockReturnValue(true);
    render(
      <Tip content="不应出现">
        <button type="button">被静音</button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('被静音'));
    expect(layerStackManager.isTooltipSilenced).toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('菜单打开时立刻灭已显示的提示', async () => {
    render(
      <Tip content="将被灭">
        <button type="button">先亮目标</button>
      </Tip>
    );
    fireEvent.mouseEnter(screen.getByText('先亮目标'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => {
      document.documentElement.setAttribute('data-floating-active', 'true');
      document.body.setAttribute('data-floating-active', 'true');
    });
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  describe('四向智能碰撞翻折与零遮挡断言 (4-Way Collision Flip)', () => {
    function getRenderedTooltipRect(
      tip: HTMLElement,
      tipWidth: number,
      tipHeight: number
    ) {
      const left = parseFloat(tip.style.left);
      const top = parseFloat(tip.style.top);
      const translate = tip.style.getPropertyValue('--tooltip-translate');

      let boxLeft = left;
      let boxTop = top;

      if (translate.includes('translate(-50%, -100%)')) {
        boxLeft = left - tipWidth / 2;
        boxTop = top - tipHeight;
      } else if (translate.includes('translate(-50%, 0)')) {
        boxLeft = left - tipWidth / 2;
        boxTop = top;
      } else if (translate.includes('translate(-100%, -50%)')) {
        boxLeft = left - tipWidth;
        boxTop = top - tipHeight / 2;
      } else if (translate.includes('translate(0, -50%)')) {
        boxLeft = left;
        boxTop = top - tipHeight / 2;
      }

      return {
        left: boxLeft,
        top: boxTop,
        right: boxLeft + tipWidth,
        bottom: boxTop + tipHeight,
        width: tipWidth,
        height: tipHeight,
      };
    }

    function expectZeroOcclusion(
      triggerRect: { top: number; bottom: number; left: number; right: number },
      tooltipRect: { top: number; bottom: number; left: number; right: number },
      gap = 8
    ) {
      const isSeparatedVertically =
        tooltipRect.bottom <= triggerRect.top - gap ||
        tooltipRect.top >= triggerRect.bottom + gap;
      const isSeparatedHorizontally =
        tooltipRect.right <= triggerRect.left - gap ||
        tooltipRect.left >= triggerRect.right + gap;

      expect(isSeparatedVertically || isSeparatedHorizontally).toBe(true);
    }

    it('GEO-TIP-01: 顶栏按钮上方空间不足自动翻折为 bottom 且零遮挡', () => {
      const engine = MockPhysicalGeometryEngine.getInstance();
      engine.setViewport({ width: 800, height: 600 });
      engine.registerSelectorRect('[role="tooltip"]', {
        width: 60,
        height: 28,
      });

      render(
        <Tip content="展开侧栏" side="top">
          <button type="button" data-mock-rect="100,5,28,28">
            侧栏按钮
          </button>
        </Tip>
      );
      fireEvent.mouseEnter(screen.getByText('侧栏按钮'));
      const tip = screen.getByRole('tooltip');

      expect(tip).toHaveClass(styles.bottom);
      expect(tip.style.getPropertyValue('--tooltip-translate')).toBe(
        'translate(-50%, 0)'
      );
      expect(tip.style.top).toBe('41px');

      const triggerRect = { left: 100, top: 5, right: 128, bottom: 33 };
      const tipRect = getRenderedTooltipRect(tip, 60, 28);
      expectZeroOcclusion(triggerRect, tipRect);
    });

    it('GEO-TIP-02: 中部按钮空间充足时保持 side="top" 向上展开且零遮挡', () => {
      const engine = MockPhysicalGeometryEngine.getInstance();
      engine.setViewport({ width: 800, height: 600 });
      engine.registerSelectorRect('[role="tooltip"]', {
        width: 60,
        height: 28,
      });

      render(
        <Tip content="操作按钮" side="top">
          <button type="button" data-mock-rect="100,300,28,28">
            中部按钮
          </button>
        </Tip>
      );
      fireEvent.mouseEnter(screen.getByText('中部按钮'));
      const tip = screen.getByRole('tooltip');

      expect(tip).toHaveClass(styles.top);
      expect(tip.style.getPropertyValue('--tooltip-translate')).toBe(
        'translate(-50%, -100%)'
      );
      expect(tip.style.top).toBe('292px');

      const triggerRect = { left: 100, top: 300, right: 128, bottom: 328 };
      const tipRect = getRenderedTooltipRect(tip, 60, 28);
      expectZeroOcclusion(triggerRect, tipRect);
    });

    it('GEO-TIP-03: 底栏按钮下方空间不足自动翻折为 top 且零遮挡', () => {
      const engine = MockPhysicalGeometryEngine.getInstance();
      engine.setViewport({ width: 800, height: 600 });
      engine.registerSelectorRect('[role="tooltip"]', {
        width: 60,
        height: 28,
      });

      render(
        <Tip content="底部操作" side="bottom">
          <button type="button" data-mock-rect="100,570,28,28">
            底栏按钮
          </button>
        </Tip>
      );
      fireEvent.mouseEnter(screen.getByText('底栏按钮'));
      const tip = screen.getByRole('tooltip');

      expect(tip).toHaveClass(styles.top);
      expect(tip.style.getPropertyValue('--tooltip-translate')).toBe(
        'translate(-50%, -100%)'
      );
      expect(tip.style.top).toBe('562px');

      const triggerRect = { left: 100, top: 570, right: 128, bottom: 598 };
      const tipRect = getRenderedTooltipRect(tip, 60, 28);
      expectZeroOcclusion(triggerRect, tipRect);
    });

    it('GEO-TIP-04: 中部按钮空间充足时保持 side="bottom" 向下展开且零遮挡', () => {
      const engine = MockPhysicalGeometryEngine.getInstance();
      engine.setViewport({ width: 800, height: 600 });
      engine.registerSelectorRect('[role="tooltip"]', {
        width: 60,
        height: 28,
      });

      render(
        <Tip content="向下提示" side="bottom">
          <button type="button" data-mock-rect="100,200,28,28">
            中部下向按钮
          </button>
        </Tip>
      );
      fireEvent.mouseEnter(screen.getByText('中部下向按钮'));
      const tip = screen.getByRole('tooltip');

      expect(tip).toHaveClass(styles.bottom);
      expect(tip.style.getPropertyValue('--tooltip-translate')).toBe(
        'translate(-50%, 0)'
      );
      expect(tip.style.top).toBe('236px');

      const triggerRect = { left: 100, top: 200, right: 128, bottom: 228 };
      const tipRect = getRenderedTooltipRect(tip, 60, 28);
      expectZeroOcclusion(triggerRect, tipRect);
    });

    it('GEO-TIP-05: 左边缘按钮空间不足自动翻折为 right 且零遮挡', () => {
      const engine = MockPhysicalGeometryEngine.getInstance();
      engine.setViewport({ width: 800, height: 600 });
      engine.registerSelectorRect('[role="tooltip"]', {
        width: 60,
        height: 28,
      });

      render(
        <Tip content="左向提示" side="left">
          <button type="button" data-mock-rect="5,200,28,28">
            左缘按钮
          </button>
        </Tip>
      );
      fireEvent.mouseEnter(screen.getByText('左缘按钮'));
      const tip = screen.getByRole('tooltip');

      expect(tip).toHaveClass(styles.right);
      expect(tip.style.getPropertyValue('--tooltip-translate')).toBe(
        'translate(0, -50%)'
      );
      expect(tip.style.left).toBe('41px');

      const triggerRect = { left: 5, top: 200, right: 33, bottom: 228 };
      const tipRect = getRenderedTooltipRect(tip, 60, 28);
      expectZeroOcclusion(triggerRect, tipRect);
    });

    it('GEO-TIP-06: 右边缘按钮空间不足自动翻折为 left 且零遮挡', () => {
      const engine = MockPhysicalGeometryEngine.getInstance();
      engine.setViewport({ width: 800, height: 600 });
      engine.registerSelectorRect('[role="tooltip"]', {
        width: 60,
        height: 28,
      });

      render(
        <Tip content="右向提示" side="right">
          <button type="button" data-mock-rect="770,200,28,28">
            右缘按钮
          </button>
        </Tip>
      );
      fireEvent.mouseEnter(screen.getByText('右缘按钮'));
      const tip = screen.getByRole('tooltip');

      expect(tip).toHaveClass(styles.left);
      expect(tip.style.getPropertyValue('--tooltip-translate')).toBe(
        'translate(-100%, -50%)'
      );
      expect(tip.style.left).toBe('762px');

      const triggerRect = { left: 770, top: 200, right: 798, bottom: 228 };
      const tipRect = getRenderedTooltipRect(tip, 60, 28);
      expectZeroOcclusion(triggerRect, tipRect);
    });

    it('GEO-TIP-07: 顶栏右上角关闭按钮同时触发纵向翻折与横向右边缘钳位', () => {
      const engine = MockPhysicalGeometryEngine.getInstance();
      engine.setViewport({ width: 800, height: 600 });
      engine.registerSelectorRect('[role="tooltip"]', {
        width: 80,
        height: 28,
      });

      render(
        <Tip content="关闭窗口" side="top">
          <button type="button" data-mock-rect="770,5,25,25">
            关闭按钮
          </button>
        </Tip>
      );
      fireEvent.mouseEnter(screen.getByText('关闭按钮'));
      const tip = screen.getByRole('tooltip');

      expect(tip).toHaveClass(styles.bottom);
      expect(tip.style.top).toBe('38px');
      expect(tip.style.left).toBe('752px');

      const triggerRect = { left: 770, top: 5, right: 795, bottom: 30 };
      const tipRect = getRenderedTooltipRect(tip, 80, 28);
      expectZeroOcclusion(triggerRect, tipRect);
      expect(tipRect.right).toBeLessThanOrEqual(792);
      expect(tipRect.left).toBeGreaterThanOrEqual(8);
    });

    it('GEO-TIP-08: 翻折后 CSS 变量、类名与箭头方向 100% 同步', () => {
      const engine = MockPhysicalGeometryEngine.getInstance();
      engine.setViewport({ width: 400, height: 300 });
      engine.registerSelectorRect('[role="tooltip"]', {
        width: 60,
        height: 28,
      });

      render(
        <Tip content="同步校验" side="top">
          <button type="button" data-mock-rect="100,5,28,28">
            测试同步
          </button>
        </Tip>
      );
      fireEvent.mouseEnter(screen.getByText('测试同步'));
      const tip = screen.getByRole('tooltip');

      expect(tip.className).toContain(styles.bottom);
      expect(tip.style.getPropertyValue('--tooltip-translate')).toBe(
        'translate(-50%, 0)'
      );
    });
  });
});
