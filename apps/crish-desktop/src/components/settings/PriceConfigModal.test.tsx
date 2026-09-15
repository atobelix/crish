// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { PriceConfigModal } from './PriceConfigModal';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import { catalogSnapshot } from '../../test-utils/modelsCatalogSnapshot';
import {
  applyCatalogCacheSnapshot,
  clearCatalogCacheSnapshot,
} from '../../api/pricingResolver';
import { setModelPrice } from '../../api/modelPricingSource';
import type { ModelsYamlTree } from '../../api/modelsCatalogTypes';

// toast 打桩（弹窗只用 toast.show 呈现结果，不参与断言逻辑）
vi.mock('../../services/toast/ToastContext', () => ({
  toast: { show: vi.fn() },
}));

// 树加载打桩：本用例直接注入快照，不走 IPC
vi.mock('../../api/modelsCatalogStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/modelsCatalogStore')>();
  return { ...actual, ensureModelsCatalogLoaded: vi.fn(async () => ({ ok: true })) };
});

// setModelPrice 打桩为可观测写入面；listConfiguredPrices / resolveEffectivePrice 保持真实现
vi.mock('../../api/modelPricingSource', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/modelPricingSource')>();
  return {
    ...actual,
    setModelPrice: vi.fn(async () => ({ ok: true }) as const),
  };
});

const setModelPriceMock = vi.mocked(setModelPrice);

/** 树夹具：一个带用户声明价、一个仅有字典预估、一个未收录 */
function treeFixture(): ModelsYamlTree {
  return {
    version: 2,
    activeModel: null,
    providers: {
      ollama: {
        displayName: 'Ollama 本地',
        baseUrl: 'http://127.0.0.1:11434',
        protocol: 'openai/chat',
        order: 1,
        models: [
          {
            id: 'ornith',
            displayName: 'Ornith 1.5 9B',
            enabled: true,
            contextWindow: 262144,
            pricing: { currency: 'CNY', unit: 'per_1m_tokens', input: 3, output: 12 },
          },
          { id: 'estimate-only', displayName: '仅预估模型', enabled: true },
          { id: 'nothing', displayName: '未收录模型', enabled: true },
        ],
      },
      deepseek: {
        displayName: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com',
        protocol: 'openai/chat',
        order: 2,
        models: [
          { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', enabled: true },
        ],
      },
    },
  };
}

function injectTree(): void {
  modelsCatalogStore.resetForTesting();
  modelsCatalogStore.acceptSnapshot(
    catalogSnapshot({
      tree: treeFixture(),
      revision: 'revision-1',
      content: JSON.stringify(treeFixture()),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearCatalogCacheSnapshot();
  injectTree();
  // 出厂字典预估：只覆盖 estimate-only（其余模型字典未收录）
  applyCatalogCacheSnapshot({
    version: 1,
    prices: {
      'estimate-only': {
        inputPerMTok: 1.5,
        outputPerMTok: 6,
        readPerMTok: 0.15,
        currency: 'USD',
      },
    },
  });
});

describe('PriceConfigModal（名单真源 = 统一树）', () => {
  it('渲染弹窗、表头，且名单与统一树模型集合一致', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    expect(screen.getByText('模型单价配置')).toBeTruthy();
    // 树里 4 个模型 → 4 行（含「未收录」的那个，绝不漏行）
    expect(screen.getByTestId('price-row-ollama/ornith')).toBeTruthy();
    expect(screen.getByTestId('price-row-ollama/estimate-only')).toBeTruthy();
    expect(screen.getByTestId('price-row-ollama/nothing')).toBeTruthy();
    expect(
      screen.getByTestId('price-row-deepseek/deepseek-v4-pro')
    ).toBeTruthy();
    // 身份来自树，展示「服务商 · 模型 ID」
    expect(screen.getByText('Ollama 本地 · ornith')).toBeTruthy();
  });

  it('价格来源三分：用户 / 预估 / 未收录（徽标逐行断言）', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    const userRow = screen.getByTestId('price-row-ollama/ornith');
    const estimateRow = screen.getByTestId('price-row-ollama/estimate-only');
    const noneRow = screen.getByTestId('price-row-ollama/nothing');

    expect(userRow.querySelector('[data-source="user"]')?.textContent).toContain(
      '用户'
    );
    expect(
      estimateRow.querySelector('[data-source="estimate"]')?.textContent
    ).toContain('预估');
    expect(
      noneRow.querySelector('[data-source="none"]')?.textContent
    ).toContain('未收录');
  });

  it('用户声明价权威：输入框初值取树声明，而非字典预估', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    // ornith 树声明 3 / 12（CNY）；字典对它未收录
    expect(
      screen.getByLabelText('ollama/ornith 提示词输入单价')
    ).toHaveProperty('value', '3');
    expect(
      screen.getByLabelText('ollama/ornith 生成补全单价')
    ).toHaveProperty('value', '12');
  });

  it('字典预估作为编辑初值预填（需求：先根据字典生成预估价格）', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    expect(
      screen.getByLabelText('ollama/estimate-only 提示词输入单价')
    ).toHaveProperty('value', '1.5');
    expect(
      screen.getByLabelText('ollama/estimate-only 生成补全单价')
    ).toHaveProperty('value', '6');
  });

  it('未收录不得渲染为 0（负向断言：空值 + 「未收录」占位）', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('ollama/nothing 提示词输入单价');
    expect(input).toHaveProperty('value', '');
    expect(input.getAttribute('placeholder')).toBe('未收录');
    expect(input).not.toHaveProperty('value', '0');
  });

  it('支持输入关键词实时过滤模型', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText('搜索模型…');
    fireEvent.change(searchInput, { target: { value: 'deepseek' } });

    expect(screen.queryByTestId('price-row-ollama/ornith')).toBeNull();
    expect(
      screen.getByTestId('price-row-deepseek/deepseek-v4-pro')
    ).toBeTruthy();
  });

  it('过滤无匹配 → 「暂无匹配的模型」（与树空态可区分）', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText('搜索模型…');
    fireEvent.change(searchInput, { target: { value: 'zzz-no-match' } });
    expect(screen.getByText('暂无匹配的模型')).toBeTruthy();
    expect(screen.queryByText(/模型配置里还没有模型/)).toBeNull();
  });

  it('树里没有模型 → 引导去模型配置（不是「暂无匹配」）', () => {
    modelsCatalogStore.resetForTesting();
    modelsCatalogStore.acceptSnapshot(
      catalogSnapshot({
        tree: { version: 2, activeModel: null, providers: {} },
        revision: 'revision-empty',
        content: 'version: 2\nproviders: {}\nactiveModel: null\n',
      })
    );
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    expect(screen.getByText(/模型配置里还没有模型/)).toBeTruthy();
    expect(screen.queryByText('暂无匹配的模型')).toBeNull();
  });

  it('支持币种切换 (USD / CNY)', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('CNY (¥)'));
    expect(screen.getByText(/提示输入 \(¥\/1M\)/)).toBeTruthy();

    fireEvent.click(screen.getByText('USD ($)'));
    expect(screen.getByText(/提示输入 \(\$\/1M\)/)).toBeTruthy();
  });

  it('保存价格写入统一树（身份 = 二元组，不写 LS 价表）', async () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('CNY (¥)'));
    const input = screen.getByLabelText('ollama/estimate-only 提示词输入单价');
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.change(
      screen.getByLabelText('ollama/estimate-only 生成补全单价'),
      { target: { value: '36' } }
    );

    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(setModelPriceMock).toHaveBeenCalledTimes(1));
    const [ref, pricing] = setModelPriceMock.mock.calls[0]!;
    expect(ref).toEqual({ providerId: 'ollama', modelId: 'estimate-only' });
    // 预估行的 cacheRead 作为编辑初值一并带上（用户保存即采纳该预估）
    expect(pricing).toEqual({
      currency: 'CNY',
      unit: 'per_1m_tokens',
      input: 9,
      output: 36,
      cacheRead: 0.15,
    });
    // 负向断言：旧 LS 价表不再被写入
    expect(localStorage.getItem('crish_model_prices_v1')).toBeNull();
  });

  it('清除自定义价 = 写树 undefined（回落字典预估）；预估行无清除入口', async () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    // 用户声明行有清除入口
    fireEvent.click(
      screen.getByLabelText('清除 ollama/ornith 自定义单价')
    );
    await waitFor(() => expect(setModelPriceMock).toHaveBeenCalledTimes(1));
    expect(setModelPriceMock.mock.calls[0]![0]).toEqual({
      providerId: 'ollama',
      modelId: 'ornith',
    });
    expect(setModelPriceMock.mock.calls[0]![1]).toBeUndefined();

    // 负向断言：预估行 / 未收录行**不得**出现清除入口（没有自定义价可清）
    expect(screen.queryByLabelText('清除 ollama/estimate-only 自定义单价')).toBeNull();
    expect(screen.queryByLabelText('清除 ollama/nothing 自定义单价')).toBeNull();
  });

  it('保存失败显式提示，不静默降级', async () => {
    setModelPriceMock.mockResolvedValueOnce({ ok: false, error: '修订冲突' });
    const { toast } = await import('../../services/toast/ToastContext');

    render(<PriceConfigModal open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('ollama/ornith 提示词输入单价'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() =>
      expect(vi.mocked(toast.show)).toHaveBeenCalledWith(
        expect.stringContaining('修订冲突')
      )
    );
  });
});
