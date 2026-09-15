import { describe, expect, it } from 'vitest';
import { updateModel } from './modelsCatalogActions';
import {
  draftToModelPatch,
  modelSpecRevision,
  modelToConfigDraft,
} from './modelsDraftMap';
import type { ModelSpec, ModelsYamlTree } from './modelsCatalogTypes';

const MODEL: ModelSpec = {
  id: 'Shared',
  displayName: 'Original',
  enabled: true,
  order: 0,
  contextWindow: 200000,
  maxOutputTokens: 8192,
  protocol: 'openai/responses',
  supportsTools: false,
  cacheTtl: '30m',
  headers: { 'X-Model-Setting': 'exact value' },
  compat: {
    thinkingFormat: 'openai',
    strictJsonSchema: false,
    supportsDeveloperRole: false,
    cacheControlFormat: 'disabled',
    maxTokensField: 'max_completion_tokens',
  },
  thinking: { Low: 'low', XHigh: '  exact-wire  ' },
  modalities: { input: ['text', 'pdf'], output: [] },
  pricing: {
    currency: 'USD',
    unit: 'per_image',
    input: 0,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0.3,
    perImage: 0.08,
    tiers: [
      {
        inputTokensAbove: 100,
        input: 4,
        output: 8,
        cacheRead: 0,
        cacheWrite: 1,
      },
      { inputTokensAbove: 200, cacheWrite: 0 },
    ],
  },
};
const TREE: ModelsYamlTree = {
  version: 2,
  activeModel: null,
  providers: {
    Acme: {
      protocol: 'openai/chat',
      enabled: true,
      stream: false,
      models: [MODEL],
    },
  },
};

describe('完整模型草稿往返', () => {
  it('只修改显示名时所有其它公开字段完全不变', () => {
    const draft = modelToConfigDraft(MODEL);
    draft.displayName = 'Changed';
    const saved = updateModel(TREE, 'Acme', 'Shared', draftToModelPatch(draft))
      .providers.Acme!.models[0];
    expect(saved).toEqual({ ...MODEL, displayName: 'Changed' });
    expect(saved?.pricing?.tiers?.[1]).not.toHaveProperty('input');
    expect(saved?.headers).toEqual(MODEL.headers);
  });
  it('仅按图计价、仅阶梯计价和零价格均无损且不补输入输出价', () => {
    for (const pricing of [
      { currency: 'USD' as const, unit: 'per_image' as const, perImage: 0 },
      {
        currency: 'CNY' as const,
        tiers: [{ inputTokensAbove: 0, cacheRead: 0 }],
      },
    ]) {
      const model = { ...MODEL, pricing };
      expect(draftToModelPatch(modelToConfigDraft(model)).pricing).toEqual(
        pricing
      );
    }
  });
  it('缺省能力、价格、模态、协议不被构造出来', () => {
    const bare: ModelSpec = { id: 'Bare', enabled: true };
    const draft = modelToConfigDraft(bare);
    const tree = {
      ...TREE,
      providers: { Acme: { ...TREE.providers.Acme!, models: [bare] } },
    };
    expect(
      updateModel(tree, 'Acme', 'Bare', draftToModelPatch(draft)).providers
        .Acme!.models[0]
    ).toEqual(bare);
    for (const key of [
      'caps',
      'contextLength',
      'thinkingLevel',
      'defaultThinkingLevel',
    ])
      expect(draft).not.toHaveProperty(key);
  });
  it('草稿与原模型的对象不共享可变引用', () => {
    const draft = modelToConfigDraft(MODEL);
    draft.headers!['X-Model-Setting'] = 'changed';
    draft.modalities!.input.push('image');
    draft.pricing!.tiers![0]!.input = '99';
    expect(MODEL.headers!['X-Model-Setting']).toBe('exact value');
    expect(MODEL.modalities!.input).toEqual(['text', 'pdf']);
    expect(MODEL.pricing!.tiers![0]!.input).toBe(4);
  });
});

describe('删除、关闭和缺省分别表达', () => {
  it('未触及字段不进入补丁；明确清空才删除', () => {
    const untouched = updateModel(
      TREE,
      'Acme',
      'Shared',
      draftToModelPatch({ displayName: 'Only name' })
    );
    expect(untouched.providers.Acme!.models[0]?.contextWindow).toBe(
      MODEL.contextWindow
    );
    const patch = draftToModelPatch({
      contextWindow: '',
      maxOutputTokens: '',
      pricing: undefined,
      thinkingEnabled: false,
      protocol: undefined,
      headers: undefined,
    });
    expect(Object.hasOwn(patch, 'contextWindow')).toBe(true);
    const saved = updateModel(TREE, 'Acme', 'Shared', patch).providers.Acme!
      .models[0]!;
    for (const key of [
      'contextWindow',
      'maxOutputTokens',
      'pricing',
      'thinking',
      'protocol',
      'headers',
    ])
      expect(saved).not.toHaveProperty(key);
  });
  it('0费率、0排序和false不会被当作缺省', () => {
    expect(
      draftToModelPatch({
        order: '0',
        enabled: false,
        supportsTools: false,
        pricing: { currency: 'USD', input: '0', perImage: '0' },
      })
    ).toMatchObject({
      order: 0,
      enabled: false,
      supportsTools: false,
      pricing: { input: 0, perImage: 0 },
    });
    expect(draftToModelPatch({ order: '-3' }).order).toBe(-3);
  });
  it('清空某价格维度不清空币种、单位和其它费率', () => {
    const draft = modelToConfigDraft(MODEL);
    draft.pricing!.input = '';
    const saved = draftToModelPatch(draft).pricing!;
    expect(saved).not.toHaveProperty('input');
    expect(saved.unit).toBe('per_image');
    expect(saved.perImage).toBe(0.08);
    expect(saved.tiers).toEqual(MODEL.pricing!.tiers);
  });
});

/**
 * 用户裁决「模型字典只做参考，实际以用户配置为准」的落库安全点：
 * 编辑已有模型时补丁不含 pricing，树中原有 pricing 必须原样保留。
 * 钉死 updateModel 的合并语义，防止日后改成「全量替换」把用户价格清掉
 * （ModelList 的启用/停用开关就只发 `{ enabled }`）。
 */
describe('updateModel 合并语义：缺省键不动', () => {
  it('补丁不含 pricing → 树中原有 pricing 逐字段保持不变', () => {
    const saved = updateModel(TREE, 'Acme', 'Shared', { displayName: 'Only' })
      .providers.Acme!.models[0]!;
    expect(saved.pricing).toEqual(MODEL.pricing);
    expect(saved.pricing).not.toBeUndefined();
    expect(saved.displayName).toBe('Only');
  });

  it('补丁不含 pricing → 其它未触及字段也全部保持（含 tiers 与 headers）', () => {
    const saved = updateModel(TREE, 'Acme', 'Shared', { enabled: false })
      .providers.Acme!.models[0]!;
    expect(saved.pricing).toEqual(MODEL.pricing);
    expect(saved.pricing!.tiers).toEqual(MODEL.pricing!.tiers);
    expect(saved.headers).toEqual(MODEL.headers);
    expect(saved.contextWindow).toBe(MODEL.contextWindow);
  });

  it('树中本来无 pricing 时，缺省键不会凭空造出 pricing', () => {
    const bare: ModelSpec = { id: 'Bare', enabled: true };
    const tree = {
      ...TREE,
      providers: { Acme: { ...TREE.providers.Acme!, models: [bare] } },
    };
    const saved = updateModel(tree, 'Acme', 'Bare', { displayName: 'N' })
      .providers.Acme!.models[0]!;
    expect(Object.hasOwn(saved, 'pricing')).toBe(false);
  });

  it('明确 pricing: undefined 仍表达删除（区分「不动」与「清空」）', () => {
    const saved = updateModel(TREE, 'Acme', 'Shared', { pricing: undefined })
      .providers.Acme!.models[0]!;
    expect(Object.hasOwn(saved, 'pricing')).toBe(false);
  });

  it('补丁含 pricing 时整体替换（不做嵌套逐字段合并，故「清空某维度」生效）', () => {
    const saved = updateModel(TREE, 'Acme', 'Shared', {
      pricing: { currency: 'USD', output: 2 },
    }).providers.Acme!.models[0]!;
    expect(saved.pricing).toEqual({ currency: 'USD', output: 2 });
    // 原有 input / tiers 随整体替换消失：这是刻意语义，不是缺陷
    expect(saved.pricing).not.toHaveProperty('input');
    expect(saved.pricing).not.toHaveProperty('tiers');
  });
});

describe('无猜测输入验证', () => {
  it.each([
    '-1.5',
    '1e3',
    '128k',
    '9007199254740993',
    '0',
    '-1',
    'NaN',
    'Infinity',
  ])('窗口非法值必须明确失败，不能改写为其它整数：%s', (raw) => {
    expect(() => draftToModelPatch({ contextWindow: raw })).toThrow();
    expect(() => draftToModelPatch({ maxOutputTokens: raw })).toThrow();
  });
  it.each(['-0.1', 'NaN', 'Infinity', '0x10', 'free'])(
    '非法价格不静默删字段：%s',
    (raw) => {
      expect(() =>
        draftToModelPatch({ pricing: { currency: 'USD', input: raw } })
      ).toThrow();
    }
  );
  it('小数价格和科学计数价格按原值解析，不使用倍率', () => {
    expect(
      draftToModelPatch({
        pricing: {
          currency: 'CNY',
          input: '0.99',
          cacheRead: '0.08',
          perImage: '1e-6',
        },
      }).pricing
    ).toEqual({
      currency: 'CNY',
      input: 0.99,
      cacheRead: 0.08,
      perImage: 0.000001,
    });
  });
  it('思考只归一合法键，原wire包含空白也原样保留', () => {
    expect(
      draftToModelPatch({
        thinkingEnabled: true,
        thinkingMap: { 'X-High': ' wire ' },
      }).thinking
    ).toEqual({ XHigh: ' wire ' });
    for (const map of [
      { Custom: 'wire' },
      { Off: 'off', None: 'none' },
      { High: '' },
    ])
      expect(() =>
        draftToModelPatch({ thinkingEnabled: true, thinkingMap: map })
      ).toThrow();
  });
});

describe('完整语义修订', () => {
  it('对象键顺序不改变修订', () => {
    expect(
      modelSpecRevision({
        ...MODEL,
        thinking: { XHigh: '  exact-wire  ', Low: 'low' },
      })
    ).toBe(modelSpecRevision(MODEL));
  });
  it.each([
    { headers: { 'X-Model-Setting': 'new' } },
    { cacheTtl: '1h' as const },
    { supportsTools: true },
    { enabled: false },
    { order: -1 },
    { compat: { ...MODEL.compat, strictJsonSchema: true } },
    { pricing: { ...MODEL.pricing!, unit: 'token' as const } },
    { pricing: { ...MODEL.pricing!, perImage: 0 } },
    {
      pricing: {
        ...MODEL.pricing!,
        tiers: [{ inputTokensAbove: 100, input: 99 }],
      },
    },
  ])('任何完整配置字段的修改都改变修订：%j', (change) => {
    expect(modelSpecRevision({ ...MODEL, ...change })).not.toBe(
      modelSpecRevision(MODEL)
    );
  });
});
