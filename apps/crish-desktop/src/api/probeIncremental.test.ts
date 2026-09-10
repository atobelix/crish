/**
 * probeIncremental.test.ts —— 纯增量探测追加器单元测试
 *
 * 验证反过度设计与用户微调资产 100% 绝对保护铁律
 */

import { describe, expect, it } from 'vitest';
import { pureIncrementalProbe, applyIncrementalProbe } from './probeIncremental';
import { modelsCatalogStore } from './modelsCatalogStore';
import { mockTauriCommand } from '../test-setup';
import type { ProviderSpec } from './modelsCatalogTypes';

describe('probeIncremental 纯增量探测套件', () => {
  const sampleProvider: ProviderSpec = {
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai/chat',
    models: [
      {
        id: 'deepseek-v4-flash',
        displayName: '用户手动改写的显示名',
        contextWindow: 2_000_000, // 手动扩容
        maxOutputTokens: 500_000,
        thinking: {
          CustomLevel: 'custom_wire',
        },
        pricing: {
          currency: 'CNY',
          unit: 'per_1m_tokens',
          input: 0.88,
          output: 2.88,
          cacheRead: 0.05,
        },
      },
    ],
  };

  it('当远端探测未包含新 ID 时，0 追加并原样返回存量', () => {
    const { updatedProvider, result } = pureIncrementalProbe(sampleProvider, [
      'deepseek-v4-flash',
      'DEEPSEEK-V4-FLASH', // 大小写重复
      '',
    ]);

    expect(result.totalProbed).toBe(1);
    expect(result.existingRetained).toBe(1);
    expect(result.newAppended).toBe(0);
    expect(result.appendedModelIds).toHaveLength(0);
    expect(updatedProvider.models).toHaveLength(1);
  });

  it('差集追加：新发现模型末尾追加，存量模型 100% 绝对保护不受覆写', () => {
    const probed = [
      'deepseek-v4-flash', // 存量
      'deepseek-v4-pro',   // 新发现 2026 官方模型
      'custom-unknown-1',  // 新发现未知模型
    ];

    const { updatedProvider, result } = pureIncrementalProbe(sampleProvider, probed, 'deepseek');

    expect(result.newAppended).toBe(2);
    expect(result.appendedModelIds).toEqual(['deepseek-v4-pro', 'custom-unknown-1']);
    expect(updatedProvider.models).toHaveLength(3);

    // 核心断言：存量模型属性 100% 毫无改变
    const existing = updatedProvider.models[0];
    expect(existing.displayName).toBe('用户手动改写的显示名');
    expect(existing.contextWindow).toBe(2_000_000);
    expect(existing.pricing?.input).toBe(0.88);
    expect(existing.pricing?.cacheRead).toBe(0.05);
    expect(existing.thinking?.['CustomLevel']).toBe('custom_wire');

    // 官方模型自动调用 findAutofillModel 智能补齐真实大模型元数据
    const proModel = updatedProvider.models[1];
    expect(proModel.id).toBe('deepseek-v4-pro');
    expect(proModel.contextWindow).toBe(1_048_576);
    expect(proModel.thinking).toBeDefined();

    // 未知模型回退至安全基线
    const unknownModel = updatedProvider.models[2];
    expect(unknownModel.id).toBe('custom-unknown-1');
    expect(unknownModel.contextWindow).toBeUndefined();
    expect(unknownModel.maxOutputTokens).toBeUndefined();
    expect(unknownModel.thinking).toBeUndefined();
  });

  it('applyIncrementalProbe 正确更新 store 并写盘', async () => {
    modelsCatalogStore.resetForTesting();
    const providers = {
      deepseek: { ...sampleProvider, models: [...sampleProvider.models] },
    };
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: 'C:\\Users\\tester\\.conex\\models.yaml',
      content: '',
      template: '',
      seeded: false,
      parseError: null,
      providers,
    }));
    mockTauriCommand('workbench_save_models_yaml', () => ({
      path: 'C:\\Users\\tester\\.conex\\models.yaml',
    }));
    const loaded = await modelsCatalogStore.ensureLoaded(true);
    expect(loaded).toBe(true);

    const res = await applyIncrementalProbe('deepseek', [
      'deepseek-v4-flash',
      'deepseek-v4-coder-2026',
    ]);

    expect(res.newAppended).toBe(1);
    const storeState = modelsCatalogStore.getState();
    const deepseek = storeState.providerMap.get('deepseek');
    expect(deepseek?.models).toHaveLength(2);
    expect(deepseek?.models[1].id).toBe('deepseek-v4-coder-2026');
  });

  it('对未配置的供应商执行探测抛出明确错误', async () => {
    modelsCatalogStore.resetForTesting();
    await expect(applyIncrementalProbe('unconfigured_vendor', ['model-1'])).rejects.toThrow(
      '无法对未配置的供应商执行探测追加'
    );
  });
});
