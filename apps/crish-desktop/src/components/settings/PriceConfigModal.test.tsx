// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PriceConfigModal } from './PriceConfigModal';
import type { ModelPrice } from '../../api/pricingStore';

// Mock toast
vi.mock('../../services/toast/ToastContext', () => ({
  toast: {
    show: vi.fn(),
  },
}));

describe('PriceConfigModal (现代模型单价配置弹窗)', () => {
  const initialPrices: ModelPrice[] = [
    {
      model: 'gpt-5.6-sol',
      inputPerMTok: 4.0,
      outputPerMTok: 20.0,
      cacheReadPerMTok: 0.4,
      currency: 'USD',
      billingUnit: 'token',
    },
    {
      model: 'claude-sonnet-5',
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
      cacheReadPerMTok: 0.3,
      currency: 'USD',
      billingUnit: 'token',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('渲染弹窗、表头与初始价格行', () => {
    render(
      <PriceConfigModal
        open={true}
        priceList={initialPrices}
        onListChange={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('模型单价配置')).toBeTruthy();
    expect(screen.getByDisplayValue('gpt-5.6-sol')).toBeTruthy();
    expect(screen.getByDisplayValue('claude-sonnet-5')).toBeTruthy();
  });

  it('支持输入关键词实时过滤模型', () => {
    render(
      <PriceConfigModal
        open={true}
        priceList={initialPrices}
        onListChange={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const searchInput = screen.getByPlaceholderText('搜索模型…');
    fireEvent.change(searchInput, { target: { value: 'claude' } });

    expect(screen.queryByDisplayValue('gpt-5.6-sol')).toBeNull();
    expect(screen.getByDisplayValue('claude-sonnet-5')).toBeTruthy();
  });

  it('支持币种切换 (USD / CNY)', () => {
    render(
      <PriceConfigModal
        open={true}
        priceList={initialPrices}
        onListChange={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const cnyTab = screen.getByText('CNY (¥)');
    fireEvent.click(cnyTab);

    expect(screen.getByText(/提示输入 \(¥\/1M\)/)).toBeTruthy();
  });

  it('支持修改录入的模型名称并保存', () => {
    const onListChange = vi.fn();
    render(
      <PriceConfigModal
        open={true}
        priceList={initialPrices}
        onListChange={onListChange}
        onClose={vi.fn()}
      />
    );

    const modelInput = screen.getByDisplayValue('gpt-5.6-sol');
    fireEvent.change(modelInput, { target: { value: 'gpt-5.6-sol-custom' } });

    const saveBtn = screen.getByText('保存');
    fireEvent.click(saveBtn);

    expect(onListChange).toHaveBeenCalled();
    const nextList: ModelPrice[] = onListChange.mock.calls[0][0];
    expect(nextList.some((p) => p.model === 'gpt-5.6-sol-custom')).toBe(true);
    expect(nextList.some((p) => p.model === 'gpt-5.6-sol')).toBe(false);
  });

  it('支持手动添加新模型单价并触发更新', () => {
    const onListChange = vi.fn();
    render(
      <PriceConfigModal
        open={true}
        priceList={initialPrices}
        onListChange={onListChange}
        onClose={vi.fn()}
      />
    );

    const modelInput = screen.getByPlaceholderText('新模型 ID…');
    const zeroInputs = screen.getAllByPlaceholderText('0.0');
    const inputPriceInput = zeroInputs[zeroInputs.length - 2];
    const outputPriceInput = zeroInputs[zeroInputs.length - 1];
    const addBtn = screen.getByText('添加');

    fireEvent.change(modelInput, { target: { value: 'my-custom-model' } });
    fireEvent.change(inputPriceInput, { target: { value: '1.5' } });
    fireEvent.change(outputPriceInput, { target: { value: '4.5' } });

    fireEvent.click(addBtn);

    expect(onListChange).toHaveBeenCalled();
    const addedList: ModelPrice[] = onListChange.mock.calls[0][0];
    const added = addedList.find((p) => p.model === 'my-custom-model');
    expect(added).toBeDefined();
    expect(added?.inputPerMTok).toBe(1.5);
    expect(added?.outputPerMTok).toBe(4.5);
  });
});
