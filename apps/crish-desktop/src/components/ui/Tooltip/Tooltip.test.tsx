// @vitest-environment jsdom
/**
 * ui/Tooltip 测试：hover 展示、disabled 短路、ref 透传（历史修复回归）
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from '@testing-library/react';
import { Tooltip } from './Tooltip';
import styles from './Tooltip.module.css';
import { MockPhysicalGeometryEngine } from '../../../test-utils/MockPhysicalGeometryEngine';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ui/Tooltip', () => {
  it('hover 触发器时经 portal 渲染 tooltip 角色', async () => {
    render(
      <Tooltip content="提示内容">
        <button type="button">悬停目标</button>
      </Tooltip>
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText('悬停目标'));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('提示内容');
    expect(tip.parentElement).toBe(document.body);
  });

  it('mouseLeave 后隐藏（含 delayHide 延迟）', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="延迟提示" delayHide={300}>
        <button type="button">延迟目标</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('延迟目标'));
    // 推进到进入动画完成（双 rAF + 展示态），act 包裹保证更新冲刷
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByText('延迟目标'));
    // 延迟未到：仍可见
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    // 延迟到点 → 进入退出动画
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    // 退出动画 120ms 后卸载
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('disabled 或空 content 时不渲染任何包裹行为', () => {
    const { rerender } = render(
      <Tooltip content="禁用提示" disabled>
        <button type="button">禁用目标</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('禁用目标'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    rerender(
      <Tooltip content="">
        <button type="button">空内容目标</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('空内容目标'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('ref 透传：子元素 ref 与 forwardRef 合并（历史修复回归）', () => {
    const btnRef = { current: null as HTMLButtonElement | null };
    function Harness() {
      return (
        <Tooltip
          content="ref 提示"
          ref={btnRef as React.RefObject<HTMLButtonElement>}
        >
          <button type="button">ref 目标</button>
        </Tooltip>
      );
    }
    render(<Harness />);
    // 合并后的 ref 应指向真实 DOM 按钮（子元素自身无 ref 时由 forwardRef 接管）
    expect(btnRef.current).toBe(screen.getByText('ref 目标'));
  });

  it('子元素自身 onClick 与外部注入事件均不被截断（历史修复回归）', async () => {
    const childOnClick = vi.fn();
    render(
      <Tooltip content="事件提示">
        <button type="button" onClick={childOnClick}>
          事件目标
        </button>
      </Tooltip>
    );
    fireEvent.click(screen.getByText('事件目标'));
    expect(childOnClick).toHaveBeenCalledTimes(1);
    // 注入的事件仍可触发（经由透传的 onMouseEnter）
    fireEvent.mouseEnter(screen.getByText('事件目标'));
    await screen.findByRole('tooltip');
  });

  it('side 定位类切换（CSS Modules 哈希类）', () => {
    const { rerender } = render(
      <Tooltip content="下侧" side="bottom">
        <button type="button">下侧目标</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('下侧目标'));
    expect(screen.getByRole('tooltip')).toHaveClass(styles.bottom);
    rerender(
      <Tooltip content="右侧" side="right">
        <button type="button">右侧目标</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('右侧目标'));
    expect(screen.getByRole('tooltip')).toHaveClass(styles.right);
  });

  it('键盘 focus/blur 触发与隐藏提示（F7-F8）', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="键盘提示">
        <button type="button">焦点目标</button>
      </Tooltip>
    );
    fireEvent.focus(screen.getByText('焦点目标'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.blur(screen.getByText('焦点目标'));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('提示经 aria-describedby 关联触发元素（F7-F8）', () => {
    render(
      <Tooltip content="关联描述">
        <button type="button">关联目标</button>
      </Tooltip>
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
      <Tooltip content="边缘提示" side="top">
        <button type="button" data-mock-rect="700,100,100,30">
          边缘目标
        </button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('边缘目标'));
    const tip = screen.getByRole('tooltip');
    // top 定位：left = rect.center - tipW/2 = 750 - 100 = 650，
    // 右缘 650 + 200 = 850 > 800 → 钳回 800 - 8，left 应为 692
    expect(tip.style.left).toBe('692px');
    expect(tip.style.top).toBe('92px');
  });

  it('滚动/视口变化后提示跟随目标重定位（F7-F8）', () => {
    const engine = MockPhysicalGeometryEngine.getInstance();
    engine.setViewport({ width: 800, height: 600 });
    engine.registerSelectorRect('[role="tooltip"]', { width: 120, height: 40 });

    render(
      <Tooltip content="跟随提示" side="top">
        <button type="button" data-mock-rect="100,100,50,30">
          跟随目标
        </button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('跟随目标'));
    const tip = screen.getByRole('tooltip');
    const before = tip.style.left;

    // 滚动后目标位移：重定位应以新 rect 计算
    const btn = screen.getByText('跟随目标');
    btn.setAttribute('data-mock-rect', '300,400,50,30');
    fireEvent.scroll(window);

    expect(tip.style.left).not.toBe(before);
    // 新 base left = 300 + 25 = 325（translate(-50%,-100%) 由 CSS 施加，
    // 盒实际落于 325 - 60 = 265）；提示盒须完整留在视口内
    expect(tip.style.left).toBe('325px');
    const boxLeft = 325 - 120 / 2;
    expect(boxLeft).toBeGreaterThanOrEqual(8);
    expect(boxLeft + 120).toBeLessThanOrEqual(800 - 8);
  });

  it('className 安全合并：保留子元素原类名与外部注入类名（如 no-drag）', () => {
    render(
      <Tooltip content="类名提示" className="no-drag">
        <button type="button" className="permPill">
          按钮
        </button>
      </Tooltip>
    );
    const btn = screen.getByText('按钮');
    expect(btn).toHaveClass('permPill');
    expect(btn).toHaveClass('no-drag');
  });

  it('style 安全合并：合并子元素 style 与外部 style', () => {
    render(
      <Tooltip content="样式提示" style={{ marginTop: '10px' }}>
        <button type="button" style={{ color: 'red' }}>
          样式按钮
        </button>
      </Tooltip>
    );
    const btn = screen.getByText('样式按钮');
    expect(btn.style.color).toBe('red');
    expect(btn.style.marginTop).toBe('10px');
  });

  it('事件全量安全合并：子元素原 handler 与外部注入 handler 依次执行', () => {
    const childClick = vi.fn();
    const restClick = vi.fn();
    const childPointerDown = vi.fn();
    const restPointerDown = vi.fn();

    render(
      <Tooltip
        content="事件合并"
        onClick={restClick}
        onPointerDown={restPointerDown}
      >
        <button
          type="button"
          onClick={childClick}
          onPointerDown={childPointerDown}
        >
          复合事件按钮
        </button>
      </Tooltip>
    );
    const btn = screen.getByText('复合事件按钮');
    fireEvent.pointerDown(btn);
    expect(childPointerDown).toHaveBeenCalledTimes(1);
    expect(restPointerDown).toHaveBeenCalledTimes(1);

    fireEvent.click(btn);
    expect(childClick).toHaveBeenCalledTimes(1);
    expect(restClick).toHaveBeenCalledTimes(1);
  });

  it('disabled 状态下仍透传 ref、合并 className/style 与事件处理器', () => {
    const btnRef = { current: null as HTMLButtonElement | null };
    const childClick = vi.fn();
    const restClick = vi.fn();

    render(
      <Tooltip
        content="禁用提示"
        disabled
        ref={btnRef as React.RefObject<HTMLButtonElement>}
        className="no-drag"
        style={{ opacity: '0.5' }}
        onClick={restClick}
      >
        <button
          type="button"
          className="originalClass"
          style={{ color: 'blue' }}
          onClick={childClick}
        >
          禁用提示按钮
        </button>
      </Tooltip>
    );

    const btn = screen.getByText('禁用提示按钮');
    expect(btnRef.current).toBe(btn);
    expect(btn).toHaveClass('originalClass');
    expect(btn).toHaveClass('no-drag');
    expect(btn.style.color).toBe('blue');
    expect(btn.style.opacity).toBe('0.5');

    fireEvent.click(btn);
    expect(childClick).toHaveBeenCalledTimes(1);
    expect(restClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('浮点坐标 DOMRect 精度与 visualViewport 优先支持 (WO-08)', () => {
    const engine = MockPhysicalGeometryEngine.getInstance();
    engine.setViewport({ width: 1024.5, height: 768.5 });
    engine.registerSelectorRect('[role="tooltip"]', { width: 150, height: 36 });

    render(
      <Tooltip content="高精浮点提示" side="top">
        <button type="button" data-mock-rect="500.75,200.25,100.0,40.0">
          浮点目标
        </button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('浮点目标'));
    const tip = screen.getByRole('tooltip');
    // base left = 500.75 + 50 = 550.75px, base top = 200.25 - 8 = 192.25px
    expect(tip.style.left).toBe('550.75px');
    expect(tip.style.top).toBe('192.25px');
  });

  it('下侧/左侧/右侧的浮点坐标计算精确性 (WO-08)', () => {
    const engine = MockPhysicalGeometryEngine.getInstance();
    engine.registerSelectorRect('[role="tooltip"]', { width: 120, height: 30 });

    const { rerender } = render(
      <Tooltip content="下侧浮点" side="bottom">
        <button type="button" data-mock-rect="200.5,100.5,100,50">
          浮点目标
        </button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('浮点目标'));
    let tip = screen.getByRole('tooltip');
    // bottom: base left = 200.5 + 50 = 250.5, base top = 150.5 + 8 = 158.5
    expect(tip.style.left).toBe('250.5px');
    expect(tip.style.top).toBe('158.5px');

    rerender(
      <Tooltip content="左侧浮点" side="left">
        <button type="button" data-mock-rect="200.5,100.5,100,50">
          浮点目标
        </button>
      </Tooltip>
    );
    tip = screen.getByRole('tooltip');
    // left: base left = 200.5 - 8 = 192.5, base top = 100.5 + 25 = 125.5
    expect(tip.style.left).toBe('192.5px');
    expect(tip.style.top).toBe('125.5px');

    rerender(
      <Tooltip content="右侧浮点" side="right">
        <button type="button" data-mock-rect="200.5,100.5,100,50">
          浮点目标
        </button>
      </Tooltip>
    );
    tip = screen.getByRole('tooltip');
    // right: base left = 300.5 + 8 = 308.5, base top = 100.5 + 25 = 125.5
    expect(tip.style.left).toBe('308.5px');
    expect(tip.style.top).toBe('125.5px');
  });
});
