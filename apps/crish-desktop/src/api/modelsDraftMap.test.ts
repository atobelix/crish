/**
 * modelsDraftMap.test.ts —— T2-1 草稿映射纯函数
 *
 * 不 mock IPC。钉：规范键、空价省略、思考关闭省略、Google 协议归一、
 * 窗口只写 contextWindow、cacheRead 原样、不发明默认窗口。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { updateModel } from './modelsCatalogActions';
import { serializeModelsYamlTree } from './modelsCatalogIpc';
import type { ModelSpec, ModelsYamlTree, ProviderSpec } from './modelsCatalogTypes';
import {
  canonicalizeProtocol,
  draftToModelPatch,
  modelSpecRevision,
  modelToConfigDraft,
  type ModelConfigDraft,
} from './modelsDraftMap';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'modelsDraftMap.ts'),
  'utf8'
);

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function forbiddenYamlKeys(text: string): void {
  expect(text).not.toMatch(/contextLength\s*:/);
  expect(text).not.toContain('defaultThinkingLevel');
  expect(text).not.toContain('inputPerMTok');
  expect(text).not.toContain('google/interactions');
  expect(text).not.toMatch(/^\s*levels\s*:/m);
}

const BASE_DRAFT: ModelConfigDraft = {
  displayName: 'Acme Think',
  contextLength: '200000',
  maxOutputTokens: '8192',
  caps: { tools: true, image: true, video: false, reasoning: true },
  thinkingLevel: 'High',
  defaultThinkingLevel: 'Medium',
  protocol: 'google/interactions',
  modalities: { input: ['text', 'image'], output: ['text'] },
  thinkingEnabled: true,
  thinkingMap: { Low: 'low', CustomUltra: 'ultra_wire' },
  pricing: {
    currency: 'CNY',
    input: '0.99',
    output: '2.8',
    cacheRead: '0.08',
    cacheWrite: '0.16',
  },
};

const SEED_TREE: ModelsYamlTree = {
  version: 2,
  providers: {
    acme: {
      displayName: 'Acme',
      baseUrl: 'https://example.invalid/v1',
      protocol: 'openai/chat',
      models: [{ id: 'acme-think', displayName: 'old' }],
    },
  },
};

describe('draftToModelPatch', () => {
  it('写出规范键：contextWindow / thinking / modalities / cacheRead / 归一协议', () => {
    const patch = draftToModelPatch(BASE_DRAFT);
    expect(patch.displayName).toBe('Acme Think');
    expect(patch.contextWindow).toBe(200000);
    expect(patch.maxOutputTokens).toBe(8192);
    expect(patch.capabilities).toEqual({ tools: true });
    expect(patch.thinking).toEqual({ Low: 'low', CustomUltra: 'ultra_wire' });
    expect(patch.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
    expect(patch.pricing).toEqual({
      currency: 'CNY',
      input: 0.99,
      output: 2.8,
      cacheRead: 0.08,
      cacheWrite: 0.16,
    });
    expect(patch.protocol).toBe('google/generate-content');
    expect(hasOwn(patch, 'contextLength')).toBe(false);
    expect(hasOwn(patch, 'thinkingLevel')).toBe(false);
    expect(hasOwn(patch, 'defaultThinkingLevel')).toBe(false);
    expect(hasOwn(patch, 'inputPerMTok')).toBe(false);
    const json = JSON.stringify(patch);
    expect(json).not.toContain('contextLength');
    expect(json).not.toContain('defaultThinkingLevel');
    expect(json).not.toContain('"thinkingLevel"');
    expect(json).not.toContain('inputPerMTok');
    expect(json).not.toContain('google/interactions');
  });

  it('四维皆空 → pricing undefined，禁止写全 0', () => {
    const patch = draftToModelPatch({
      ...BASE_DRAFT,
      pricing: {
        currency: 'USD',
        input: '',
        output: '  ',
        cacheRead: undefined,
        cacheWrite: '',
      },
    });
    expect(hasOwn(patch, 'pricing')).toBe(true);
    expect(patch.pricing).toBeUndefined();
    expect(JSON.stringify(patch)).not.toContain('"input":0');
  });

  it('只填 cacheRead 时原样写出该维，不按 input×0.1 补', () => {
    const patch = draftToModelPatch({
      ...BASE_DRAFT,
      pricing: {
        currency: 'USD',
        input: '0.99',
        output: '',
        cacheRead: '0.08',
        cacheWrite: '',
      },
    });
    expect(patch.pricing).toEqual({
      currency: 'USD',
      input: 0.99,
      cacheRead: 0.08,
    });
    expect(patch.pricing?.cacheRead).toBe(0.08);
    expect(patch.pricing?.cacheRead).not.toBeCloseTo(0.99 * 0.1);
    expect(hasOwn(patch.pricing ?? {}, 'output')).toBe(false);
    expect(hasOwn(patch.pricing ?? {}, 'cacheWrite')).toBe(false);
  });

  it('思考关闭 → thinking undefined（键在 patch 上，值为缺省）', () => {
    const patch = draftToModelPatch({
      ...BASE_DRAFT,
      thinkingEnabled: false,
      thinkingMap: { Low: 'low', Medium: 'medium', High: 'high' },
    });
    expect(hasOwn(patch, 'thinking')).toBe(true);
    expect(patch.thinking).toBeUndefined();
  });

  it('思考开启但清洗后为空 → 不写空对象', () => {
    const patch = draftToModelPatch({
      ...BASE_DRAFT,
      thinkingEnabled: true,
      thinkingMap: { '  ': '  ', Low: '' },
    });
    expect(patch.thinking).toBeUndefined();
    expect(JSON.stringify(patch.thinking ?? {})).toBe('{}');
  });

  it('思考映射丢掉空键空值，保留拍平字典', () => {
    const patch = draftToModelPatch({
      ...BASE_DRAFT,
      thinkingEnabled: true,
      thinkingMap: { Low: 'low', ' ': 'x', High: '  high  ', Empty: '' },
    });
    expect(patch.thinking).toEqual({ Low: 'low', High: 'high' });
  });

  it('未声明 thinkingEnabled 时不碰 thinking', () => {
    const { thinkingEnabled: _te, thinkingMap: _tm, ...rest } = BASE_DRAFT;
    const patch = draftToModelPatch(rest);
    expect(hasOwn(patch, 'thinking')).toBe(false);
  });

  it('空展示名 → displayName undefined；非法窗口不写 contextWindow', () => {
    const patch = draftToModelPatch({
      displayName: '   ',
      contextLength: '',
      maxOutputTokens: 'abc',
    });
    expect(hasOwn(patch, 'displayName')).toBe(true);
    expect(patch.displayName).toBeUndefined();
    expect(hasOwn(patch, 'contextWindow')).toBe(false);
    expect(hasOwn(patch, 'maxOutputTokens')).toBe(false);
    expect(hasOwn(patch, 'contextLength')).toBe(false);
  });

  it('modalities 原样，不偷偷加回 text', () => {
    const patch = draftToModelPatch({
      modalities: { input: ['image'], output: [] },
    });
    expect(patch.modalities).toEqual({ input: ['image'], output: [] });
  });

  it('规范协议原样通过', () => {
    expect(draftToModelPatch({ protocol: 'openai/chat' }).protocol).toBe(
      'openai/chat'
    );
    expect(draftToModelPatch({ protocol: 'openai/responses' }).protocol).toBe(
      'openai/responses'
    );
    expect(draftToModelPatch({ protocol: 'anthropic/messages' }).protocol).toBe(
      'anthropic/messages'
    );
    expect(
      draftToModelPatch({ protocol: 'google/generate-content' }).protocol
    ).toBe('google/generate-content');
  });
});

describe('canonicalizeProtocol', () => {
  it('google/interactions → google/generate-content', () => {
    expect(canonicalizeProtocol('google/interactions')).toBe(
      'google/generate-content'
    );
    expect(canonicalizeProtocol('not-a-protocol')).toBeUndefined();
  });
});

describe('modelToConfigDraft', () => {
  const model: ModelSpec = {
    id: 'acme-think',
    displayName: 'Acme Think',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    protocol: 'google/interactions',
    thinking: { Low: 'low', CustomUltra: 'ultra_wire' },
    modalities: { input: ['text', 'image'], output: ['text'] },
    pricing: {
      currency: 'CNY',
      input: 0.99,
      output: 2.8,
      cacheRead: 0.08,
      cacheWrite: 0.16,
    },
    capabilities: { tools: true },
    enabled: true,
  };

  const provider: ProviderSpec = {
    displayName: 'Acme',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai/chat',
    models: [model],
  };

  it('窗口来自 contextWindow，不读 contextLength，不填默认窗口', () => {
    const draft = modelToConfigDraft({
      id: 'x',
      contextLength: 999999,
    });
    expect(draft.contextLength).toBe('');
    expect(modelToConfigDraft(model).contextLength).toBe('200000');
  });

  it('无 modalities 时不默认 text/image', () => {
    const draft = modelToConfigDraft({ id: 'plain' });
    expect(draft.modalities).toBeUndefined();
    expect(draft.caps?.image).toBe(false);
    expect(draft.caps?.video).toBe(false);
  });

  it('无 thinking 字典时思考区关闭，不因 capabilities.reasoning 打开', () => {
    const draft = modelToConfigDraft({
      id: 'x',
      capabilities: { reasoning: true, tools: true },
    });
    expect(draft.thinkingEnabled).toBe(false);
    expect(draft.thinkingMap).toEqual({});
    expect(draft.caps?.reasoning).toBe(false);
  });

  it('价格来自 input 等规范键，不读 inputPerMTok', () => {
    const draft = modelToConfigDraft({
      id: 'x',
      pricing: {
        currency: 'USD',
        inputPerMTok: 3,
        outputPerMTok: 9,
        cacheReadPerMTok: 0.3,
      },
    });
    expect(draft.pricing).toEqual({
      currency: 'USD',
      input: '',
      output: '',
      cacheRead: '',
      cacheWrite: '',
    });
  });

  it('不把 provider.protocol 抄进草稿', () => {
    const draft = modelToConfigDraft({ id: 'x' }, provider);
    expect(draft.protocol).toBeUndefined();
  });

  it('模型级 google/interactions 打开时已归一', () => {
    const draft = modelToConfigDraft(model, provider);
    expect(draft.protocol).toBe('google/generate-content');
    expect(draft.thinkingEnabled).toBe(true);
    expect(draft.thinkingMap).toEqual({
      Low: 'low',
      CustomUltra: 'ultra_wire',
    });
    expect(draft.pricing?.cacheRead).toBe('0.08');
    expect(draft.caps?.image).toBe(true);
  });

  it('不写出 thinkingLevel / defaultThinkingLevel', () => {
    const draft = modelToConfigDraft(model);
    expect(draft.thinkingLevel).toBeUndefined();
    expect(draft.defaultThinkingLevel).toBeUndefined();
  });
});

describe('modelSpecRevision', () => {
  const base: ModelSpec = {
    id: 'm',
    displayName: 'M',
    contextWindow: 1000,
    maxOutputTokens: 10,
    enabled: true,
    protocol: 'openai/chat',
    thinking: { High: 'high', Low: 'low' },
    modalities: { input: ['text'], output: ['text'] },
    pricing: { currency: 'USD', input: 1, output: 2, cacheRead: 0.08 },
    capabilities: { tools: true },
  };

  it('签名含要求字段；thinking 键序不影响稳定性', () => {
    const a = modelSpecRevision(base);
    const b = modelSpecRevision({
      ...base,
      thinking: { Low: 'low', High: 'high' },
    });
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      displayName: 'M',
      contextWindow: 1000,
      maxOutputTokens: 10,
      enabled: true,
      protocol: 'openai/chat',
      tools: true,
    });
    expect(parsed.thinking).toEqual({ High: 'high', Low: 'low' });
    expect(parsed.modalities).toEqual({ input: ['text'], output: ['text'] });
    expect(parsed.pricing).toMatchObject({
      currency: 'USD',
      input: 1,
      cacheRead: 0.08,
    });
  });

  it('thinking / pricing / tools 变化会改签名', () => {
    const r0 = modelSpecRevision(base);
    expect(
      modelSpecRevision({ ...base, thinking: { Low: 'other' } })
    ).not.toBe(r0);
    expect(
      modelSpecRevision({
        ...base,
        pricing: { ...base.pricing!, cacheRead: 0.09 },
      })
    ).not.toBe(r0);
    expect(
      modelSpecRevision({ ...base, capabilities: { tools: false } })
    ).not.toBe(r0);
  });

  it('缺窗口时签名为 null，不发明默认窗口', () => {
    const parsed = JSON.parse(
      modelSpecRevision({ id: 'bare' })
    ) as { contextWindow: unknown };
    expect(parsed.contextWindow).toBeNull();
  });

  it('google/interactions 与 generate-content 同一签名', () => {
    expect(
      modelSpecRevision({ id: 'g', protocol: 'google/interactions' })
    ).toBe(
      modelSpecRevision({ id: 'g', protocol: 'google/generate-content' })
    );
  });
});

describe('往返与 yaml 文本', () => {
  it('model → draft → patch 保留规范字段', () => {
    const model: ModelSpec = {
      id: 'acme-think',
      displayName: 'Acme Think',
      contextWindow: 1048576,
      thinking: { Low: 'low' },
      modalities: { input: ['image'], output: ['text'] },
      pricing: { currency: 'CNY', input: 0.99, cacheRead: 0.08 },
      capabilities: { tools: false },
      protocol: 'anthropic/messages',
    };
    const patch = draftToModelPatch(modelToConfigDraft(model));
    expect(patch.contextWindow).toBe(1048576);
    expect(patch.thinking).toEqual({ Low: 'low' });
    expect(patch.modalities?.input).toEqual(['image']);
    expect(patch.pricing?.cacheRead).toBe(0.08);
    expect(patch.pricing?.cacheRead).not.toBeCloseTo(0.99 * 0.1);
    expect(patch.protocol).toBe('anthropic/messages');
    expect(patch.capabilities?.tools).toBe(false);
    expect(hasOwn(patch, 'contextLength')).toBe(false);
  });

  it('保存补丁接到 serialize 后 yaml 含规范键、不含禁键', () => {
    const next = updateModel(
      SEED_TREE,
      'acme',
      'acme-think',
      draftToModelPatch(BASE_DRAFT)
    );
    const yaml = serializeModelsYamlTree(next);
    expect(yaml).toContain('thinking:');
    expect(yaml).toContain('Low: low');
    expect(yaml).toContain('CustomUltra: ultra_wire');
    expect(yaml).toContain('modalities:');
    expect(yaml).toMatch(/input:\s*\n\s*- text\s*\n\s*- image/);
    expect(yaml).toContain('cacheRead: 0.08');
    expect(yaml).toContain('contextWindow: 200000');
    expect(yaml).toContain('protocol: google/generate-content');
    expect(yaml).toContain('currency: CNY');
    forbiddenYamlKeys(yaml);
    expect(yaml).not.toContain('0.099');
  });

  it('关掉思考 + 空价后 yaml 无 thinking / pricing 键', () => {
    const withFields = updateModel(
      SEED_TREE,
      'acme',
      'acme-think',
      draftToModelPatch(BASE_DRAFT)
    );
    const cleared = updateModel(
      withFields,
      'acme',
      'acme-think',
      draftToModelPatch({
        ...BASE_DRAFT,
        thinkingEnabled: false,
        thinkingMap: { Low: 'low' },
        pricing: { currency: 'CNY', input: '', output: '', cacheRead: '', cacheWrite: '' },
      })
    );
    const yaml = serializeModelsYamlTree(cleared);
    expect(yaml).not.toContain('thinking:');
    expect(yaml).not.toContain('pricing:');
    expect(yaml).toContain('contextWindow: 200000');
    forbiddenYamlKeys(yaml);
  });

  it('未填窗口时 patch 省略 contextWindow，updateModel 保留原值', () => {
    const seeded: ModelsYamlTree = {
      version: 2,
      providers: {
        acme: {
          displayName: 'Acme',
          baseUrl: 'https://example.invalid/v1',
          protocol: 'openai/chat',
          models: [{ id: 'acme-think', contextWindow: 777 }],
        },
      },
    };
    const next = updateModel(
      seeded,
      'acme',
      'acme-think',
      draftToModelPatch({ displayName: 'N', contextLength: '' })
    );
    expect(next.providers.acme?.models[0]?.contextWindow).toBe(777);
    const yaml = serializeModelsYamlTree(next);
    expect(yaml).toContain('contextWindow: 777');
    expect(yaml).not.toMatch(/contextLength\s*:/);
  });
});

describe('源码形状', () => {
  it('映射模块不碰 LS / 价表 / 猜测窗口 / 缓存一折', () => {
    expect(SRC).not.toMatch(/\blocalStorage\s*[.[]/);
    expect(SRC).not.toMatch(/\bupsertPrice\s*\(/);
    expect(SRC).not.toMatch(/\bguessContextLength\s*\(/);
    expect(SRC).not.toMatch(/\bgetModelMeta\s*\(/);
    expect(SRC).not.toMatch(/\bDEFAULT_CACHE_READ_MULTIPLIER\b/);
    expect(SRC).not.toMatch(/\b128[_]?000\b/);
    expect(SRC).not.toMatch(/\*\s*0\.1/);
    expect(SRC).not.toMatch(/from ['"][^'"]*pricingStore['"]/);
    expect(SRC).not.toMatch(/from ['"][^'"]*modelCatalog['"]/);
  });
});
