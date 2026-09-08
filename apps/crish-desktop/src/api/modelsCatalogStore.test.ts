/**
 * modelsCatalogStore.test.ts —— Provider-Centric 树状单源 Store 自动化测试套件
 *
 * 覆盖矩阵：
 * 1. 字典镜像加载 / 失败重试 / 解析失败重置 / 存量检索兼容
 * 2. 树状结构维护 (version: 2, providers: Record<string, ProviderSpec>)
 * 3. 极简纯函数 actions (addProvider, updateProvider, removeProvider, addModel, updateModel, removeModel)
 * 4. addModel 智能预填 (findAutofillModel) 与用户自由改写
 * 5. 双层双向 O(1) 索引 (providerMap, modelIndex, globalModelIndex)
 * 6. 两级协议继承状态机 (EffectiveProtocol = Model.protocol ?? Provider.protocol ?? 'openai/chat')
 * 7. 真实上下文物理窗口直通解析 (彻底消除 128K 假上限硬编码)
 * 8. 思考推理极致拍平字典映射 (TitleCase -> Wire 参数，无 levels 嵌套)
 * 9. 纯增量只读探测发现与用户微调资产 100% 绝对防覆写保护
 * 10. 独立四维双币结算与大上下文阶梯算费 (无固定一折假设，未配置价格静默跳过)
 * 11. IPC 防抖、乐观更新与写盘失败自动回滚至 Last-Known-Good 快照
 * 12. 魔鬼边界用例 (全角空格/大小写归一化、孤儿模型安全回退)
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
import { AUTOFILL_BASELINE_2026 } from './modelsAutofillBaseline';
import { applyIncrementalProbe, pureIncrementalProbe } from './probeIncremental';
import type { ModelsYamlTree, ProviderSpec } from './modelsCatalogTypes';

const YAML_WIRE = {
  path: 'C:\\Users\\tester\\.conex\\models.yaml',
  content: 'models: []',
  template: 'models: []',
  seeded: false,
  models: [
    {
      model: 'glm-5.3',
      vendor: 'zai',
      vendorDisplayName: '智谱 BigModel',
      displayName: 'GLM-5.3',
      contextWindow: 1048576,
      maxOutputTokens: 262144,
      protocol: 'openai/chat',
      capabilities: { tools: true, reasoning: true },
      pricing: { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.14, billingUnit: 'token', currency: 'USD' },
    },
    {
      model: 'kimi-k3',
      vendor: 'moonshotai',
      vendorDisplayName: 'Moonshot (Kimi)',
      displayName: 'Kimi K3',
      contextWindow: 1048576,
      maxOutputTokens: 943718,
      capabilities: { tools: true, image: true, video: true },
      pricing: { inputPerMTok: 3.0, outputPerMTok: 15.0, billingUnit: 'token', currency: 'USD' },
    },
  ],
} as const;

describe('modelsCatalogStore（字典镜像，真源 = ~/.conex/models.yaml）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelsCatalogMirror();
  });

  it('加载成功：镜像灌入 + 版本自增 + 广播 models-catalog-changed', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => YAML_WIRE);
    let changeCount = 0;
    const off = onUiEvent('models-catalog-changed', () => {
      changeCount += 1;
    });

    const res = await ensureModelsCatalogLoaded(true);
    off();

    expect(res).toEqual({ ok: true, path: YAML_WIRE.path });
    expect(listCatalogModels()).toHaveLength(2);
    expect(changeCount).toBe(1);
  });

  it('幂等单飞：并发与重复调用只打一次 IPC', async () => {
    const impl = vi.fn(() => YAML_WIRE);
    mockTauriCommand('workbench_read_models_yaml', impl);

    await Promise.all([
      ensureModelsCatalogLoaded(true),
      ensureModelsCatalogLoaded(true),
      ensureModelsCatalogLoaded(true),
    ]);
    const after = await ensureModelsCatalogLoaded(false);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(after).toEqual({ ok: true, path: YAML_WIRE.path });
  });

  it('命令 missing：显式失败、镜像保持空、可重试', async () => {
    // 未注册 → missing 三态
    const miss = await ensureModelsCatalogLoaded(true);
    expect(miss.ok).toBe(false);
    expect(listCatalogModels()).toHaveLength(0);

    // 重新接线后重试成功
    mockTauriCommand('workbench_read_models_yaml', () => YAML_WIRE);
    const retry = await ensureModelsCatalogLoaded(true);
    expect(retry).toEqual({ ok: true, path: YAML_WIRE.path });
    expect(listCatalogModels()).toHaveLength(2);
  });

  it('命令 error：显式失败并透传后端消息', async () => {
    mockTauriError('workbench_read_models_yaml', '磁盘 IO 故障');
    const res = await ensureModelsCatalogLoaded(true);
    expect(res).toMatchObject({ ok: false, error: '磁盘 IO 故障' });
    expect(listCatalogModels()).toHaveLength(0);
  });

  it('解析失败（用户手工改坏）：镜像重置为空 + 广播 + 可修复后重试', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      ...YAML_WIRE,
      models: undefined,
      parseError: { line: 12, column: 5, message: 'bad indentation' },
    }));
    let changeCount = 0;
    const off = onUiEvent('models-catalog-changed', () => {
      changeCount += 1;
    });

    const bad = await ensureModelsCatalogLoaded(true);
    off();

    expect(bad.ok).toBe(false);
    expect(bad).toMatchObject({ error: expect.stringContaining('第 12 行') });
    expect(listCatalogModels()).toHaveLength(0);
    expect(changeCount).toBe(1);
    expect(getModelsCatalogVersion()).toBeGreaterThan(0);
  });

  it('searchCatalogModels：查询与 vendor 过滤', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => YAML_WIRE);
    await ensureModelsCatalogLoaded(true);

    expect(searchCatalogModels('glm').map((m) => m.model)).toEqual(['glm-5.3']);
    expect(searchCatalogModels('', 'zai').map((m) => m.model)).toEqual(['glm-5.3']);
    expect(searchCatalogModels('', 'moonshotai')).toHaveLength(1);
    expect(searchCatalogModels('不存在于字典的模型')).toHaveLength(0);
  });

  it('findCatalogModel：大小写不敏感精确命中', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => YAML_WIRE);
    await ensureModelsCatalogLoaded(true);

    expect(findCatalogModel('GLM-5.3')?.vendor).toBe('zai');
    expect(findCatalogModel('  kimi-k3  ')?.displayName).toBe('Kimi K3');
    expect(findCatalogModel('')).toBeUndefined();
    expect(findCatalogModel('nope')).toBeUndefined();
  });

  it('getPresetPricingList：仅映射字典 pricing 段（缺省值为 0 而非 undefined）', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => YAML_WIRE);
    await ensureModelsCatalogLoaded(true);

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

describe('modelsCatalogStore 树状重构与 O(1) 检索套件', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    mockTauriCommand('models_yaml_write', () => ({ success: true, writtenPath: 'test' }));
    await modelsCatalogStore.updateTree(AUTOFILL_BASELINE_2026);
  });

  it('维护 version: 2 并正确构建双层双向 O(1) 索引', () => {
    const state = modelsCatalogStore.getState();
    expect(state.tree.version).toBe(2);
    expect(state.providerMap.size).toBeGreaterThanOrEqual(5);

    // O(1) 供应商定位
    const deepseek = selectProvider('deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek?.displayName).toBe('DeepSeek');
    expect(deepseek?.protocol).toBe('openai/chat');

    // O(1) 复合主键模型定位 `${providerId}::${modelId}`
    const flash = selectModel('deepseek', 'deepseek/deepseek-v4-flash');
    expect(flash).toBeDefined();
    expect(flash?.contextWindow).toBe(1_048_576);
    expect(flash?.maxOutputTokens).toBe(393_216);

    // O(1) 全局跨厂商检索
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
    // 1. addProvider
    const newProv: ProviderSpec = {
      displayName: 'Anthropic Claude',
      baseUrl: 'https://api.anthropic.com',
      protocol: 'anthropic/messages',
      models: [],
    };
    const treeWithAnthropic = addProvider(baseTree, 'anthropic', newProv);
    expect(treeWithAnthropic.providers['anthropic']).toBeDefined();
    expect(treeWithAnthropic.providers['anthropic'].protocol).toBe('anthropic/messages');
    expect(baseTree.providers['anthropic']).toBeUndefined(); // 原对象不可变

    // 2. updateProvider
    const treeUpdated = updateProvider(treeWithAnthropic, 'anthropic', {
      displayName: 'Anthropic Official',
    });
    expect(treeUpdated.providers['anthropic'].displayName).toBe('Anthropic Official');

    // 3. removeProvider
    const treeRemoved = removeProvider(treeUpdated, 'anthropic');
    expect(treeRemoved.providers['anthropic']).toBeUndefined();
    expect(treeRemoved.providers['deepseek']).toBeDefined();
  });

  it('addModel 智能调用 findAutofillModel 自动补全 2026 最新官方模型', () => {
    // 仅传入 id: 'deepseek/deepseek-v4-flash'，触发智能预填
    const nextTree = addModel(baseTree, 'deepseek', {
      id: 'deepseek/deepseek-v4-flash',
    });

    const model = nextTree.providers['deepseek'].models[0];
    expect(model).toBeDefined();
    expect(model.id).toBe('deepseek/deepseek-v4-flash');
    // 真实 1,048,576 上下文自动填充，彻底消灭 128K 假上限！
    expect(model.contextWindow).toBe(1_048_576);
    expect(model.maxOutputTokens).toBe(393_216);
    // 拍平思考档位自动填充
    expect(model.thinking).toBeDefined();
    expect(model.thinking?.['High']).toBe('high');
    // 独立四维价格自动填充 (cacheRead 0.10)
    expect(model.pricing?.currency).toBe('CNY');
    expect(model.pricing?.cacheRead).toBe(0.10);
  });

  it('addModel 允许用户自由改写预填参数', () => {
    const nextTree = addModel(baseTree, 'deepseek', {
      id: 'deepseek/deepseek-v4-flash',
      displayName: '用户定制极速版',
      contextWindow: 2_000_000, // 用户手动扩容
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
    // 未改写的 thinking 仍受 autofill 补全
    expect(model.thinking?.['High']).toBe('high');
  });

  it('updateModel 与 removeModel 纯函数行为正确', () => {
    const treeWithModel = addModel(baseTree, 'deepseek', {
      id: 'deepseek/deepseek-v4-flash',
    });

    // updateModel
    const updatedTree = updateModel(treeWithModel, 'deepseek', 'deepseek/deepseek-v4-flash', {
      contextWindow: 512_000,
    });
    expect(updatedTree.providers['deepseek'].models[0].contextWindow).toBe(512_000);

    // removeModel
    const removedTree = removeModel(updatedTree, 'deepseek', 'deepseek/deepseek-v4-flash');
    expect(removedTree.providers['deepseek'].models).toHaveLength(0);
  });
});

describe('两级协议继承与真实上下文窗口直通解析', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    mockTauriCommand('models_yaml_write', () => ({ success: true, writtenPath: 'test' }));
    await modelsCatalogStore.updateTree(AUTOFILL_BASELINE_2026);
  });

  it('子模型未显式声明协议时，100% 自动继承 Provider 顶层总协议', () => {
    // deepseek/deepseek-v4-flash 未声明 protocol，继承 deepseek 的 openai/chat
    const proto = selectEffectiveProtocol('deepseek', 'deepseek/deepseek-v4-flash');
    expect(proto).toBe('openai/chat');

    // claude-5 未声明 protocol，继承 anthropic 的 anthropic/messages
    const claudeProto = selectEffectiveProtocol('anthropic', 'claude-5');
    expect(claudeProto).toBe('anthropic/messages');
  });

  it('子模型显式声明协议时，成功执行局部覆盖', () => {
    // gpt-5.6-sol 显式声明 protocol: 'openai/responses'，覆盖其 Provider 协议
    const proto = selectEffectiveProtocol('openai', 'gpt-5.6-sol');
    expect(proto).toBe('openai/responses');
  });

  it('百万大上下文直通解析，彻底消灭 128K 假上限硬编码', () => {
    const ctxDeepSeek = selectEffectiveContextWindow('deepseek', 'deepseek/deepseek-v4-flash');
    expect(ctxDeepSeek).toBe(1_048_576); // 严格等于 1,048,576，绝非 128,000

    const ctxQwen = selectEffectiveContextWindow('bailian', 'qwen-3.8-max');
    expect(ctxQwen).toBe(1_048_576);

    const ctxGPT = selectEffectiveContextWindow('openai', 'gpt-5.6');
    expect(ctxGPT).toBe(1_050_000);
  });
});

describe('思考推理极致拍平字典映射', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    mockTauriCommand('models_yaml_write', () => ({ success: true, writtenPath: 'test' }));
    await modelsCatalogStore.updateTree(AUTOFILL_BASELINE_2026);
  });

  it('思考推理支持判定与扁平键值对映射', () => {
    // deepseek-v4-pro 支持思考
    expect(selectSupportsThinking('deepseek', 'deepseek/deepseek-v4-pro')).toBe(true);

    const thinking = selectThinkingLevelsMap('deepseek', 'deepseek/deepseek-v4-pro');
    expect(thinking['Low']).toBe('low');
    expect(thinking['Medium']).toBe('medium');
    expect(thinking['High']).toBe('high');
    expect(thinking['Max']).toBe('max');

    // deepseek-chat 非思考模型，thinking 缺省
    expect(selectSupportsThinking('deepseek', 'deepseek-chat')).toBe(false);
    expect(selectThinkingLevelsMap('deepseek', 'deepseek-chat')).toEqual({});
  });
});

describe('纯增量探测发现与用户微调资产 100% 绝对防覆写', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    mockTauriCommand('models_yaml_write', () => ({ success: true, writtenPath: 'test' }));
    await modelsCatalogStore.updateTree(AUTOFILL_BASELINE_2026);
  });

  it('pureIncrementalProbe 仅对差集模型进行末尾追加', () => {
    const provider = selectProvider('deepseek')!;
    const probed = [
      'deepseek/deepseek-v4-flash', // 已存在存量模型
      'deepseek/deepseek-v5-preview', // 远端新发现模型
    ];

    const { updatedProvider, result } = pureIncrementalProbe(provider, probed, 'deepseek');

    expect(result.totalProbed).toBe(2);
    expect(result.existingRetained).toBeGreaterThanOrEqual(1);
    expect(result.newAppended).toBe(1);
    expect(result.appendedModelIds).toEqual(['deepseek/deepseek-v5-preview']);

    // 新模型被追加在末尾
    const lastModel = updatedProvider.models[updatedProvider.models.length - 1];
    expect(lastModel.id).toBe('deepseek/deepseek-v5-preview');
  });

  it('applyIncrementalProbe 对用户已微调的模型属性提供 100% 绝对物理保护', async () => {
    // 模拟用户对 deepseek/deepseek-v4-flash 进行了深度调优
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

    // 运行探测：返回已有模型与新模型
    const probeRes = await applyIncrementalProbe('deepseek', [
      'deepseek/deepseek-v4-flash',
      'deepseek/new-coding-model-2026',
    ]);

    expect(probeRes.newAppended).toBe(1);
    expect(probeRes.appendedModelIds).toEqual(['deepseek/new-coding-model-2026']);

    // 存量模型所有字段 100% 严格保护，绝无被远端探测覆写
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
    mockTauriCommand('models_yaml_write', () => ({ success: true, writtenPath: 'test' }));
    await modelsCatalogStore.updateTree(AUTOFILL_BASELINE_2026);
  });

  it('国内站通义千问 CNY 独立四维单价算费 (绝无固定一折假设)', () => {
    // qwen-3.8-max: input 12.0, output 36.0, cacheRead 2.4 (独立绝对单价)
    const cost = selectEstimatedCost('bailian', 'qwen-3.8-max', {
      inputTokens: 500_000,       // 0.5M * 12.0 = 6.0
      outputTokens: 100_000,      // 0.1M * 36.0 = 3.6
      cacheReadTokens: 1_000_000, // 1.0M * 2.4  = 2.4
    });

    expect(cost).toBeDefined();
    expect(cost?.currency).toBe('CNY');
    expect(cost?.totalCost).toBeCloseTo(6.0 + 3.6 + 2.4, 4);
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
    expect(normal?.totalCost).toBeCloseTo(0.2 * 4.0 + 0.01 * 12.0, 4);

    const tiered = selectEstimatedCost('bailian', 'qwen3.7-tiered', {
      inputTokens: 300_000, // 超过 256k
      outputTokens: 10_000,
    });
    expect(tiered?.totalCost).toBeCloseTo(0.3 * 6.0 + 0.01 * 18.0, 4);
  });

  it('国际站 OpenAI USD 美元结算', () => {
    const cost = selectEstimatedCost('openai', 'gpt-5.6', {
      inputTokens: 1_000_000,     // 1.0M * 2.0 = 2.0
      outputTokens: 500_000,      // 0.5M * 8.0 = 4.0
      cacheReadTokens: 2_000_000, // 2.0M * 0.5 = 1.0
    });

    expect(cost?.currency).toBe('USD');
    expect(cost?.totalCost).toBeCloseTo(7.0, 4);
  });

  it('未配置价格模型静默跳过 (返回 null，杜绝 0 元视觉噪音)', () => {
    const tree = modelsCatalogStore.getState().tree;
    const nextTree = addModel(tree, 'deepseek', {
      id: 'local-custom-model',
      displayName: 'Local Custom Model',
      contextWindow: 32_000,
      pricing: undefined,
    });
    modelsCatalogStore.updateTree(nextTree);

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
    mockTauriCommand('models_yaml_write', () => ({ success: true, writtenPath: 'test' }));
    await modelsCatalogStore.updateTree(AUTOFILL_BASELINE_2026);
  });

  it('写盘被拒绝时，Store 立即原子恢复至 Last-Known-Good 快照', async () => {
    const validSnapshot = modelsCatalogStore.getState();
    expect(validSnapshot.providerMap.has('deepseek')).toBe(true);

    // 模拟写入磁盘故障
    mockTauriError('models_yaml_write', 'Permission denied');
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

    // 状态已原子回滚！
    const rolledBackState = modelsCatalogStore.getState();
    expect(rolledBackState.providerMap.has('broken_provider')).toBe(false);
    expect(rolledBackState.providerMap.has('deepseek')).toBe(true);
    expect(rolledBackState.lastError?.kind).toBe('WRITE_REJECTED');
  });
});

describe('魔鬼边界用例 (Devil Edge Cases)', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    mockTauriCommand('models_yaml_write', () => ({ success: true, writtenPath: 'test' }));
    await modelsCatalogStore.updateTree(AUTOFILL_BASELINE_2026);
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
    expect(fallbackCtx).toBe(128_000); // 兜底安全基线

    const fallbackProto = selectEffectiveProtocol('nonexistent_provider', 'ghost_model');
    expect(fallbackProto).toBe('openai/chat'); // 最终回退协议
  });
});
