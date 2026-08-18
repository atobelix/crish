// @vitest-environment jsdom
/**
 * ui/SegmentedControl 基础测试：同心几何、受控/非受控双模、键盘漫游与无障碍
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {} from 'react';
import { SegmentedControl } from './SegmentedControl';
import styles from './SegmentedControl.module.css';

describe('ui/SegmentedControl', () => {
  const sampleOptions = [
    { value: 'all', label: '全部' },
    { value: 'active', label: '进行中' },
    { value: 'completed', label: '已完成' },
  ];

  it('渲染基本选项且首项默认为非受控选中项', () => {
    render(<SegmentedControl options={sampleOptions} aria-label="状态筛选" />);
    const group = screen.getByRole('radiogroup', { name: '状态筛选' });
    expect(group).toBeInTheDocument();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
    expect(radios[2]).toHaveAttribute('aria-checked', 'false');
  });

  it('受控模式：正确反映受控 value 并调用 onChange', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl
        options={sampleOptions}
        value="active"
        onChange={onChange}
      />
    );
    expect(screen.getByRole('radio', { name: '进行中' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    fireEvent.click(screen.getByRole('radio', { name: '已完成' }));
    expect(onChange).toHaveBeenCalledWith('completed');

    rerender(
      <SegmentedControl
        options={sampleOptions}
        value="completed"
        onChange={onChange}
      />
    );
    expect(screen.getByRole('radio', { name: '已完成' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('非受控模式：点击切换内部状态并调用 onChange', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={sampleOptions}
        defaultValue="all"
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: '已完成' }));
    expect(onChange).toHaveBeenCalledWith('completed');
    expect(screen.getByRole('radio', { name: '已完成' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: '全部' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('支持纯字符串数组 options', () => {
    const strOptions = ['Day', 'Week', 'Month'];
    render(<SegmentedControl options={strOptions} defaultValue="Week" />);
    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('禁用态：整组禁用或单个选项禁用阻止交互', () => {
    const onChange = vi.fn();
    const optionsWithDisabled = [
      { value: 'a', label: '选项A' },
      { value: 'b', label: '选项B', disabled: true },
    ];
    const { rerender } = render(
      <SegmentedControl options={optionsWithDisabled} onChange={onChange} />
    );

    fireEvent.click(screen.getByRole('radio', { name: '选项B' }));
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <SegmentedControl
        options={optionsWithDisabled}
        disabled
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: '选项A' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('断言 6 (SegmentedControl 键盘漫游)：ArrowRight / ArrowLeft 切换选中项并触发 onChange', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={sampleOptions}
        defaultValue="all"
        onChange={onChange}
      />
    );
    const group = screen.getByRole('radiogroup');

    // 在容器上按下 ArrowRight -> 切换到 index 1 ('active')
    fireEvent.keyDown(group, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('active');
    expect(screen.getByRole('radio', { name: '进行中' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // 再次按下 ArrowRight -> 切换到 index 2 ('completed')
    fireEvent.keyDown(group, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('completed');
    expect(screen.getByRole('radio', { name: '已完成' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // 按下 ArrowLeft -> 回退到 index 1 ('active')
    fireEvent.keyDown(group, { key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('active');
    expect(screen.getByRole('radio', { name: '进行中' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('支持尺寸修饰器与 block 属性', () => {
    const { rerender } = render(
      <SegmentedControl options={sampleOptions} size="xs" block />
    );
    const group = screen.getByRole('radiogroup');
    expect(group).toHaveClass(styles.containerXs);
    expect(group).toHaveClass(styles.containerBlock);
    expect(group).toHaveAttribute('data-size', 'xs');

    rerender(<SegmentedControl options={sampleOptions} size="md" />);
    expect(group).toHaveClass(styles.containerMd);
    expect(group).toHaveAttribute('data-size', 'md');
  });
});
