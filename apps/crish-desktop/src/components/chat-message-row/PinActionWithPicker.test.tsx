/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { PinActionWithPicker } from './PinActionWithPicker';

describe('PinActionWithPicker', () => {
  it('未固定态渲染固定按钮，点击调用 onTogglePin 带默认色', () => {
    const onTogglePin = vi.fn();
    render(
      <PinActionWithPicker
        isPinned={false}
        onTogglePin={onTogglePin}
      />
    );

    const btn = screen.getByRole('button', { name: '固定消息' });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onTogglePin).toHaveBeenCalledWith('#10b981');
  });

  it('已固定态渲染解除固定按钮，点击调用 onTogglePin 解除', () => {
    const onTogglePin = vi.fn();
    render(
      <PinActionWithPicker
        isPinned={true}
        pinnedColor="#10b981"
        onTogglePin={onTogglePin}
      />
    );

    const btn = screen.getByRole('button', { name: '解除固定' });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onTogglePin).toHaveBeenCalledWith();
  });

  it('Hover 呼出弹层展示现代化色盘并支持点击预设颜色设色', () => {
    vi.useFakeTimers();
    const onTogglePin = vi.fn();
    const { container } = render(
      <PinActionWithPicker
        isPinned={false}
        onTogglePin={onTogglePin}
      />
    );

    const wrapper = container.firstChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const popover = screen.getByRole('toolbar', { name: '固定管理与颜色选择' });
    expect(popover).toBeInTheDocument();

    const greenDot = within(popover).getByRole('button', { name: '翡翠绿' });
    expect(greenDot).toBeInTheDocument();
    fireEvent.click(greenDot);
    expect(onTogglePin).toHaveBeenCalledWith('#10b981');

    vi.useRealTimers();
  });

  it('点击自定义颜色在矩形选择器上方保留预设颜色行，无需返回按钮，支持直接选色与重置', () => {
    vi.useFakeTimers();
    const onTogglePin = vi.fn();
    const { container } = render(
      <PinActionWithPicker
        isPinned={true}
        pinnedColor="#0ea5e9"
        onTogglePin={onTogglePin}
      />
    );

    const wrapper = container.firstChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // 默认展示预设色盘
    expect(screen.getByRole('button', { name: '翡翠绿' })).toBeInTheDocument();

    const customBtn = screen.getByRole('button', { name: '自定义固定颜色' });
    expect(customBtn).toBeInTheDocument();
    fireEvent.click(customBtn);

    // 展开自定义面板后：预设颜色依然保留在矩形选择器上方，免去返回操作
    expect(screen.getByRole('button', { name: '翡翠绿' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回预设颜色' })).toBeNull();

    // 渲染 2D 矩形饱和度/明度拾色选区
    const palette = screen.getByRole('slider', { name: '饱和度与明度选区' });
    expect(palette).toBeInTheDocument();

    // 渲染色相滑块
    const slider = screen.getByRole('slider', { name: '色相微调滑块' });
    expect(slider).toBeInTheDocument();

    // 渲染底行可编辑色值输入框（无多余应用按钮）
    const hexInput = screen.getByRole('textbox', { name: '十六进制色值' }) as HTMLInputElement;
    expect(hexInput).toBeInTheDocument();
    expect(hexInput.value).toBe('#0EA5E9');
    expect(screen.queryByRole('button', { name: '应用颜色' })).toBeNull();

    // 在自定义面板中直接点击预设颜色即可直接设色，无须返回
    const coralDot = screen.getByRole('button', { name: '珊瑚红' });
    fireEvent.click(coralDot);
    expect(onTogglePin).toHaveBeenCalledWith('#f43f5e');

    // 重置按钮：点击瞬间恢复为默认主题绿 #10b981
    const resetBtn = screen.getByRole('button', { name: '重置为默认绿色' });
    expect(resetBtn).toBeInTheDocument();
    fireEvent.click(resetBtn);
    expect(onTogglePin).toHaveBeenCalledWith('#10b981');
    expect(hexInput.value).toBe('#10B981');

    // 点击收起自定义按钮可收起展开面板
    const collapseBtn = screen.getByRole('button', { name: '收起自定义颜色' });
    expect(collapseBtn).toBeInTheDocument();
    fireEvent.click(collapseBtn);
    expect(screen.queryByRole('slider', { name: '饱和度与明度选区' })).toBeNull();

    vi.useRealTimers();
  });
});

describe('PinActionWithPicker：自定义颜色弹层不被提前关闭（local-fix-actionbar-color-popover）', () => {
  function openByHover(container: HTMLElement) {
    const wrapper = container.firstChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    return wrapper;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('点「自定义颜色」后鼠标离开行和弹层，弹层不会被关掉；工具栏挂 data-popover-open', () => {
    vi.useFakeTimers();
    const { container } = render(
      <div data-testid="row">
        <PinActionWithPicker isPinned={false} onTogglePin={vi.fn()} />
      </div>
    );
    const wrapper = openByHover(container.firstChild as HTMLElement);
    expect(wrapper).toHaveAttribute('data-popover-open', 'true');

    const popover = screen.getByRole('toolbar', { name: '固定管理与颜色选择' });
    const customBtn = within(popover).getByRole('button', { name: '自定义固定颜色' });
    fireEvent.pointerDown(customBtn);
    fireEvent.mouseDown(customBtn);
    fireEvent.click(customBtn);
    expect(screen.getByRole('slider', { name: '饱和度与明度选区' })).toBeInTheDocument();

    // 鼠标移出弹层、移出触发器（=离开整行）
    fireEvent.mouseLeave(screen.getByRole('toolbar', { name: '固定管理与颜色选择' }));
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByRole('toolbar', { name: '固定管理与颜色选择' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: '饱和度与明度选区' })).toBeInTheDocument();
    expect(wrapper).toHaveAttribute('data-popover-open', 'true');
  });

  it('钉住后：弹层外点击或按 Esc 仍正常关闭，弹层内点击不关闭', () => {
    vi.useFakeTimers();
    const { container } = render(
      <div>
        <PinActionWithPicker isPinned={false} onTogglePin={vi.fn()} />
        <button type="button">outside</button>
      </div>
    );
    const wrapper = openByHover(container.firstChild as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: '自定义固定颜色' }));

    // 弹层内按下（色板）不关闭
    fireEvent.mouseDown(screen.getByRole('slider', { name: '饱和度与明度选区' }));
    expect(screen.getByRole('toolbar', { name: '固定管理与颜色选择' })).toBeInTheDocument();

    // Esc 关闭
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('toolbar', { name: '固定管理与颜色选择' })).toBeNull();
    expect(wrapper).not.toHaveAttribute('data-popover-open');

    // 再次打开 → 钉住 → 外部点击关闭
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.click(screen.getByRole('button', { name: '自定义固定颜色' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('toolbar', { name: '固定管理与颜色选择' })).toBeNull();
  });

  it('仅悬停预览（未在弹层内点击）时，鼠标移出后仍自动收起', () => {
    vi.useFakeTimers();
    const { container } = render(<PinActionWithPicker isPinned={false} onTogglePin={vi.fn()} />);
    const wrapper = openByHover(container);
    expect(screen.getByRole('toolbar', { name: '固定管理与颜色选择' })).toBeInTheDocument();
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole('toolbar', { name: '固定管理与颜色选择' })).toBeNull();
  });

  it('展开自定义（变高）时沿用打开时的方向，不翻转到触发器另一侧', () => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    const { container } = render(<PinActionWithPicker isPinned={false} onTogglePin={vi.fn()} />);
    const wrapperEl = container.firstChild as HTMLElement;
    // 触发器距视口顶 120px：小弹层放得下上方，展开后的 180px 面板放不下
    vi.spyOn(wrapperEl, 'getBoundingClientRect').mockReturnValue({
      top: 120, bottom: 148, left: 800, right: 828, width: 28, height: 28, x: 800, y: 120,
      toJSON: () => ({}),
    } as DOMRect);
    openByHover(container);
    const popover = () => screen.getByRole('toolbar', { name: '固定管理与颜色选择' });
    expect(parseFloat(popover().style.top)).toBeLessThan(120);

    fireEvent.click(screen.getByRole('button', { name: '自定义固定颜色' }));
    // 修复前：spaceAbove(120) < 188 且 < spaceBelow → 翻到触发器下方（top=154），鼠标落到弹层外
    expect(parseFloat(popover().style.top)).toBeLessThan(120);
    expect(parseFloat(popover().style.top)).toBeGreaterThanOrEqual(8);
  });

  it('CSS 契约：弹层打开期间，用户 / 助手工具栏保持可见可点', () => {
    const css = readFileSync(resolve(__dirname, 'ChatMessageRow.module.css'), 'utf8').replace(/\r\n/g, '\n');
    const m = css.match(
      /\.userMeta:has\(\[data-popover-open='true'\]\),\n\.assistantMeta:has\(\[data-popover-open='true'\]\)\s*\{([^}]*)\}/
    );
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/opacity:\s*1/);
    expect(m![1]).toMatch(/pointer-events:\s*auto/);
  });
});