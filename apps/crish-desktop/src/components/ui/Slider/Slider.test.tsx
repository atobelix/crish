// @vitest-environment jsdom
/**
 * ui/Slider 基础测试：2px 发丝轨道、受控/非受控双模、键盘漫游与无障碍属性
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Slider } from './Slider';
import styles from './Slider.module.css';

describe('ui/Slider', () => {
  it('渲染 role=slider 且具备标准无障碍属性', () => {
    render(<Slider min={0} max={100} value={50} aria-label="音量调节" />);
    const slider = screen.getByRole('slider', { name: '音量调节' });
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '100');
  });

  it('受控与非受控双模正常工作', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Slider defaultValue={25} min={0} max={100} onChange={onChange} />
    );
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '25');

    rerender(<Slider value={75} min={0} max={100} onChange={onChange} />);
    expect(slider).toHaveAttribute('aria-valuenow', '75');
  });

  it('键盘方向键 (ArrowRight / ArrowLeft / Home / End) 增减数值并触发 onChange', () => {
    const onChange = vi.fn();
    render(
      <Slider
        defaultValue={50}
        min={0}
        max={100}
        step={5}
        onChange={onChange}
      />
    );
    const slider = screen.getByRole('slider');

    // ArrowRight +5: 50 -> 55
    fireEvent.keyDown(slider, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(55);

    // ArrowLeft -5: 55 -> 50
    fireEvent.keyDown(slider, { key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(50);

    // Home -> min (0)
    fireEvent.keyDown(slider, { key: 'Home', code: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(0);

    // End -> max (100)
    fireEvent.keyDown(slider, { key: 'End', code: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it('disabled 态阻止键盘响应', () => {
    const onChange = vi.fn();
    render(<Slider value={50} disabled onChange={onChange} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('tabindex', '-1');
    expect(slider).toHaveClass(styles.sliderDisabled);

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
