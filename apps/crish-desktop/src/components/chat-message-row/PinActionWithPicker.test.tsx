/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
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
