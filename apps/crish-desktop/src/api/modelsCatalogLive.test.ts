import { beforeEach, describe, expect, it } from 'vitest';
import {
  modelsCatalogStore,
  selectEffectiveCompat,
  selectEffectiveProtocol,
} from './modelsCatalogStore';
import {
  getLiveModel,
  getLiveProvider,
  listLivePickerEntries,
  modelAcceptsInput,
  listThinkingOptions,
  resolveThinkingHandoff,
  resolveThinkingHandoffSafe,
  isThinkingLevelAvailable,
} from './modelsCatalogLive';
import type { ModelsYamlTree, ProviderSpec } from './modelsCatalogTypes';

const provider: ProviderSpec = {
  protocol: 'openai/chat',
  enabled: true,
  stream: true,
  compat: {
    thinkingFormat: 'openai',
    strictJsonSchema: true,
    cacheControlFormat: 'anthropic',
  },
  models: [
    {
      id: 'Shared',
      enabled: true,
      contextWindow: 1000000,
      compat: { strictJsonSchema: false, cacheControlFormat: 'disabled' },
      thinking: { Max: 'max', Low: 'low', XHigh: ' wire ' },
      modalities: { input: ['pdf', 'image'], output: ['text'] },
      pricing: {
        currency: 'CNY',
        perImage: 0,
        tiers: [{ inputTokensAbove: 0, input: 2 }],
      },
    },
  ],
};
function install(tree: ModelsYamlTree) {
  modelsCatalogStore.acceptSnapshot({
    path: 'memory/models.yaml',
    content: '',
    revision: 'r1',
    tree,
    credentialStates: {},
    template: '',
  });
}
beforeEach(() => {
  modelsCatalogStore.resetForTesting();
  install({
    version: 2,
    activeModel: null,
    providers: {
      Acme: provider,
      acme: { ...provider, models: [{ id: 'Shared', enabled: true }] },
      Disabled: { ...provider, enabled: false },
    },
  });
});

describe('规范模型生产读取', () => {
  it('所有真实读取路径保留供应商大小写', () => {
    expect(getLiveProvider(' Acme ')?.models[0]?.contextWindow).toBe(1000000);
    expect(getLiveModel('acme', 'Shared')?.contextWindow).toBeUndefined();
    expect(getLiveModel('ACME', 'Shared')).toBeUndefined();
    expect(getLiveModel('Acme', 'shared')).toBeUndefined();
  });
  it('列表只消费已启用模型，不为缺规格填值', () => {
    expect(listLivePickerEntries().map((entry) => entry.providerId)).toEqual([
      'Acme',
      'acme',
    ]);
    expect(getLiveModel('acme', 'Shared')?.pricing).toBeUndefined();
    expect(getLiveModel('Acme', 'Shared')?.pricing).toEqual(
      provider.models[0]?.pricing
    );
  });
  it('模态缺省或供应商停用均不能上传', () => {
    expect(modelAcceptsInput('Acme', 'Shared', 'pdf')).toBe(true);
    expect(modelAcceptsInput('acme', 'Shared', 'image')).toBe(false);
    expect(modelAcceptsInput('Disabled', 'Shared', 'image')).toBe(false);
  });
  it('未加载或模型不存在不回落到默认协议', () => {
    expect(selectEffectiveProtocol('missing', 'Shared')).toBeUndefined();
    modelsCatalogStore.resetForTesting();
    expect(getLiveModel('Acme', 'Shared')).toBeUndefined();
    expect(listLivePickerEntries()).toEqual([]);
  });
  it('协议字段级继承保留false和明确关闭', () => {
    expect(selectEffectiveCompat('Acme', 'Shared')).toEqual({
      thinkingFormat: 'openai',
      strictJsonSchema: false,
      cacheControlFormat: 'disabled',
    });
  });
});

describe('规范思考交接', () => {
  it('档位按共同词表排序，完整wire原文直接交给调用方', () => {
    expect(listThinkingOptions('Acme', 'Shared')).toEqual([
      { title: 'Low', wire: 'low', label: '低' },
      { title: 'XHigh', wire: ' wire ', label: '极高' },
      { title: 'Max', wire: 'max', label: '最大' },
    ]);
    expect(resolveThinkingHandoff('Acme', 'Shared', 'XHigh')).toMatchObject({
      supported: true,
      selectedTitle: 'XHigh',
      selectedWire: ' wire ',
      thinkingFormat: 'openai',
    });
  });
  it('未选不合成默认档；明确选不可用档必须报错', () => {
    expect(resolveThinkingHandoff('Acme', 'Shared', null)).toMatchObject({
      selectedTitle: null,
      selectedWire: null,
    });
    expect(() => resolveThinkingHandoff('Acme', 'Shared', 'High')).toThrow(
      '不支持'
    );
    expect(() => resolveThinkingHandoff('acme', 'Shared', 'Low')).toThrow(
      '未声明'
    );
    expect(isThinkingLevelAvailable('Custom', ['Custom'])).toBe(false);
  });
  it('非思考模型明确未选时保持不支持状态', () => {
    expect(resolveThinkingHandoff('acme', 'Shared', null)).toMatchObject({
      supported: false,
      thinking: undefined,
    });
  });
  it('resolveThinkingHandoffSafe 安全解析：不抛错且保持未选或不支持', () => {
    // 模型支持思考且命中档位
    expect(resolveThinkingHandoffSafe('Acme', 'Shared', 'XHigh')).toMatchObject({
      supported: true,
      selectedTitle: 'XHigh',
      selectedWire: ' wire ',
      thinkingFormat: 'openai',
    });
    // 模型支持思考，但传入不可用档位：不抛错，退化为未选引导
    expect(resolveThinkingHandoffSafe('Acme', 'Shared', 'High')).toMatchObject({
      supported: true,
      selectedTitle: null,
      selectedWire: null,
      thinkingFormat: 'openai',
    });
    // 模型未声明思考：不抛错，返回不支持
    expect(resolveThinkingHandoffSafe('acme', 'Shared', 'Low')).toMatchObject({
      supported: false,
      selectedTitle: null,
      selectedWire: null,
    });
    // 模型未声明思考且未选：返回不支持
    expect(resolveThinkingHandoffSafe('acme', 'Shared', null)).toMatchObject({
      supported: false,
      selectedTitle: null,
      selectedWire: null,
    });
  });
});
