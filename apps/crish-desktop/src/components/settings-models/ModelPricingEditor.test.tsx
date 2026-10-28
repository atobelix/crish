// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ModelPricingEditor,
  type ModelPricingDraft,
} from './ModelPricingEditor';

describe('ModelPricingEditor (四维双币价格选填与静默)', () => {
  it('渲染 4 项价格输入框，占位符为选填，支持双币切换按钮', () => {
    const pricing: ModelPricingDraft = {
      currency: 'USD',
      input: '',
      output: '',
      cacheRead: '',
      cacheWrite: '',
    };
    render(<ModelPricingEditor pricing={pricing} onChange={vi.fn()} />);

    expect(
      screen.getByText(/四维计费 \(选填 · 留空优雅静默\)/)
    ).toBeInTheDocument();
    expect(screen.getByText('¥ CNY')).toBeInTheDocument();
    expect(screen.getByText('$ USD')).toBeInTheDocument();

    expect(screen.getByText('普通输入 / 1M')).toBeInTheDocument();
    expect(screen.getByText('生成输出 / 1M')).toBeInTheDocument();
    expect(screen.getByText(/缓存读取 \/ 1M \(绝对单价\)/)).toBeInTheDocument();
    expect(screen.getByText('缓存写入 / 1M')).toBeInTheDocument();

    const inputs = screen.getAllByPlaceholderText('选填');
    expect(inputs.length).toBe(4);
  });

  it('点击 ¥ CNY 切换币种：触发 onChange 更新 currency', () => {
    const onChange = vi.fn();
    const pricing: ModelPricingDraft = {
      currency: 'USD',
      input: '0.15',
    };
    render(<ModelPricingEditor pricing={pricing} onChange={onChange} />);

    fireEvent.click(screen.getByText('¥ CNY'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'CNY',
        input: '0.15',
      })
    );
  });

  it('编辑各维度价格：独立触发 onChange 更新数值', () => {
    const onChange = vi.fn();
    const pricing: ModelPricingDraft = {
      currency: 'USD',
      input: '',
      output: '',
      cacheRead: '',
      cacheWrite: '',
    };
    render(<ModelPricingEditor pricing={pricing} onChange={onChange} />);

    const inputs = screen.getAllByPlaceholderText('选填');
    // input
    fireEvent.change(inputs[0], { target: { value: '0.25' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '0.25',
      })
    );

    // cacheRead 绝对单价
    fireEvent.change(inputs[2], { target: { value: '0.05' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheRead: '0.05',
      })
    );
  });
});
