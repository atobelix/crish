/**
 * modelsCatalogQuery.test.ts —— 只读门面投影契约
 *
 * 覆盖：
 * 1. pricing 投影只产出规范字段（input/output/cacheRead/cacheWrite/perImage），
 *    禁止旧名 *PerMTok 出现在投影对象上；
 * 2. contextLength 为只读兼容镜像（enumerable:false），JSON.stringify 不含该键；
 * 3. getPresetPricingList 兼容门面仍返回 *PerMTok 旧名（ModelPrice 契约）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  modelToCatalogSpec,
  setCatalogStateAccessor,
  listCatalogModels,
  findCatalogModel,
  getPresetPricingList,
  type CatalogModelSpec,
} from './modelsCatalogQuery';
import type {
  ModelsCatalogState,
  ProviderSpec,
} from './modelsCatalogTypes';
import { resetModelsCatalogMirror, ensureModelsCatalogLoaded } from './modelsCatalogStore';
import { mockTauriCommand } from '../test-setup';

const PROVIDER: ProviderSpec = {
  displayName: 'Acme',
  baseUrl: 'https://example.invalid/v1',
  protocol: 'openai/chat',
  models: [
    {
      id: 'acme-think',
      displayName: 'Acme Think',
      contextWindow: 128000,
      pricing: {
        currency: 'USD',
        input: 1.5,
        output: 4.5,
        cacheRead: 0.15,
        cacheWrite: 0.3,
      },
    },
    {
      id: 'legacy-alias',
      displayName: 'Legacy Alias',
      // 读边界：只有旧名别名，无规范键
      contextLength: 64000,
      pricing: {
        currency: 'USD',
        inputPerMTok: 3,
        outputPerMTok: 9,
        cacheReadPerMTok: 0.3,
        perImageCost: 4,
      },
    },
  ],
};

function makeState(): ModelsCatalogState {
  return {
    tree: { version: 2, providers: { acme: PROVIDER } },
    providerMap: new Map([['acme', PROVIDER]]),
    modelIndex: new Map(),
    globalModelIndex: new Map(),
    version: 1,
    loaded: true,
    filePath: 'test',
    lastError: null,
  };
}

describe('modelToCatalogSpec：pricing 投影只产出规范字段', () => {
  beforeEach(() => {
    resetModelsCatalogMirror();
  });

  it('规范键直通：投影含 input/output/cacheRead/cacheWrite，不含 *PerMTok 旧名', () => {
    const spec = modelToCatalogSpec('acme', PROVIDER, PROVIDER.models[0]!);
    expect(spec.pricing).toMatchObject({
      input: 1.5,
      output: 4.5,
      cacheRead: 0.15,
      cacheWrite: 0.3,
      currency: 'USD',
      billingUnit: 'token',
    });
    const pricingKeys = Object.keys(spec.pricing ?? {});
    expect(pricingKeys).not.toContain('inputPerMTok');
    expect(pricingKeys).not.toContain('outputPerMTok');
    expect(pricingKeys).not.toContain('cacheReadPerMTok');
    expect(pricingKeys).not.toContain('cacheWritePerMTok');
    expect(pricingKeys).not.toContain('perImageCost');
  });

  it('旧名别名读边界：只有 *PerMTok 时归一到规范键投影', () => {
    const spec = modelToCatalogSpec('acme', PROVIDER, PROVIDER.models[1]!);
    expect(spec.pricing).toMatchObject({
      input: 3,
      output: 9,
      cacheRead: 0.3,
      perImage: 4,
    });
    expect(Object.keys(spec.pricing ?? {})).not.toContain('inputPerMTok');
  });

  it('contextLength 只读镜像：getter 读到同一值，JSON.stringify 不含该键', () => {
    const spec = modelToCatalogSpec('acme', PROVIDER, PROVIDER.models[0]!);
    // getter 读兼容
    expect(spec.contextLength).toBe(128000);
    expect(spec.contextWindow).toBe(128000);
    // 双向 setter 仍对称（内存态）
    spec.contextLength = 200000;
    expect(spec.contextWindow).toBe(200000);
    // enumerable:false → serialize 禁止出现
    const json = JSON.stringify(spec);
    expect(json).toContain('contextWindow');
    expect(json).not.toContain('contextLength');
    expect(Object.keys(spec)).not.toContain('contextLength');
  });
});

describe('listCatalogModels / getPresetPricingList 门面契约', () => {
  beforeEach(async () => {
    resetModelsCatalogMirror();
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: 'C:\\Users\\tester\\.conex\\models.yaml',
      content: '',
      template: '',
      seeded: false,
      parseError: null,
      providers: { acme: PROVIDER },
    }));
    mockTauriCommand('workbench_save_models_yaml', () => ({
      path: 'C:\\Users\\tester\\.conex\\models.yaml',
    }));
    const ok = await ensureModelsCatalogLoaded(true);
    expect(ok.ok).toBe(true);
    // 防御：accessor 已由 store 注入；显式兜底以防 import 顺序漂移
    if (!listCatalogModels().length) {
      setCatalogStateAccessor(makeState);
    }
  });

  it('listCatalogModels：投影 pricing 为规范键，JSON 序列化无旧名', () => {
    const list = listCatalogModels();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const think = list.find((m) => m.model === 'acme-think');
    expect(think?.pricing?.input).toBe(1.5);
    const json = JSON.stringify(list);
    expect(json).not.toContain('inputPerMTok');
    expect(json).not.toContain('outputPerMTok');
  });

  it('getPresetPricingList：兼容门面返回 *PerMTok 旧名（ModelPrice 契约）', () => {
    const presets = getPresetPricingList();
    const think = presets.find((p) => p.model === 'acme-think');
    expect(think).toMatchObject({
      inputPerMTok: 1.5,
      outputPerMTok: 4.5,
      cacheReadPerMTok: 0.15,
      cacheWritePerMTok: 0.3,
      billingUnit: 'token',
    });
    // 旧名别名模型也被归一
    const legacy = presets.find((p) => p.model === 'legacy-alias');
    expect(legacy).toMatchObject({
      inputPerMTok: 3,
      outputPerMTok: 9,
      cacheReadPerMTok: 0.3,
    });
  });

  it('findCatalogModel：规范键投影 + contextLength 镜像可读', () => {
    const spec = findCatalogModel('acme-think', 'acme');
    expect(spec?.pricing?.input).toBe(1.5);
    expect(spec?.contextLength).toBe(128000);
    expect(Object.keys(spec?.pricing ?? {})).not.toContain('inputPerMTok');
  });
});

describe('CatalogModelSpec 类型面钉死：pricing 无旧名字段（编译期 + 运行时）', () => {
  it('投影对象上旧名字段均为 undefined（防回潮）', () => {
    const spec: CatalogModelSpec = modelToCatalogSpec('acme', PROVIDER, PROVIDER.models[0]!);
    // @ts-expect-error 旧名已从类型移除——运行时也应为 undefined
    expect(spec.pricing?.inputPerMTok).toBeUndefined();
    // @ts-expect-error 同上
    expect(spec.pricing?.outputPerMTok).toBeUndefined();
  });
});
