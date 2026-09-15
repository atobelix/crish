import { beforeEach, describe, expect, it } from 'vitest';
import { createCatalogQueries } from './modelsCatalogQuery';
import { modelRefKey } from './modelsCatalogTypes';
import type {
  IndexedModelEntry,
  ModelsCatalogState,
  ProviderSpec,
} from './modelsCatalogTypes';

const priced: ProviderSpec = {
  protocol: 'openai/chat',
  stream: true,
  enabled: true,
  displayName: 'Shared vendor',
  models: [
    {
      id: 'Shared',
      enabled: true,
      pricing: {
        currency: 'USD',
        unit: 'per_image',
        perImage: 0,
        tiers: [{ inputTokensAbove: 100, input: 2 }],
      },
    },
  ],
};
let state: ModelsCatalogState;
const queries = createCatalogQueries(() => state);

beforeEach(() => {
  const entries: IndexedModelEntry[] = [
    { providerId: 'Acme', provider: priced, model: priced.models[0]! },
    {
      providerId: 'acme',
      provider: { ...priced, displayName: 'Other' },
      model: { id: 'Shared', enabled: true },
    },
  ];
  state = {
    tree: { version: 2, activeModel: null, providers: {} },
    modelIndex: new Map(
      entries.map((entry) => [
        modelRefKey({ providerId: entry.providerId, modelId: entry.model.id }),
        entry,
      ])
    ),
    providerMap: new Map(
      entries.map((entry) => [entry.providerId, entry.provider])
    ),
    revision: 'r1',
    credentialStates: {},
    version: 1,
    loaded: true,
    filePath: 'test',
    lastError: null,
    warning: null,
  };
});

describe('完整目录查询', () => {
  it('条目保留供应商身份与全部模型字段，不生成旧投影', () => {
    const entry = queries.findCatalogModel(' Shared ', ' Acme ');
    expect(entry?.providerId).toBe('Acme');
    expect(entry?.model.pricing).toEqual(priced.models[0]?.pricing);
    expect(entry).not.toHaveProperty('contextLength');
    expect(entry).not.toHaveProperty('vendor');
    expect(entry?.model.pricing).not.toHaveProperty('billingUnit');
  });
  it('大小写不同的供应商和错误模型不会补配', () => {
    expect(
      queries.findCatalogModel('Shared', 'acme')?.model.pricing
    ).toBeUndefined();
    expect(queries.findCatalogModel('Shared', 'ACME')).toBeUndefined();
    expect(queries.findCatalogModel('shared', 'Acme')).toBeUndefined();
    expect(queries.findCatalogModel('Shared', '')).toBeUndefined();
  });
  it('索引未命中不扫描供应商列表补配', () => {
    state = { ...state, modelIndex: new Map() };
    expect(queries.findCatalogModel('Shared', 'Acme')).toBeUndefined();
  });
  it('文本搜索忽略大小写，明确供应商过滤不得溢出到其它身份', () => {
    expect(queries.searchCatalogModels('shared')).toHaveLength(2);
    expect(
      queries
        .searchCatalogModels('shared', 'Acme')
        .map((entry) => entry.providerId)
    ).toEqual(['Acme']);
    expect(queries.searchCatalogModels('shared', 'ACME')).toEqual([]);
  });
  it('未加载时不把上次缓存伪装成可用目录', () => {
    state = { ...state, loaded: false };
    expect(queries.listCatalogModels()).toEqual([]);
    expect(queries.findCatalogModel('Shared', 'Acme')).toBeUndefined();
  });
});
