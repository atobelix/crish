// @vitest-environment jsdom
/**
 * PreviewCard 单元测试矩阵
 * 覆盖：双层贝塞尔小三角渲染、Safe-Aim 向量几何算法、视口碰撞翻折与边缘钳位、意图停留定时器、无障碍与生命周期
 */
/* eslint-disable max-lines-per-function, react/no-multi-comp */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from '@testing-library/react';
import {
  PreviewCard,
  PreviewCardTrigger,
  PreviewCardContent,
  PreviewCardTitle,
  PreviewCardDescription,
  PreviewCardArrow,
  computePreviewCardPosition,
  PREVIEW_CARD_EDGE_PAD,
} from './index';
import {
  crossProduct,
  isPointInTriangle,
  SafeTriangleTracker,
} from '../internal/SafeTriangle';
import { layerStackManager } from '../internal/layer-stack/LayerStackManager';

afterEach(() => {
  cleanup();
  layerStackManager.dispose();
  document.documentElement.removeAttribute('data-floating-active');
  document.body?.removeAttribute('data-floating-active');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PreviewCardArrow (双层贝塞尔平滑小三角)', () => {
  it('渲染具有 viewBox="0 0 26 18" 的双层 SVG 结构（边框描边层 + 底色填充层）', () => {
    const { container } = render(
      <PreviewCardArrow side="bottom" offset={0} />
    );

    const arrowContainer = container.querySelector('[data-slot="preview-card-arrow"]');
    expect(arrowContainer).toBeInTheDocument();
    expect(arrowContainer).toHaveAttribute('data-side', 'bottom');

    const svg = arrowContainer?.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('viewBox', '0 0 26 18');
    expect(svg).toHaveAttribute('width', '26');
    expect(svg).toHaveAttribute('height', '18');
    expect(svg).toHaveAttribute('aria-hidden', 'true');

    const paths = svg?.querySelectorAll('path');
    expect(paths).toHaveLength(2);

    // 第 1 条路径：描边层 (2px 圆角连续贝塞尔)
    const strokePath = paths?.[0];
    expect(strokePath).toHaveAttribute('stroke', 'currentColor');
    expect(strokePath).toHaveAttribute('stroke-width', '2');
    expect(strokePath).toHaveAttribute('stroke-linecap', 'round');
    expect(strokePath?.getAttribute('d')).toContain('M21 9');

    // 第 2 条路径：底色填充层 (深入卡片内壁 8.25px)
    const fillPath = paths?.[1];
    expect(fillPath).toHaveAttribute('fill', 'currentColor');
    expect(fillPath?.getAttribute('d')).toContain('M9.82943 4.57564');
  });

  it('四向方位定位与位移样式计算正确', () => {
    const { rerender, container } = render(
      <PreviewCardArrow side="bottom" offset={10} />
    );
    let arrowContainer = container.querySelector('[data-slot="preview-card-arrow"]') as HTMLElement;
    expect(arrowContainer.style.left).toBe('calc(50% - 3px)');

    rerender(<PreviewCardArrow side="top" offset={-5} />);
    arrowContainer = container.querySelector('[data-slot="preview-card-arrow"]') as HTMLElement;
    expect(arrowContainer.style.left).toBe('calc(50% - 18px)');

    rerender(<PreviewCardArrow side="left" offset={15} />);
    arrowContainer = container.querySelector('[data-slot="preview-card-arrow"]') as HTMLElement;
    expect(arrowContainer.style.top).toBe('calc(50% + 6px)');

    rerender(<PreviewCardArrow side="right" offset={0} />);
    arrowContainer = container.querySelector('[data-slot="preview-card-arrow"]') as HTMLElement;
    expect(arrowContainer.style.top).toBe('calc(50% - 9px)');
  });
});

describe('Safe-Aim 2D 向量几何与 SafeTriangleTracker', () => {
  it('crossProduct 2D 向量叉积符号面积判定', () => {
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 10, y: 0 };
    const p3 = { x: 0, y: 10 };

    // 逆时针旋向面积为正
    expect(crossProduct(p1, p2, p3)).toBe(100);
    // 顺时针旋向面积为负
    expect(crossProduct(p1, p3, p2)).toBe(-100);
    // 共线点面积为 0
    expect(crossProduct(p1, p2, { x: 20, y: 0 })).toBe(0);
  });

  it('isPointInTriangle 准确判定点在三角形内部、外部及边界', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const c = { x: 50, y: 80 };

    // 重心内部点
    expect(isPointInTriangle({ x: 50, y: 30 }, a, b, c)).toBe(true);
    // 顶点重合
    expect(isPointInTriangle({ x: 0, y: 0 }, a, b, c)).toBe(true);
    expect(isPointInTriangle({ x: 100, y: 0 }, a, b, c)).toBe(true);
    expect(isPointInTriangle({ x: 50, y: 80 }, a, b, c)).toBe(true);
    // 边缘上点
    expect(isPointInTriangle({ x: 50, y: 0 }, a, b, c)).toBe(true);
    // 外部点
    expect(isPointInTriangle({ x: 50, y: -10 }, a, b, c)).toBe(false);
    expect(isPointInTriangle({ x: 120, y: 50 }, a, b, c)).toBe(false);
    expect(isPointInTriangle({ x: -10, y: 50 }, a, b, c)).toBe(false);
  });

  it('SafeTriangleTracker 管理进入、持续追踪与重置状态机', () => {
    const tracker = new SafeTriangleTracker(300);
    expect(tracker.isGraceActive()).toBe(false);

    // 模拟光标从 Trigger (50, 20) 指向卡片下方包围盒 (0, 40) - (200, 160)
    tracker.enter(
      { x: 50, y: 20 },
      { left: 0, top: 40, right: 200, bottom: 160 },
      'bottom'
    );
    expect(tracker.isGraceActive()).toBe(true);

    // 安全锥区内部点检测
    expect(tracker.check({ x: 60, y: 35 })).toBe(true);
    expect(tracker.isGraceActive()).toBe(true);

    // 光标成功触达目标包围盒
    tracker.reach();
    expect(tracker.isGraceActive()).toBe(false);
  });

  it('SafeTriangleTracker 在光标离开安全区时自动重置', () => {
    const tracker = new SafeTriangleTracker(300);
    tracker.enter(
      { x: 50, y: 20 },
      { left: 0, top: 40, right: 200, bottom: 160 },
      'bottom'
    );
    expect(tracker.isGraceActive()).toBe(true);

    // 移出锥区 (向左远方滑出)
    const inRange = tracker.check({ x: -50, y: 30 });
    expect(inRange).toBe(false);
    expect(tracker.isGraceActive()).toBe(false);
  });
});

describe('computePreviewCardPosition (视口碰撞翻折与边缘钳位)', () => {
  const mockTriggerRect = (top: number, left: number, width = 80, height = 32): DOMRect =>
    ({
      top,
      left,
      bottom: top + height,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => {},
    } as DOMRect);

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
  });

  it('空间充足时保持默认 bottom 方位', () => {
    const trigger = mockTriggerRect(100, 300);
    const result = computePreviewCardPosition('bottom', 'center', 10, 0, trigger, 300, 150);

    expect(result.effectiveSide).toBe('bottom');
    expect(result.top).toBe(100 + 32 + 10); // rect.bottom + sideOffset = 142
    // left: 300 + (80 - 300)/2 = 190
    expect(result.left).toBe(190);
  });

  it('下方空间不足时自动翻折至 top', () => {
    // 触发器靠近视口底部 (top: 720, height: 32 -> bottom: 752)
    // 视口高 800，下方剩余 800 - 12 - 752 = 36 < 150 + 10
    const trigger = mockTriggerRect(720, 300);
    const result = computePreviewCardPosition('bottom', 'center', 10, 0, trigger, 300, 150);

    expect(result.effectiveSide).toBe('top');
    expect(result.top).toBe(720 - 10 - 150); // rect.top - sideOffset - cardHeight = 560
  });

  it('上方空间不足时自动翻折至 bottom', () => {
    // 触发器靠近视口顶部 (top: 20)
    const trigger = mockTriggerRect(20, 300);
    const result = computePreviewCardPosition('top', 'center', 10, 0, trigger, 300, 150);

    expect(result.effectiveSide).toBe('bottom');
    expect(result.top).toBe(20 + 32 + 10); // 62
  });

  it('右侧空间不足时自动翻折至 left', () => {
    // 触发器靠近视口右侧 (left: 850, width: 80 -> right: 930)
    // 视口宽 1000，右侧剩余 1000 - 12 - 930 = 58 < 300 + 10
    const trigger = mockTriggerRect(300, 850);
    const result = computePreviewCardPosition('right', 'center', 10, 0, trigger, 300, 150);

    expect(result.effectiveSide).toBe('left');
    expect(result.left).toBe(850 - 10 - 300); // 540
  });

  it('左侧空间不足时自动翻折至 right', () => {
    const trigger = mockTriggerRect(300, 20);
    const result = computePreviewCardPosition('left', 'center', 10, 0, trigger, 300, 150);

    expect(result.effectiveSide).toBe('right');
    expect(result.left).toBe(20 + 80 + 10); // 110
  });

  it('超出视口横向边缘时进行安全钳位 (Clamping)', () => {
    // 触发器靠非常左 (left: 0)，居中对齐会产生负坐标
    const trigger = mockTriggerRect(200, 0);
    const result = computePreviewCardPosition('bottom', 'center', 10, 0, trigger, 300, 150);

    // 应该钳位至 PREVIEW_CARD_EDGE_PAD (12)
    expect(result.left).toBe(PREVIEW_CARD_EDGE_PAD);
    // 偏置小三角追踪 trigger 中心 (0 + 40 = 40) 与卡片中心 (12 + 150 = 162) 之差
    expect(result.arrowOffset).toBeLessThan(0);
  });

  it('对齐方式支持 start / end / center 与 alignOffset', () => {
    const trigger = mockTriggerRect(200, 400, 100, 30);
    const startResult = computePreviewCardPosition('bottom', 'start', 10, 5, trigger, 200, 100);
    expect(startResult.left).toBe(400 + 5);

    const endResult = computePreviewCardPosition('bottom', 'end', 10, -5, trigger, 200, 100);
    expect(endResult.left).toBe(400 + 100 - 200 - 5); // 295
  });
});

describe('PreviewCard 交互与意图停留定时器', () => {
  it('未满 delayShow (300ms) 移出光标，卡片绝不挂载到 DOM', () => {
    vi.useFakeTimers();
    render(
      <PreviewCard delayShow={300}>
        <PreviewCardTrigger>
          <button type="button">悬停测试按钮</button>
        </PreviewCardTrigger>
        <PreviewCardContent>
          <PreviewCardTitle>卡片标题</PreviewCardTitle>
          <PreviewCardDescription>卡片描述内容</PreviewCardDescription>
        </PreviewCardContent>
      </PreviewCard>
    );

    const triggerBtn = screen.getByText('悬停测试按钮');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // 移入
    fireEvent.mouseEnter(triggerBtn);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // 停留 200ms (< 300ms)
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // 移出
    fireEvent.mouseLeave(triggerBtn);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('停留满 delayShow 后成功渲染 Portal，并带有完整 ARIA 属性', () => {
    vi.useFakeTimers();
    render(
      <PreviewCard delayShow={300}>
        <PreviewCardTrigger>
          <button type="button">触发器</button>
        </PreviewCardTrigger>
        <PreviewCardContent>
          <PreviewCardTitle>富媒体标题</PreviewCardTitle>
          <PreviewCardDescription>富媒体描述</PreviewCardDescription>
        </PreviewCardContent>
      </PreviewCard>
    );

    const triggerBtn = screen.getByText('触发器');
    fireEvent.mouseEnter(triggerBtn);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('富媒体标题');
    expect(dialog).toHaveTextContent('富媒体描述');

    // ARIA 契约校验
    expect(triggerBtn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(triggerBtn).toHaveAttribute('aria-expanded', 'true');
    expect(triggerBtn.getAttribute('aria-controls')).toBe(dialog.id);
  });

  it('受控模式 (open={true} / onOpenChange) 正确响应', () => {
    const handleOpenChange = vi.fn();
    const { rerender } = render(
      <PreviewCard open={false} onOpenChange={handleOpenChange} delayShow={0}>
        <PreviewCardTrigger>
          <button type="button">受控按钮</button>
        </PreviewCardTrigger>
        <PreviewCardContent>
          <div>受控卡片内容</div>
        </PreviewCardContent>
      </PreviewCard>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <PreviewCard open={true} onOpenChange={handleOpenChange} delayShow={0}>
        <PreviewCardTrigger>
          <button type="button">受控按钮</button>
        </PreviewCardTrigger>
        <PreviewCardContent>
          <div>受控卡片内容</div>
        </PreviewCardContent>
      </PreviewCard>
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('受控卡片内容')).toBeInTheDocument();
  });

  it('光标从卡片移出并在 delayHide + exitDuration 之后完成销毁', () => {
    vi.useFakeTimers();
    render(
      <PreviewCard delayShow={0} delayHide={150}>
        <PreviewCardTrigger>
          <button type="button">触发按钮</button>
        </PreviewCardTrigger>
        <PreviewCardContent>
          <div>内部内容</div>
        </PreviewCardContent>
      </PreviewCard>
    );

    const triggerBtn = screen.getByText('触发按钮');
    fireEvent.mouseEnter(triggerBtn);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // 划入卡片内部
    fireEvent.mouseEnter(dialog);
    // 从卡片内部离开
    fireEvent.mouseLeave(dialog);

    // 经过 delayHide (150ms)
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // 进入 exit 动画过渡阶段 (100ms exitDurationMs)
    act(() => {
      vi.advanceTimersByTime(110);
    });
    // 最终卸载
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disabled 状态下悬停不触发打开', () => {
    vi.useFakeTimers();
    render(
      <PreviewCard disabled delayShow={0}>
        <PreviewCardTrigger>
          <button type="button">禁用触发器</button>
        </PreviewCardTrigger>
        <PreviewCardContent>
          <div>禁用提示内容</div>
        </PreviewCardContent>
      </PreviewCard>
    );

    const triggerBtn = screen.getByText('禁用触发器');
    fireEvent.mouseEnter(triggerBtn);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Focus / Blur 键盘无障碍焦点联动', () => {
    vi.useFakeTimers();
    render(
      <PreviewCard delayShow={0} delayHide={100}>
        <PreviewCardTrigger>
          <button type="button">焦点按钮</button>
        </PreviewCardTrigger>
        <PreviewCardContent>
          <div>焦点卡片内容</div>
        </PreviewCardContent>
      </PreviewCard>
    );

    const triggerBtn = screen.getByText('焦点按钮');
    fireEvent.focus(triggerBtn);

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.blur(triggerBtn);
    // 经过 delayHide (100ms)
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // 经过 exitDuration (100ms)
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('按下 Escape 键通过 LayerStackManager 关闭浮层', () => {
    vi.useFakeTimers();
    render(
      <PreviewCard delayShow={0}>
        <PreviewCardTrigger>
          <button type="button">Esc 触发器</button>
        </PreviewCardTrigger>
        <PreviewCardContent>
          <div>Esc 提示内容</div>
        </PreviewCardContent>
      </PreviewCard>
    );

    const triggerBtn = screen.getByText('Esc 触发器');
    fireEvent.mouseEnter(triggerBtn);

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // 触发全局 Esc 按键
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // 经过 exit 动画时长 (100ms)
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
