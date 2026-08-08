// @vitest-environment jsdom
/**
 * ui/Tooltip 测试：hover 展示、disabled 短路、ref 透传（历史修复回归）
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { Tooltip } from './Tooltip';
import styles from './Tooltip.module.css';

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
        <Tooltip content="ref 提示" ref={btnRef as React.RefObject<HTMLButtonElement>}>
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
        <button type="button" onClick={childOnClick}>事件目标</button>
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
    expect(screen.getByText('关联目标')).toHaveAttribute('aria-describedby', tipId);
  });

  it('视口右缘钳位：提示不溢出视口（F7-F8）', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40);
    const childRect = {
      top: 100,
      left: 700,
      right: 800,
      bottom: 130,
      width: 100,
      height: 30,
      x: 700,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      childRect
    );
    render(
      <Tooltip content="边缘提示" side="top">
        <button type="button">边缘目标</button>
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
    let rect = { left: 100, top: 100, width: 50, height: 30 } as DOMRect;
    const rectMock = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(() => rect);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40);
    render(
      <Tooltip content="跟随提示" side="top">
        <button type="button">跟随目标</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('跟随目标'));
    const tip = screen.getByRole('tooltip');
    const before = tip.style.left;
    // 滚动后目标位移：重定位应以新 rect 计算
    rect = {
      left: 300,
      top: 400,
      width: 50,
      height: 30,
      right: 350,
      bottom: 430,
      x: 300,
      y: 400,
      toJSON: () => ({}),
    } as DOMRect;
    fireEvent.scroll(window);
    expect(rectMock).toHaveBeenCalled();
    expect(tip.style.left).not.toBe(before);
    // 新 base left = 300 + 25 = 325（translate(-50%,-100%) 由 CSS 施加，
    // 盒实际落于 325 - 60 = 265）；提示盒须完整留在视口内
    expect(tip.style.left).toBe('325px');
    const boxLeft = 325 - 120 / 2;
    expect(boxLeft).toBeGreaterThanOrEqual(8);
    expect(boxLeft + 120).toBeLessThanOrEqual(800 - 8);
  });
});
