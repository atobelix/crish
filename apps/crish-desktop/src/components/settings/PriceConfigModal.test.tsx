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

// toast 打桩（弹窗只用 toast.show 呈现失败结果，不参与断言逻辑）
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

/** 编辑即保存的防抖窗口 + 余量（与 EditablePriceRow.AUTO_SAVE_DEBOUNCE_MS 对齐）。 */
const AUTO_SAVE_WAIT = { timeout: 3000 };

/**
 * 树夹具：一个带用户声明价、一个仅有字典预估、一个未收录、一个生图模型。
 * 生图判据 = `modalities.output` 含 `image`（见 modelPricingSource.deriveBillingMode）。
 */
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
      openai: {
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        protocol: 'openai/chat',
        order: 3,
        models: [
          {
            id: 'gpt-image-1',
            displayName: 'GPT Image 1',
            enabled: true,
            // 生图模型：输出模态含 image
            modalities: { input: ['text', 'image'], output: ['image'] },
          },
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
    // 树里 5 个模型 → 5 行（含「未收录」的那个，绝不漏行）
    expect(screen.getByTestId('price-row-ollama/ornith')).toBeTruthy();
    expect(screen.getByTestId('price-row-ollama/estimate-only')).toBeTruthy();
    expect(screen.getByTestId('price-row-ollama/nothing')).toBeTruthy();
    expect(
      screen.getByTestId('price-row-deepseek/deepseek-v4-pro')
    ).toBeTruthy();
    expect(screen.getByTestId('price-row-openai/gpt-image-1')).toBeTruthy();
  });

  it('模型与服务商分列两个表头（身份不再挤在同一个单元格）', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    // 两个独立表头
    expect(screen.getByTestId('price-header-model').textContent).toBe('模型');
    expect(screen.getByTestId('price-header-provider').textContent).toBe(
      '服务商'
    );
    // 负向断言：旧的合并表头「模型（服务商 / 模型 ID）」不得残留
    expect(screen.queryByText('模型（服务商 / 模型 ID）')).toBeNull();

    // 模型列 = displayName；服务商列 = providerName，各自独立承载
    expect(
      screen.getByTestId('price-row-model-ollama/ornith').textContent
    ).toBe('Ornith 1.5 9B');
    expect(
      screen.getByTestId('price-row-provider-ollama/ornith').textContent
    ).toBe('Ollama 本地');
  });

  it('不展示价格来源徽标（负向断言：全表零 [data-source] 节点）', () => {
    const { container } = render(
      <PriceConfigModal open={true} onClose={vi.fn()} />
    );

    expect(container.querySelectorAll('[data-source]')).toHaveLength(0);
    expect(screen.queryByText(/^用户 ·/)).toBeNull();
    expect(screen.queryByText(/^预估 ·/)).toBeNull();
    expect(screen.queryByText(/^未收录 ·/)).toBeNull();
  });

  it('「有自定义价」由清除入口隐式表达（用户行有入口，其余行没有）', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    expect(screen.getByLabelText('清除 ollama/ornith 自定义单价')).toBeTruthy();
    expect(screen.queryByLabelText('清除 ollama/estimate-only 自定义单价')).toBeNull();
    expect(screen.queryByLabelText('清除 ollama/nothing 自定义单价')).toBeNull();
    expect(screen.queryByLabelText('清除 openai/gpt-image-1 自定义单价')).toBeNull();
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

  it('未收录不得渲染为 0，且输入框不提示收录状态（负向断言：零 placeholder）', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('ollama/nothing 提示词输入单价');
    expect(input).toHaveProperty('value', '');
    expect(input).not.toHaveProperty('value', '0');
    // 用户裁决：不在输入框提示里显示「收录 / 未收录」
    expect(input.getAttribute('placeholder')).toBeNull();
    expect(
      screen
        .getByLabelText('ollama/nothing 缓存命中单价')
        .getAttribute('placeholder')
    ).toBeNull();
  });

  it('计费方式只读派生：Token 模型显示「按 Token」', () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    expect(
      screen.getByTestId('price-row-billing-ollama/ornith').textContent
    ).toBe('按 Token');
    expect(
      screen.getByTestId('price-row-billing-ollama/ornith').getAttribute(
        'data-billing'
      )
    ).toBe('per_1m_tokens');
  });

  it('生图模型自动套用按张价：只呈现按张单价，Token 列不适用（负向断言：无计费方式选择器）', () => {
    const { container } = render(
      <PriceConfigModal open={true} onClose={vi.fn()} />
    );

    const imageRow = screen.getByTestId('price-row-openai/gpt-image-1');
    expect(imageRow).toBeTruthy();
    expect(
      screen.getByTestId('price-row-billing-openai/gpt-image-1').textContent
    ).toBe('按张生成');
    expect(
      screen
        .getByTestId('price-row-billing-openai/gpt-image-1')
        .getAttribute('data-billing')
    ).toBe('per_image');

    // 生图行只有「按张生成单价」一个输入框；Token 三列不再出现输入框
    expect(
      screen.getByLabelText('openai/gpt-image-1 按张生成单价')
    ).toBeTruthy();
    expect(
      screen.queryByLabelText('openai/gpt-image-1 提示词输入单价')
    ).toBeNull();
    expect(
      screen.queryByLabelText('openai/gpt-image-1 生成补全单价')
    ).toBeNull();
    expect(
      screen.queryByLabelText('openai/gpt-image-1 缓存命中单价')
    ).toBeNull();

    // 负向断言：计费方式单元格为纯文本徽标，不含任何可交互控件；
    // 全表零 combobox / 原生 select（计费方式不再多选，`Select` 触发器即 role=combobox）
    const billingCell = screen.getByTestId(
      'price-row-billing-openai/gpt-image-1'
    );
    expect(billingCell.tagName).toBe('SPAN');
    expect(
      billingCell.querySelectorAll('button, [role="combobox"], select')
    ).toHaveLength(0);
    expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(0);
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });

  it('编辑即保存：无保存按钮（负向断言），改动经防抖后直接落树', async () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    // 负向断言：全表零「保存」按钮
    expect(screen.queryByText('保存')).toBeNull();

    fireEvent.click(screen.getByText('CNY (¥)'));
    fireEvent.change(screen.getByLabelText('ollama/estimate-only 提示词输入单价'), {
      target: { value: '9' },
    });
    fireEvent.change(
      screen.getByLabelText('ollama/estimate-only 生成补全单价'),
      { target: { value: '36' } }
    );

    await waitFor(
      () => expect(setModelPriceMock).toHaveBeenCalledTimes(1),
      AUTO_SAVE_WAIT
    );
    const [ref, pricing] = setModelPriceMock.mock.calls[0]!;
    expect(ref).toEqual({ providerId: 'ollama', modelId: 'estimate-only' });
    // 预估行的 cacheRead 作为编辑初值一并带上（用户编辑即采纳该预估）
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

  it('生图模型编辑按张价 → 落树 per_image + perImage（不带 Token 价字段）', async () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('openai/gpt-image-1 按张生成单价'), {
      target: { value: '0.04' },
    });

    await waitFor(
      () => expect(setModelPriceMock).toHaveBeenCalledTimes(1),
      AUTO_SAVE_WAIT
    );
    const [ref, pricing] = setModelPriceMock.mock.calls[0]!;
    expect(ref).toEqual({ providerId: 'openai', modelId: 'gpt-image-1' });
    expect(pricing).toEqual({
      currency: 'CNY',
      unit: 'per_image',
      perImage: 0.04,
    });
    expect(pricing).not.toHaveProperty('input');
    expect(pricing).not.toHaveProperty('output');
  });

  it('编辑未成完整价（Token 模式缺输出）→ 不落树，不写半条声明', async () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    // 只清空输出价：不足以构成一条可用价 ⇒ 不得写盘（未配置 ≠ 0）
    fireEvent.change(
      screen.getByLabelText('ollama/estimate-only 生成补全单价'),
      { target: { value: '' } }
    );

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(setModelPriceMock).not.toHaveBeenCalled();
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

  it('清除自定义价 = 写树 undefined（回落字典预估）', async () => {
    render(<PriceConfigModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('清除 ollama/ornith 自定义单价'));
    await waitFor(() => expect(setModelPriceMock).toHaveBeenCalledTimes(1));
    expect(setModelPriceMock.mock.calls[0]![0]).toEqual({
      providerId: 'ollama',
      modelId: 'ornith',
    });
    expect(setModelPriceMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('自动保存失败：行内显式呈现错误 + toast，不静默降级', async () => {
    setModelPriceMock.mockResolvedValueOnce({ ok: false, error: '修订冲突' });
    const { toast } = await import('../../services/toast/ToastContext');

    render(<PriceConfigModal open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('ollama/ornith 提示词输入单价'), {
      target: { value: '7' },
    });

    await waitFor(
      () => expect(vi.mocked(toast.show)).toHaveBeenCalledTimes(1),
      AUTO_SAVE_WAIT
    );
    expect(vi.mocked(toast.show)).toHaveBeenCalledWith(
      expect.stringContaining('修订冲突')
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('price-row-error-ollama/ornith').textContent
      ).toContain('修订冲突')
    );
  });
});
