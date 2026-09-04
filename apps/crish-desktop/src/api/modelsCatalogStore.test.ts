/**
 * modelsCatalogStore 单测：镜像加载 / 失败可重试 / 解析失败重置 / 检索与计价映射。
 * IPC 经 test-setup 的 mockTauriCommand 三态模拟，不触达真实 Tauri。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockTauriCommand,
  mockTauriError,
} from '../test-setup';
import { onUiEvent } from './uiEvents';
import {
  ensureModelsCatalogLoaded,
  findCatalogModel,
  getPresetPricingList,
  getModelsCatalogVersion,
  listCatalogModels,
  resetModelsCatalogMirror,
  searchCatalogModels,
} from './modelsCatalogStore';

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
