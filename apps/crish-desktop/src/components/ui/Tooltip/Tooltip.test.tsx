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
});
