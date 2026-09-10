/**
 * modelsCatalogStore.test.ts —— Provider-Centric 树状单源 Store 自动化测试套件
 *
 * 覆盖矩阵：
 * 1. 读 IPC 只认 workbench_read_models_yaml 的 providers；缺 providers 则 loaded=false
 * 2. fail-closed：命令缺失 / 解析失败 → loaded=false，不覆盖成功快照，拒绝写盘
 * 3. 合法空 providers:{} → loaded=true，允许后续写
 * 4. updateModel spread 保留 thinking/modalities/pricing，serialize 含 SSOT 键
 * 5. 树状索引、协议继承、思考字典、增量探测、四维算费、写盘回滚、魔鬼边界
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockTauriCommand,
  mockTauriError,
} from '../test-setup';
import { onUiEvent } from './uiEvents';
import {
  modelsCatalogStore,
  addProvider,
  updateProvider,
  removeProvider,
  addModel,
  updateModel,
  removeModel,
  selectProvider,
  selectModel,
  selectModelGlobally,
  selectEffectiveProtocol,
  selectEffectiveContextWindow,
  selectSupportsThinking,
  selectThinkingLevelsMap,
  selectEstimatedCost,
  ensureModelsCatalogLoaded,
  findCatalogModel,
  getPresetPricingList,
  getModelsCatalogVersion,
  listCatalogModels,
  resetModelsCatalogMirror,
  searchCatalogModels,
} from './modelsCatalogStore';
import { serializeModelsYamlTree } from './modelsCatalogIpc';
import { createSelectors } from './modelsCatalogSelectors';
import { AUTOFILL_BASELINE_2026 } from './modelsAutofillBaseline';
import { applyIncrementalProbe, pureIncrementalProbe } from './probeIncremental';
import type { ModelsCatalogState, ModelsYamlTree, ProviderSpec, ModelSpec } from './modelsCatalogTypes';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

const ACME_THINK: ModelSpec = {
  id: 'acme-think',
  displayName: 'Acme Think',
  contextWindow: 128000,
  thinking: { Low: 'low', High: 'high' },
  modalities: { input: ['text', 'image'], output: ['text'] },
  pricing: {
    currency: 'USD',
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 0.2,
  },
};

const ACME_PROVIDERS: Record<string, ProviderSpec> = {
  acme: {
    displayName: 'Acme',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai/chat',
    apiKey: '$ACME_API_KEY',
    models: [ACME_THINK],
  },
};

const YAML_PROVIDERS: Record<string, ProviderSpec> = {
  zai: {
    displayName: '智谱 BigModel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai/chat',
    models: [
      {
        id: 'glm-5.3',
        displayName: 'GLM-5.3',
        contextWindow: 1048576,
        maxOutputTokens: 262144,
        protocol: 'openai/chat',
        capabilities: { tools: true, reasoning: true },
        pricing: {
          currency: 'USD',
          input: 1.4,
          output: 4.4,
          cacheRead: 0.14,
        },
      },
    ],
  },
  moonshotai: {
    displayName: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai/chat',
    models: [
      {
        id: 'kimi-k3',
        displayName: 'Kimi K3',
        contextWindow: 1048576,
        maxOutputTokens: 943718,
        capabilities: { tools: true, image: true, video: true },
        pricing: {
          currency: 'USD',
          input: 3.0,
          output: 15.0,
        },
      },
    ],
  },
};

function baselineProviders(): Record<string, ProviderSpec> {
  return AUTOFILL_BASELINE_2026.providers as unknown as Record<string, ProviderSpec>;
}

/** Rust 读命令载荷：只给 providers。禁止用 tree 当成功源夹具。 */
function workbenchReadOk(
  providers: Record<string, ProviderSpec>,
  extra: Record<string, unknown> = {}
) {
  return {
    path: CATALOG_PATH,
    content: '',
    template: '',
    seeded: false,
    parseError: null,
    providers,
    ...extra,
  };
}

function mockReadOk(providers: Record<string, ProviderSpec>): void {
  mockTauriCommand('workbench_read_models_yaml', () => workbenchReadOk(providers));
}

function mockSaveOk(): ReturnType<typeof vi.fn> {
  const impl = vi.fn((_args: unknown) => ({ path: CATALOG_PATH }));
  mockTauriCommand('workbench_save_models_yaml', impl);
  return impl;
}

function savedYaml(saveImpl: ReturnType<typeof vi.fn>): string {
  const args = saveImpl.mock.calls[0]?.[0] as { content?: string } | undefined;
  return args?.content ?? '';
}

function lastSavedYaml(saveImpl: ReturnType<typeof vi.fn>): string {
  const calls = saveImpl.mock.calls;
  const args = calls[calls.length - 1]?.[0] as { content?: string } | undefined;
  return args?.content ?? '';
}

async function loadProviders(providers: Record<string, ProviderSpec>): Promise<void> {
  mockReadOk(providers);
  mockSaveOk();
  const res = await ensureModelsCatalogLoaded(true);
  expect(res).toEqual({ ok: true, path: CATALOG_PATH });
  expect(modelsCatalogStore.getState().loaded).toBe(true);
}

describe('modelsCatalogStore（字典镜像，真源 = ~/.conex/models.yaml）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelsCatalogMirror();
  });

  it('加载成功：从 providers 灌入镜像 + 版本自增 + 广播 models-catalog-changed', async () => {
    mockReadOk(YAML_PROVIDERS);
    let changeCount = 0;
    const off = onUiEvent('models-catalog-changed', () => {
      changeCount += 1;
    });

    const res = await ensureModelsCatalogLoaded(true);
    off();

    expect(res).toEqual({ ok: true, path: CATALOG_PATH });
    expect(modelsCatalogStore.getState().loaded).toBe(true);
    expect(listCatalogModels()).toHaveLength(2);
    expect(changeCount).toBe(1);
  });

  it('幂等单飞：并发与重复调用只打一次 IPC', async () => {
    const impl = vi.fn(() => workbenchReadOk(YAML_PROVIDERS));
    mockTauriCommand('workbench_read_models_yaml', impl);

    await Promise.all([
      ensureModelsCatalogLoaded(true),
      ensureModelsCatalogLoaded(true),
      ensureModelsCatalogLoaded(true),
    ]);
    const after = await ensureModelsCatalogLoaded(false);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(after).toEqual({ ok: true, path: CATALOG_PATH });
  });

  it('命令 missing：loaded===false，updateModel 不得调用 save', async () => {
    const miss = await ensureModelsCatalogLoaded(true);
    expect(miss.ok).toBe(false);
    expect(modelsCatalogStore.getState().loaded).toBe(false);
    expect(modelsCatalogStore.getState().lastError?.kind).toBe('IPC_DISCONNECTED');
    expect(listCatalogModels()).toHaveLength(0);

    const saveImpl = mockSaveOk();
    const writeRes = await modelsCatalogStore.updateModel('acme', 'acme-think', {
      thinking: { Low: 'low', Max: 'max' },
    });
    expect(writeRes.ok).toBe(false);
    expect(saveImpl).not.toHaveBeenCalled();

    mockReadOk(YAML_PROVIDERS);
    const retry = await ensureModelsCatalogLoaded(true);
    expect(retry).toEqual({ ok: true, path: CATALOG_PATH });
    expect(modelsCatalogStore.getState().loaded).toBe(true);
    expect(listCatalogModels()).toHaveLength(2);
  });

  it('命令 error：显式失败并透传后端消息，loaded=false', async () => {
    mockTauriError('workbench_read_models_yaml', '磁盘 IO 故障');
    const res = await ensureModelsCatalogLoaded(true);
    expect(res).toMatchObject({ ok: false, error: '磁盘 IO 故障' });
    expect(modelsCatalogStore.getState().loaded).toBe(false);
    expect(modelsCatalogStore.getState().lastError?.kind).toBe('IPC_DISCONNECTED');
    expect(listCatalogModels()).toHaveLength(0);
  });

  it('解析失败：loaded=false，不覆盖上一份成功快照，拒绝写盘', async () => {
    mockReadOk(ACME_PROVIDERS);
    await ensureModelsCatalogLoaded(true);
    expect(selectModel('acme', 'acme-think')?.thinking?.Low).toBe('low');
    const snapshot = modelsCatalogStore.getState().tree;

    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      content: 'broken: [',
      template: '',
      seeded: false,
      parseError: { line: 12, column: 5, message: 'bad indentation' },
    }));
    let changeCount = 0;
    const off = onUiEvent('models-catalog-changed', () => {
      changeCount += 1;
    });
    const saveImpl = mockSaveOk();

    const bad = await ensureModelsCatalogLoaded(true);
    off();

    expect(bad.ok).toBe(false);
    expect(bad).toMatchObject({ error: expect.stringContaining('第 12 行') });
    expect(modelsCatalogStore.getState().loaded).toBe(false);
    expect(modelsCatalogStore.getState().lastError?.kind).toBe('PARSE_FAILURE');
    expect(modelsCatalogStore.getState().tree).toEqual(snapshot);
    expect(selectModel('acme', 'acme-think')?.pricing?.cacheRead).toBe(0.1);
    expect(changeCount).toBe(1);
    expect(getModelsCatalogVersion()).toBeGreaterThan(0);

    const writeRes = await modelsCatalogStore.updateModel('acme', 'acme-think', {
      thinking: { Low: 'low', Max: 'max' },
    });
    expect(writeRes.ok).toBe(false);
    expect(saveImpl).not.toHaveBeenCalled();
  });

  it('缺 providers：即使带 tree 也 loaded=false，不得当成功源', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      content: '',
      template: '',
      seeded: false,
      parseError: null,
      tree: { version: 2, providers: ACME_PROVIDERS },
    }));
    const saveImpl = mockSaveOk();
    const res = await ensureModelsCatalogLoaded(true);
    expect(res.ok).toBe(false);
    expect(modelsCatalogStore.getState().loaded).toBe(false);
    expect(modelsCatalogStore.getState().lastError).toBeTruthy();
    expect(listCatalogModels()).toHaveLength(0);

    const writeRes = await modelsCatalogStore.updateModel('acme', 'acme-think', {
      thinking: { Low: 'low' },
    });
    expect(writeRes.ok).toBe(false);
    expect(saveImpl).not.toHaveBeenCalled();
  });

  it('合法空 providers:{} → loaded=true，允许后续写', async () => {
    mockReadOk({});
    const res = await ensureModelsCatalogLoaded(true);
    expect(res.ok).toBe(true);
    expect(modelsCatalogStore.getState().loaded).toBe(true);
    expect(modelsCatalogStore.getState().tree.providers).toEqual({});

    const saveImpl = mockSaveOk();
    const writeRes = await modelsCatalogStore.addProvider('acme', ACME_PROVIDERS.acme);
    expect(writeRes.ok).toBe(true);
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(selectModel('acme', 'acme-think')?.id).toBe('acme-think');
  });

  it('从未成功加载时 updateTree / updateProvider / addModel 均拒绝写盘', async () => {
    const saveImpl = mockSaveOk();
    const treeRes = await modelsCatalogStore.updateTree({
      version: 2,
      providers: ACME_PROVIDERS,
    });
    expect(treeRes.ok).toBe(false);
    const providerRes = await modelsCatalogStore.updateProvider('acme', { displayName: 'X' });
    expect(providerRes.ok).toBe(false);
    const addRes = await modelsCatalogStore.addModel('acme', { id: 'x' });
    expect(addRes.ok).toBe(false);
    expect(saveImpl).not.toHaveBeenCalled();
  });

  it('searchCatalogModels：查询与 vendor 过滤', async () => {
    await loadProviders(YAML_PROVIDERS);

    expect(searchCatalogModels('glm').map((m) => m.model)).toEqual(['glm-5.3']);
    expect(searchCatalogModels('', 'zai').map((m) => m.model)).toEqual(['glm-5.3']);
    expect(searchCatalogModels('', 'moonshotai')).toHaveLength(1);
    expect(searchCatalogModels('不存在于字典的模型')).toHaveLength(0);
  });

  it('findCatalogModel：两参必填，大小写不敏感精确命中，禁止跨厂商兜底', async () => {
    await loadProviders(YAML_PROVIDERS);

    expect(findCatalogModel('GLM-5.3', 'zai')?.vendor).toBe('zai');
    expect(findCatalogModel('GLM-5.3', 'ZAI')?.vendor).toBe('zai');
    expect(findCatalogModel('  kimi-k3  ', 'moonshotai')?.displayName).toBe('Kimi K3');
    expect(findCatalogModel('glm-5.3', 'moonshotai')).toBeUndefined();
    expect(findCatalogModel('kimi-k3', 'zai')).toBeUndefined();
    expect(findCatalogModel('glm-5.3', '')).toBeUndefined();
    expect(findCatalogModel('', 'zai')).toBeUndefined();
    expect(findCatalogModel('nope', 'zai')).toBeUndefined();
  });

  it('findCatalogModel：同 id 跨厂商必须带对 providerId，传错不得串线', async () => {
    await loadProviders({
      alpha: {
        displayName: 'Alpha',
        baseUrl: 'https://alpha.invalid/v1',
        protocol: 'openai/chat',
        models: [
          {
            id: 'shared-id',
            protocol: 'openai/chat',
            modalities: { input: ['text'], output: ['text'] },
            thinking: { Low: 'low' },
          },
        ],
      },
      beta: {
        displayName: 'Beta',
        baseUrl: 'https://beta.invalid/v1',
        protocol: 'anthropic/messages',
        models: [
          {
            id: 'shared-id',
            protocol: 'anthropic/messages',
            modalities: { input: ['text', 'image'], output: ['text'] },
            thinking: { High: 'HIGH' },
          },
        ],
      },
    });

    // 省略第二参无法编译：findCatalogModel('shared-id')
    const alpha = findCatalogModel('shared-id', 'alpha');
    const beta = findCatalogModel('shared-id', 'beta');
    expect(alpha?.vendor).toBe('alpha');
    expect(alpha?.protocol).toBe('openai/chat');
    expect(beta?.vendor).toBe('beta');
    expect(beta?.protocol).toBe('anthropic/messages');
    expect(findCatalogModel('shared-id', 'ghost')).toBeUndefined();
  });

  it('getPresetPricingList：仅映射字典 pricing 段（缺省值为 0 而非 undefined）', async () => {
    await loadProviders(YAML_PROVIDERS);

    const presets = getPresetPricingList();
    expect(presets).toHaveLength(2);
    const glm = presets.find((p) => p.model === 'glm-5.3');
    expect(glm).toMatchObject({
      inputPerMTok: 1.4,
      outputPerMTok: 4.4,
      cacheReadPerMTok: 0.14,
      billingUnit: 'token',
    });
    const kimi = presets.find((p) => p.model === 'kimi-k3');
    expect(kimi).toMatchObject({ inputPerMTok: 3.0 });
    expect(kimi).not.toHaveProperty('cacheReadPerMTok');
  });
});

describe('§7.1 最小树：thinking / modalities / pricing / baseUrl / apiKey 往返', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelsCatalogMirror();
  });

  it('ensureLoaded 后 selectModel 读回同一 thinking/modalities/pricing.cacheRead', async () => {
    await loadProviders(ACME_PROVIDERS);

    const model = selectModel('acme', 'acme-think');
    expect(model?.thinking).toEqual({ Low: 'low', High: 'high' });
    expect(model?.modalities?.input).toEqual(expect.arrayContaining(['image']));
    expect(model?.pricing?.cacheRead).toBe(0.1);
    expect(selectProvider('acme')?.baseUrl).toBe('https://example.invalid/v1');
    expect(selectProvider('acme')?.apiKey).toBe('$ACME_API_KEY');
  });

  it('updateModel 加上 Max 后镜像含 Max，save content 含 thinking/modalities/cacheRead', async () => {
    mockReadOk(ACME_PROVIDERS);
    await ensureModelsCatalogLoaded(true);
    const saveImpl = mockSaveOk();

    const res = await modelsCatalogStore.updateModel('acme', 'acme-think', {
      thinking: { Low: 'low', High: 'high', Max: 'max' },
    });
    expect(res.ok).toBe(true);

    const mirrored = selectModel('acme', 'acme-think');
    expect(mirrored?.thinking).toMatchObject({ Low: 'low', Max: 'max' });
    expect(mirrored?.modalities?.input).toContain('image');
    expect(mirrored?.pricing?.cacheRead).toBe(0.1);

    expect(saveImpl).toHaveBeenCalledTimes(1);
    const content = savedYaml(saveImpl);
    expect(content).toContain('thinking');
    expect(content).toContain('Max');
    expect(content).toContain('modalities');
    expect(content).toContain('cacheRead');
    expect(content).toContain('$ACME_API_KEY');
    expect(content).toContain('https://example.invalid/v1');
  });
});

describe('modelsCatalogStore 树状重构与 O(1) 检索套件', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    await loadProviders(baselineProviders());
  });

  it('维护 version: 2 并正确构建双层双向 O(1) 索引', () => {
    const state = modelsCatalogStore.getState();
    expect(state.tree.version).toBe(2);
    expect(state.providerMap.size).toBeGreaterThanOrEqual(5);

    const deepseek = selectProvider('deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek?.displayName).toBe('DeepSeek');
    expect(deepseek?.protocol).toBe('openai/chat');

    const flash = selectModel('deepseek', 'deepseek/deepseek-v4-flash');
    expect(flash).toBeDefined();
    expect(flash?.contextWindow).toBe(1_048_576);
    expect(flash?.maxOutputTokens).toBe(393_216);

    const globalHit = selectModelGlobally('deepseek/deepseek-v4-flash');
    expect(globalHit).toBeDefined();
    expect(globalHit?.providerId).toBe('deepseek');
  });
});

describe('极简纯函数 Actions 与智能预填', () => {
  const baseTree: ModelsYamlTree = {
    version: 2,
    providers: {
      deepseek: {
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        protocol: 'openai/chat',
        models: [],
      },
    },
  };

  it('addProvider, updateProvider, removeProvider 纯函数行为正确', () => {
    const newProv: ProviderSpec = {
      displayName: 'Anthropic Claude',
      baseUrl: 'https://api.anthropic.com',
      protocol: 'anthropic/messages',
      models: [],
    };
    const treeWithAnthropic = addProvider(baseTree, 'anthropic', newProv);
    expect(treeWithAnthropic.providers['anthropic']).toBeDefined();
    expect(treeWithAnthropic.providers['anthropic'].protocol).toBe('anthropic/messages');
    expect(baseTree.providers['anthropic']).toBeUndefined();

    const treeUpdated = updateProvider(treeWithAnthropic, 'anthropic', {
      displayName: 'Anthropic Official',
    });
    expect(treeUpdated.providers['anthropic'].displayName).toBe('Anthropic Official');

    const treeRemoved = removeProvider(treeUpdated, 'anthropic');
    expect(treeRemoved.providers['anthropic']).toBeUndefined();
    expect(treeRemoved.providers['deepseek']).toBeDefined();
  });

  it('addModel 智能调用 findAutofillModel 自动补全 2026 最新官方模型', () => {
    const nextTree = addModel(baseTree, 'deepseek', {
      id: 'deepseek/deepseek-v4-flash',
    });

    const model = nextTree.providers['deepseek'].models[0];
    expect(model).toBeDefined();
    expect(model.id).toBe('deepseek/deepseek-v4-flash');
    expect(model.contextWindow).toBe(1_048_576);
    expect(model.maxOutputTokens).toBe(393_216);
    expect(model.thinking).toBeDefined();
    expect(model.thinking?.['High']).toBe('high');
    expect(model.pricing?.currency).toBe('CNY');
    expect(model.pricing?.cacheRead).toBe(0.10);
  });

  it('addModel 允许用户自由改写预填参数', () => {
    const nextTree = addModel(baseTree, 'deepseek', {
      id: 'deepseek/deepseek-v4-flash',
      displayName: '用户定制极速版',
      contextWindow: 2_000_000,
      pricing: {
        currency: 'CNY',
        unit: 'per_1m_tokens',
        input: 0.88,
        output: 2.5,
        cacheRead: 0.05,
      },
    });

    const model = nextTree.providers['deepseek'].models[0];
    expect(model.displayName).toBe('用户定制极速版');
    expect(model.contextWindow).toBe(2_000_000);
    expect(model.pricing?.input).toBe(0.88);
    expect(model.pricing?.cacheRead).toBe(0.05);
    expect(model.thinking?.['High']).toBe('high');
  });

  it('updateModel 与 removeModel 纯函数行为正确', () => {
    const treeWithModel = addModel(baseTree, 'deepseek', {
      id: 'deepseek/deepseek-v4-flash',
    });

    const updatedTree = updateModel(treeWithModel, 'deepseek', 'deepseek/deepseek-v4-flash', {
      contextWindow: 512_000,
    });
    expect(updatedTree.providers['deepseek'].models[0].contextWindow).toBe(512_000);

    const removedTree = removeModel(updatedTree, 'deepseek', 'deepseek/deepseek-v4-flash');
    expect(removedTree.providers['deepseek'].models).toHaveLength(0);
  });

  it('updateModel spread 保留未 patch 字段；serialize 文本含 thinking/modalities/cacheRead', () => {
    const acmeTree: ModelsYamlTree = { version: 2, providers: ACME_PROVIDERS };
    const patched = updateModel(acmeTree, 'acme', 'acme-think', {
      thinking: { Low: 'low', Max: 'max' },
      modalities: { input: ['text', 'image'], output: ['text'] },
      pricing: {
        currency: 'USD',
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 0.2,
      },
    });

    const model = patched.providers.acme.models[0];
    expect(model.thinking).toEqual({ Low: 'low', Max: 'max' });
    expect(model.modalities?.input).toContain('image');
    expect(model.pricing?.cacheRead).toBe(0.1);
    expect(model.displayName).toBe('Acme Think');
    expect(patched.providers.acme.baseUrl).toBe('https://example.invalid/v1');
    expect(patched.providers.acme.apiKey).toBe('$ACME_API_KEY');

    const text = serializeModelsYamlTree(patched);
    expect(text).toContain('thinking');
    expect(text).toContain('Max');
    expect(text).toContain('modalities');
    expect(text).toContain('cacheRead');
    expect(text).toContain('apiKey');
    expect(text).toContain('baseUrl');
  });
});

describe('两级协议继承与真实上下文窗口直通解析', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    await loadProviders(baselineProviders());
  });

  it('子模型未显式声明协议时，100% 自动继承 Provider 顶层总协议', () => {
    const proto = selectEffectiveProtocol('deepseek', 'deepseek/deepseek-v4-flash');
    expect(proto).toBe('openai/chat');

    const claudeProto = selectEffectiveProtocol('anthropic', 'claude-5');
    expect(claudeProto).toBe('anthropic/messages');
  });

  it('子模型显式声明协议时，成功执行局部覆盖', () => {
    const proto = selectEffectiveProtocol('openai', 'gpt-5.6-sol');
    expect(proto).toBe('openai/responses');
  });

  it('百万大上下文直通解析，彻底消灭 128K 假上限硬编码', () => {
    const ctxDeepSeek = selectEffectiveContextWindow('deepseek', 'deepseek/deepseek-v4-flash');
    expect(ctxDeepSeek).toBe(1_048_576);

    const ctxQwen = selectEffectiveContextWindow('bailian', 'qwen-3.8-max');
    expect(ctxQwen).toBe(1_048_576);

    const ctxGPT = selectEffectiveContextWindow('openai', 'gpt-5.6');
    expect(ctxGPT).toBe(1_050_000);
  });

  it('缺 contextWindow 返回 undefined，不发明 128000', async () => {
    await loadProviders({
      acme: {
        displayName: 'Acme',
        baseUrl: 'https://example.invalid/v1',
        protocol: 'openai/chat',
        models: [
          { id: 'plain' },
          { id: 'zero-window', contextWindow: 0 },
        ],
      },
    });

    expect(selectEffectiveContextWindow('acme', 'plain')).toBeUndefined();
    expect(selectEffectiveContextWindow('acme', 'zero-window')).toBeUndefined();
    expect(selectEffectiveContextWindow('acme', 'missing')).toBeUndefined();
  });

  it('selectEffectiveContextWindow 只读 contextWindow，内存态不读 contextLength 别名', () => {
    const provider: ProviderSpec = {
      displayName: 'Acme',
      baseUrl: 'https://example.invalid/v1',
      protocol: 'openai/chat',
      models: [],
    };
    const state: ModelsCatalogState = {
      tree: { version: 2, providers: {} },
      providerMap: new Map(),
      modelIndex: new Map([
        [
          'acme::alias-only',
          { providerId: 'acme', provider, model: { id: 'alias-only', contextLength: 999_000 } },
        ],
      ]),
      globalModelIndex: new Map(),
      version: 1,
      loaded: true,
      filePath: '',
      lastError: null,
    };
    const selectors = createSelectors(() => state);
    expect(selectors.selectEffectiveContextWindow('acme', 'alias-only')).toBeUndefined();
    expect(selectors.selectEffectiveContextWindow('acme', 'ghost')).toBeUndefined();
  });
});

describe('思考推理极致拍平字典映射', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    await loadProviders(baselineProviders());
  });

  it('思考推理支持判定与扁平键值对映射', () => {
    expect(selectSupportsThinking('deepseek', 'deepseek/deepseek-v4-pro')).toBe(true);

    const thinking = selectThinkingLevelsMap('deepseek', 'deepseek/deepseek-v4-pro');
    expect(thinking['Low']).toBe('low');
    expect(thinking['Medium']).toBe('medium');
    expect(thinking['High']).toBe('high');
    expect(thinking['Max']).toBe('max');

    expect(selectSupportsThinking('deepseek', 'deepseek-chat')).toBe(false);
    expect(selectThinkingLevelsMap('deepseek', 'deepseek-chat')).toEqual({});
  });
});

describe('纯增量探测发现与用户微调资产 100% 绝对防覆写', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    await loadProviders(baselineProviders());
  });

  it('pureIncrementalProbe 仅对差集模型进行末尾追加', () => {
    const provider = selectProvider('deepseek')!;
    const probed = [
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v5-preview',
    ];

    const { updatedProvider, result } = pureIncrementalProbe(provider, probed, 'deepseek');

    expect(result.totalProbed).toBe(2);
    expect(result.existingRetained).toBeGreaterThanOrEqual(1);
    expect(result.newAppended).toBe(1);
    expect(result.appendedModelIds).toEqual(['deepseek/deepseek-v5-preview']);

    const lastModel = updatedProvider.models[updatedProvider.models.length - 1];
    expect(lastModel.id).toBe('deepseek/deepseek-v5-preview');
  });

  it('applyIncrementalProbe 对用户已微调的模型属性提供 100% 绝对物理保护', async () => {
    await modelsCatalogStore.updateModel('deepseek', 'deepseek/deepseek-v4-flash', {
      displayName: '用户定制旗舰',
      contextWindow: 2_000_000,
      pricing: {
        currency: 'CNY',
        unit: 'per_1m_tokens',
        input: 0.99,
        output: 2.8,
        cacheRead: 0.08,
      },
      thinking: {
        CustomUltra: 'ultra_wire_param',
      },
    });

    const probeRes = await applyIncrementalProbe('deepseek', [
      'deepseek/deepseek-v4-flash',
      'deepseek/new-coding-model-2026',
    ]);

    expect(probeRes.newAppended).toBe(1);
    expect(probeRes.appendedModelIds).toEqual(['deepseek/new-coding-model-2026']);

    const protectedModel = selectModel('deepseek', 'deepseek/deepseek-v4-flash');
    expect(protectedModel?.displayName).toBe('用户定制旗舰');
    expect(protectedModel?.contextWindow).toBe(2_000_000);
    expect(protectedModel?.pricing?.input).toBe(0.99);
    expect(protectedModel?.pricing?.cacheRead).toBe(0.08);
    expect(protectedModel?.thinking?.['CustomUltra']).toBe('ultra_wire_param');
  });
});

describe('独立四维双币结算与阶梯费率', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    await loadProviders(baselineProviders());
  });

  it('selectEstimatedCost 已停用（会话费用唯一入口 = Rust PricingEngine，plans/05 T5.4）', () => {
    const cost = selectEstimatedCost('bailian', 'qwen-3.8-max', {
      inputTokens: 500_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
    });

    expect(cost).toBeNull();
  });

  it('通义千问阶梯费率触发 (Tiered Pricing)', async () => {
    await modelsCatalogStore.addModel('bailian', {
      id: 'qwen3.7-tiered',
      displayName: 'Qwen 3.7 Tiered',
      pricing: {
        currency: 'CNY',
        unit: 'per_1m_tokens',
        input: 4.0,
        output: 12.0,
        cacheRead: 0.80,
        tiers: [
          { inputTokensAbove: 256_000, inputCost: 6.0, outputCost: 18.0 },
        ],
      },
    });

    const normal = selectEstimatedCost('bailian', 'qwen3.7-tiered', {
      inputTokens: 200_000,
      outputTokens: 10_000,
    });
    expect(normal).toBeNull();

    const tiered = selectEstimatedCost('bailian', 'qwen3.7-tiered', {
      inputTokens: 300_000,
      outputTokens: 10_000,
    });
    expect(tiered).toBeNull();
  });

  it('国际站 OpenAI USD 美元结算', () => {
    const cost = selectEstimatedCost('openai', 'gpt-5.6', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
    });

    expect(cost).toBeNull();
  });

  it('未配置价格模型静默跳过 (返回 null，杜绝 0 元视觉噪音)', async () => {
    await modelsCatalogStore.addModel('deepseek', {
      id: 'local-custom-model',
      displayName: 'Local Custom Model',
      contextWindow: 32_000,
      pricing: undefined,
    });

    const cost = selectEstimatedCost('deepseek', 'local-custom-model', {
      inputTokens: 100_000,
      outputTokens: 20_000,
    });
    expect(cost).toBeNull();
  });
});

describe('IPC 韧性：写盘失败自动回滚至 Last-Known-Good 快照', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    await loadProviders(baselineProviders());
  });

  it('写盘被拒绝时，Store 立即原子恢复至 Last-Known-Good 快照', async () => {
    const validSnapshot = modelsCatalogStore.getState();
    expect(validSnapshot.providerMap.has('deepseek')).toBe(true);

    mockTauriError('workbench_save_models_yaml', 'Permission denied');

    const brokenTree: ModelsYamlTree = {
      version: 2,
      providers: {
        broken_provider: {
          displayName: 'Broken',
          baseUrl: 'https://broken.invalid',
          protocol: 'openai/chat',
          models: [],
        },
      },
    };

    const res = await modelsCatalogStore.updateTree(brokenTree);
    expect(res.ok).toBe(false);

    const rolledBackState = modelsCatalogStore.getState();
    expect(rolledBackState.providerMap.has('broken_provider')).toBe(false);
    expect(rolledBackState.providerMap.has('deepseek')).toBe(true);
    expect(rolledBackState.lastError?.kind).toBe('WRITE_REJECTED');
  });
});

describe('写串行队列：并发双写 coalesce + 单飞 save', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    await loadProviders(ACME_PROVIDERS);
  });

  it('同一 tick 连续两次 updateTree：coalesce 为最新 tree，save IPC 只打一次，磁盘与内存一致', async () => {
    const saveImpl = mockSaveOk();

    // 不 await，连续触发两次写——drain 经 microtask 延迟启动，后到覆盖先前排队 tree
    const p1 = modelsCatalogStore.updateProvider('acme', { displayName: 'First' });
    const p2 = modelsCatalogStore.updateProvider('acme', { displayName: 'Second' });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // 单飞 save + coalesce：磁盘只落一次最新 tree
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(selectProvider('acme')?.displayName).toBe('Second');
    // 磁盘内容与内存一致（serialize 含 Second，不含 First）
    const content = savedYaml(saveImpl);
    expect(content).toContain('Second');
    expect(content).not.toContain('First');
    expect(modelsCatalogStore.getState().tree.providers.acme?.displayName).toBe('Second');
  });

  it('串行 await 两次写：各自落盘，最终磁盘与内存均为最后一次结果', async () => {
    const saveImpl = mockSaveOk();

    const r1 = await modelsCatalogStore.updateProvider('acme', { displayName: 'Alpha' });
    const r2 = await modelsCatalogStore.updateProvider('acme', { displayName: 'Beta' });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(saveImpl).toHaveBeenCalledTimes(2);
    expect(selectProvider('acme')?.displayName).toBe('Beta');
    // 最后一次 save 的内容为 Beta（savedYaml 只看第一次调用）
    const content = lastSavedYaml(saveImpl);
    expect(content).toContain('Beta');
  });

  it('in-flight save 失败且有排队 tree：后续 save 接管，不回滚到失败前中间态', async () => {
    // 第一次 save 挂起在 gate 上（真 in-flight），第二次 update 在途排队
    let call = 0;
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockTauriCommand('workbench_save_models_yaml', async () => {
      call += 1;
      if (call === 1) {
        await firstGate;
        throw new Error('disk full');
      }
      return { path: CATALOG_PATH };
    });

    const p1 = modelsCatalogStore.updateProvider('acme', { displayName: 'WillFail' });
    // 冲刷 microtask：drain 启动并进入第一次 save 的 await（挂在 firstGate）
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 第一次 save 仍 in-flight，此时排队第二次（最新 tree）
    const p2 = modelsCatalogStore.updateProvider('acme', { displayName: 'WillSucceed' });

    // 释放第一次 save → 抛错 → writeModelsYamlIpc 转 ok:false
    releaseFirst!();

    const [r1, r2] = await Promise.all([p1, p2]);

    // 第一次失败、第二次成功：2 次 save，内存最终 = WillSucceed
    expect(call).toBe(2);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
    expect(selectProvider('acme')?.displayName).toBe('WillSucceed');
    expect(modelsCatalogStore.getState().tree.providers.acme?.displayName).toBe('WillSucceed');
  });

  it('单次写失败：回滚到批次基线快照并标记 WRITE_REJECTED', async () => {
    const before = modelsCatalogStore.getState();
    mockTauriError('workbench_save_models_yaml', 'read-only fs');

    const res = await modelsCatalogStore.updateProvider('acme', { displayName: 'Doomed' });
    expect(res.ok).toBe(false);

    const after = modelsCatalogStore.getState();
    expect(after.tree).toEqual(before.tree);
    expect(after.providerMap.get('acme')?.displayName).toBe('Acme');
    expect(after.lastError?.kind).toBe('WRITE_REJECTED');
    expect(after.lastError?.message).toBe('read-only fs');
  });
});

describe('魔鬼边界用例 (Devil Edge Cases)', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    await loadProviders(baselineProviders());
  });

  it('大小写混乱与全角空格安全归一化', () => {
    const model = selectModel('　DeEpSeEk ', ' deepseek/deepseek-v4-FLASH　');
    expect(model).toBeDefined();
    expect(model?.id).toBe('deepseek/deepseek-v4-flash');
  });

  it('孤儿模型查询优雅回退，绝不抛出未捕获异常', () => {
    const ghost = selectModel('nonexistent_provider', 'ghost_model');
    expect(ghost).toBeUndefined();

    const fallbackCtx = selectEffectiveContextWindow('nonexistent_provider', 'ghost_model');
    expect(fallbackCtx).toBeUndefined();

    // selectEffectiveProtocol 的 'openai/chat' 兜底仅是 UI 展示占位，
    // 不是出站真源；禁止把该 fallback 灌回序列化 / IPC 写出路径。
    const fallbackProto = selectEffectiveProtocol('nonexistent_provider', 'ghost_model');
    expect(fallbackProto).toBe('openai/chat');
  });
});
