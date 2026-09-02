// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import type { AppToast } from '../../../services/toast/types';
import { ToastCard } from '../ToastCard';
import { ToastViewport } from '../ToastViewport';
import { useToastStackMeasurement } from '../useToastStackMeasurement';
import { useSwipeDismiss } from '../useSwipeDismiss';
import { ToastStore } from '../../../services/toast/ToastStore';

const mockToast = (partial: Partial<AppToast> & Pick<AppToast, 'id' | 'message'>): AppToast => ({
  type: 'info',
  duration: 3000,
  ariaLive: 'polite',
  timestamp: Date.now(),
  updateKey: Date.now(),
  ...partial,
});

describe('ToastCard & ToastViewport 现代化 3D 层叠通知套件测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ToastStore.clear();
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    ToastStore.clear();
    vi.restoreAllMocks();
  });

  it('ToastCard 完整渲染标题、正文、描述、图标与发丝关闭按钮', () => {
    const onDismiss = vi.fn();
    const toast = mockToast({
      id: 't-1',
      type: 'success',
      title: '任务完成',
      message: '所有工程文件索引已更新',
      description: '耗时 120ms',
    });

    render(
      <ToastCard
        toast={toast}
        index={0}
        frontmostHeight={60}
        offsetY={0}
        isExpanded={false}
        onHeightMeasure={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByText('任务完成')).toBeInTheDocument();
    expect(screen.getByText('所有工程文件索引已更新')).toBeInTheDocument();
    expect(screen.getByText('耗时 120ms')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-toast-type', 'success');
    expect(screen.getByRole('button', { name: '关闭通知' })).toBeInTheDocument();
  });

  it('ToastCard 注入正确的 3D 几何 CSS 自定义变量', () => {
    const toast = mockToast({ id: 't-2', message: '卡片 2' });
    const { container } = render(
      <ToastCard
        toast={toast}
        index={2}
        frontmostHeight={56}
        offsetY={136}
        isExpanded={false}
        onHeightMeasure={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const card = container.querySelector('[role="status"]') as HTMLElement;
    expect(card.style.getPropertyValue('--toast-index')).toBe('2');
    expect(card.style.getPropertyValue('--toast-frontmost-height')).toBe('56px');
    expect(card.style.getPropertyValue('--toast-offset-y')).toBe('136px');
  });

  it('点击「撤销」按钮触发 onUndo 回调并在动画后调用 onDismiss', () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    const toast = mockToast({
      id: 't-undo',
      message: '已归档: 历史记录',
      onUndo,
    });

    render(
      <ToastCard
        toast={toast}
        index={0}
        frontmostHeight={56}
        offsetY={0}
        isExpanded={false}
        onHeightMeasure={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    const undoBtn = screen.getByRole('button', { name: '撤销' });
    act(() => {
      fireEvent.click(undoBtn);
    });

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('点击自定义 Action 按钮触发其 onClick 回调', () => {
    const onActionClick = vi.fn();
    const toast = mockToast({
      id: 't-action',
      message: '新版本就绪',
      action: {
        label: '立即重启',
        onClick: onActionClick,
        variant: 'primary',
      },
    });

    render(
      <ToastCard
        toast={toast}
        index={0}
        frontmostHeight={56}
        offsetY={0}
        isExpanded={false}
        onHeightMeasure={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const actionBtn = screen.getByRole('button', { name: '立即重启' });
    act(() => {
      fireEvent.click(actionBtn);
    });

    expect(onActionClick).toHaveBeenCalledTimes(1);
  });

  it('自动倒计时：在 duration 结束后自动退出并调用 onDismiss', () => {
    const onDismiss = vi.fn();
    const toast = mockToast({
      id: 't-timer',
      message: '定时消失通知',
      duration: 3000,
    });

    render(
      <ToastCard
        toast={toast}
        index={0}
        frontmostHeight={56}
        offsetY={0}
        isExpanded={false}
        onHeightMeasure={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    act(() => {
      vi.advanceTimersByTime(2900);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(400); // 3000ms 到期 + 260ms 退场动画
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('悬停展开时时钟智能冻结，鼠标移出后恢复倒计时', () => {
    const onDismiss = vi.fn();
    const toast = mockToast({
      id: 't-hover-timer',
      message: '长文本通知需悬停阅读',
      duration: 2000,
    });

    let rendered: any;
    act(() => {
      rendered = render(
        <ToastCard
          toast={toast}
          index={0}
          frontmostHeight={56}
          offsetY={0}
          isExpanded={false}
          onHeightMeasure={vi.fn()}
          onDismiss={onDismiss}
        />
      );
    });

    // 运行 1000ms
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    // 悬停展开 (isExpanded = true)
    act(() => {
      rendered.rerender(
        <ToastCard
          toast={toast}
          index={0}
          frontmostHeight={56}
          offsetY={0}
          isExpanded={true}
          onHeightMeasure={vi.fn()}
          onDismiss={onDismiss}
        />
      );
    });

    // 悬停期间过去 5000ms，不应消失
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    // 移出恢复折叠 (isExpanded = false)
    act(() => {
      rendered.rerender(
        <ToastCard
          toast={toast}
          index={0}
          frontmostHeight={56}
          offsetY={0}
          isExpanded={false}
          onHeightMeasure={vi.fn()}
          onDismiss={onDismiss}
        />
      );
    });

    // 剩余 ~1000ms 到期 + 动画延迟
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ToastViewport 悬停激活 data-expanded 状态广播', async () => {
    act(() => {
      ToastStore.error('错误通知 1');
      ToastStore.warning('警告通知 2');
    });

    let container: HTMLElement;
    await act(async () => {
      const res = render(<ToastViewport position="bottom-right" />);
      container = res.container;
    });

    const viewport = container!.querySelector('section[role="region"]');
    expect(viewport).toBeInTheDocument();
    expect(viewport).toHaveAttribute('data-expanded', 'false');

    // 鼠标移入
    act(() => {
      fireEvent.mouseEnter(viewport!);
    });
    expect(viewport).toHaveAttribute('data-expanded', 'true');

    // 鼠标移出
    act(() => {
      fireEvent.mouseLeave(viewport!);
    });
    expect(viewport).toHaveAttribute('data-expanded', 'false');
  });

  it('useToastStackMeasurement 正确计算累加偏移公式: sum(H_k) + i*gap', async () => {
    const list: AppToast[] = [
      mockToast({ id: 'a', message: '卡片 A' }),
      mockToast({ id: 'b', message: '卡片 B' }),
      mockToast({ id: 'c', message: '卡片 C' }),
    ];

    const { result } = renderHook(() => useToastStackMeasurement(list, true));

    // 模拟注册节点高度
    await act(async () => {
      const elA = document.createElement('div');
      Object.defineProperty(elA, 'offsetHeight', { value: 60 });
      result.current.registerNode('a', elA);

      const elB = document.createElement('div');
      Object.defineProperty(elB, 'offsetHeight', { value: 80 });
      result.current.registerNode('b', elB);

      const elC = document.createElement('div');
      Object.defineProperty(elC, 'offsetHeight', { value: 50 });
      result.current.registerNode('c', elC);
    });

    // i=0: 0
    expect(result.current.getOffsetY(0, 12)).toBe(0);
    // i=1: 60 + 12 = 72
    expect(result.current.getOffsetY(1, 12)).toBe(72);
    // i=2: 60 + 80 + 2*12 = 164
    expect(result.current.getOffsetY(2, 12)).toBe(164);
  });

  it('useSwipeDismiss 手势滑离超过阈值触发 onDismiss', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() =>
      useSwipeDismiss({ onDismiss, allowedAxes: ['down', 'right'], threshold: 60 })
    );

    const mockTarget = document.createElement('div');

    act(() => {
      result.current.onPointerDown({
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        currentTarget: mockTarget,
        target: mockTarget,
      } as any);
    });
    expect(result.current.swiping).toBe(true);

    act(() => {
      result.current.onPointerMove({
        clientX: 180, // deltaX = 80 > threshold 60
        clientY: 100,
      } as any);
    });
    expect(result.current.movement.x).toBe(80);

    act(() => {
      result.current.onPointerUp({
        currentTarget: mockTarget,
      } as any);
    });

    expect(result.current.swiping).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('useSwipeDismiss 未达到阈值释放时弹性归零复位', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() =>
      useSwipeDismiss({ onDismiss, allowedAxes: ['down', 'right'], threshold: 60 })
    );

    const mockTarget = document.createElement('div');

    act(() => {
      result.current.onPointerDown({
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        currentTarget: mockTarget,
        target: mockTarget,
      } as any);
    });

    act(() => {
      result.current.onPointerMove({
        clientX: 115, // deltaX = 15 < 25 (minFlingDistance) and < 60 (threshold)
        clientY: 100,
      } as any);
    });
    expect(result.current.movement.x).toBe(15);

    act(() => {
      result.current.onPointerUp({
        currentTarget: mockTarget,
      } as any);
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.movement.x).toBe(0);
    expect(result.current.movement.y).toBe(0);
  });
});
