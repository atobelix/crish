// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ColorPicker } from '../ColorPicker';

describe('ColorPicker 专业高精取色器', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
  });

  afterEach(async () => {
    await act(async () => {
      vi.runAllTimers();
    });
    vi.useRealTimers();
  });

  it('初始状态正确渲染触发器（Trigger）的颜色圆点与 Hex 文本', () => {
    render(<ColorPicker defaultValue="#2F6BFF" label="主强调色" />);
    expect(screen.getByText('主强调色')).not.toBeNull();
    expect(screen.getByText('#2F6BFF')).not.toBeNull();
    const trigger = screen.getByRole('button', { name: /主强调色/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('点击触发器能够展开弹层面板，点击完成或按 Escape 键能够收起', async () => {
    render(<ColorPicker defaultValue="#FF0000" label="Brand" />);
    const trigger = screen.getByRole('button', { name: /Brand/ });

    // 打开
    await act(async () => {
      fireEvent.click(trigger);
      vi.runAllTimers();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const dialog = screen.getByRole('dialog', { name: /Brand color/ });
    expect(dialog).not.toBeNull();

    // 按 Escape 收起
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
      vi.runAllTimers();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('格式切换按钮在 Hex / RGB / HSL / OKLCH 之间循环切流', () => {
    render(<ColorPicker defaultValue="#FF0000" label="FormatTest" />);
    const trigger = screen.getByRole('button', { name: /FormatTest/ });

    act(() => {
      fireEvent.click(trigger);
    });

    const formatBtn = screen.getByRole('button', { name: /Format: Hex/ });
    expect(formatBtn).not.toBeNull();

    // 点击切换为 RGB
    act(() => {
      fireEvent.click(formatBtn);
    });
    expect(screen.getByRole('button', { name: /Format: RGB/ })).not.toBeNull();

    // 点击切换为 HSL
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Format: RGB/ }));
    });
    expect(screen.getByRole('button', { name: /Format: HSL/ })).not.toBeNull();

    // 点击切换为 OKLCH
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Format: HSL/ }));
    });
    expect(
      screen.getByRole('button', { name: /Format: OKLCH/ })
    ).not.toBeNull();

    // 再次点击切回 Hex
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Format: OKLCH/ }));
    });
    expect(screen.getByRole('button', { name: /Format: Hex/ })).not.toBeNull();
  });

  it('直接输入颜色字符串并按 Enter 键正确提交并触发 onValueChange', () => {
    const onValueChange = vi.fn();
    render(
      <ColorPicker
        defaultValue="#000000"
        onValueChange={onValueChange}
        label="InputTest"
      />
    );
    const trigger = screen.getByRole('button', { name: /InputTest/ });
    act(() => {
      fireEvent.click(trigger);
    });

    const input = screen.getByRole('textbox', { name: /InputTest in Hex/ });
    act(() => {
      fireEvent.change(input, { target: { value: '#00FF00' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(onValueChange).toHaveBeenCalledWith('#00FF00');
  });

  it('输入非法颜色字符串时标记 aria-invalid 并展示提示信息', () => {
    render(<ColorPicker defaultValue="#123456" label="InvalidTest" />);
    const trigger = screen.getByRole('button', { name: /InvalidTest/ });
    act(() => {
      fireEvent.click(trigger);
    });

    const input = screen.getByRole('textbox', { name: /InvalidTest in Hex/ });
    act(() => {
      fireEvent.change(input, { target: { value: 'invalid-color' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(
      screen.getByText('Enter a hex, RGB, HSL, or OKLCH color')
    ).not.toBeNull();
  });

  it('预设色板点击切换与新增色板保存', () => {
    const onValueChange = vi.fn();
    const defaultSwatches = [
      { id: 'c1', color: '#FF0000' },
      { id: 'c2', color: '#00FF00' },
    ];
    render(
      <ColorPicker
        defaultValue="#0000FF"
        defaultSwatches={defaultSwatches}
        onValueChange={onValueChange}
        label="SwatchTest"
      />
    );
    const trigger = screen.getByRole('button', { name: /SwatchTest/ });
    act(() => {
      fireEvent.click(trigger);
    });

    // 点击现有色板项
    const redOption = screen.getByRole('option', { name: /#FF0000/ });
    act(() => {
      fireEvent.click(redOption);
    });
    expect(onValueChange).toHaveBeenCalledWith('#FF0000');

    // 点击加号保存当前色板
    const addBtn = screen.getByRole('button', { name: /Save #FF0000/ });
    act(() => {
      fireEvent.click(addBtn);
    });

    // 应当有 3 个色板项
    const options = screen.getAllByRole('option');
    expect(options.length).toBe(3);
  });

  it('WCAG 对比度指示器正确展示对比度比值与通过等级', () => {
    render(
      <ColorPicker
        defaultValue="#000000"
        background="#FFFFFF"
        label="ContrastTest"
      />
    );
    const trigger = screen.getByRole('button', { name: /ContrastTest/ });
    act(() => {
      fireEvent.click(trigger);
    });

    // 纯黑在纯白背景下等级为 AAA
    expect(screen.getByText('AAA')).not.toBeNull();
    expect(screen.getByText(/against background/)).not.toBeNull();
  });

  it('支持 window.EyeDropper 屏幕吸管调用', async () => {
    const mockOpen = vi.fn().mockResolvedValue({ sRGBHex: '#10B981' });
    (window as any).EyeDropper = vi.fn().mockImplementation(() => ({
      open: mockOpen,
    }));

    const onValueChange = vi.fn();
    render(
      <ColorPicker
        defaultValue="#000000"
        onValueChange={onValueChange}
        label="EyeDropperTest"
      />
    );
    const trigger = screen.getByRole('button', { name: /EyeDropperTest/ });
    act(() => {
      fireEvent.click(trigger);
    });

    const pipetteBtn = screen.getByRole('button', {
      name: 'Pick a color from the screen',
    });
    expect(pipetteBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(pipetteBtn);
    });

    expect(mockOpen).toHaveBeenCalled();
    delete (window as any).EyeDropper;
  });

  it('2D 拾色球与滑块键盘微调支持', () => {
    const onValueChange = vi.fn();
    render(
      <ColorPicker
        defaultValue="#808080"
        onValueChange={onValueChange}
        label="KeyboardTest"
      />
    );
    const trigger = screen.getByRole('button', { name: /KeyboardTest/ });
    act(() => {
      fireEvent.click(trigger);
    });

    const areaSlider = screen.getByRole('slider', {
      name: 'Saturation and brightness',
    });
    act(() => {
      fireEvent.keyDown(areaSlider, { key: 'ArrowRight' });
    });
    expect(onValueChange).toHaveBeenCalled();

    const hueSlider = screen.getByRole('slider', { name: 'Hue' });
    act(() => {
      fireEvent.keyDown(hueSlider, { key: 'ArrowRight' });
    });
    expect(onValueChange).toHaveBeenCalled();
  });
});
