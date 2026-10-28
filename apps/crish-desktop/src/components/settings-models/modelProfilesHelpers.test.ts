import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderProfile } from '../../api/providerProfiles';
import { mockTauriCommand } from '../../test-setup';
import { modelsCatalogStore, selectModel } from '../../api/modelsCatalogStore';
import type { ModelSpec, ProviderSpec } from '../../api/modelsCatalogTypes';
import {
  modelSpecRevision,
  pickSettingsSelectedId,
  settingsObjectId,
} from './modelProfilesHelpers';

function profile(
  partial: Partial<ProviderProfile> & Pick<ProviderProfile, 'id' | 'name'>
): ProviderProfile {
  return {
    baseUrl: '',
    models: [],
    hasKey: false,
    enabled: true,
    ...partial,
  };
}

describe('modelProfilesHelpers 设置页选中项（唯一真源 = 统一树 provider 身份）', () => {
  // 说明（2026-09-15 单轨收敛）：旧实现的 `foldSettingsProfiles` /
  // `resolveSettingsSelectedId` 是「按展示名折叠 + 把被折叠的拷贝改绑胜者」，
  // 存在的唯一理由是旧 localStorage 档案轨会出现同名重复条目
  // （实测 `senseNova` ×2 / `自定义服务商` ×5）。统一树的 provider 身份是
  // `providerId` 键，**同展示名可以共存且互不干扰**，折叠不再需要，故两函数已物理删除。
  // 本组断言改钉新不变量：选中项必须落在树里真实存在的 provider 身份上，
  // 树里没有的旧 id 一律丢弃，**绝不按展示名改绑**。
  const seed = profile({
    id: 'opencode-go',
    name: 'OpenCode Go 订阅',
    models: ['deepseek-v4-flash'],
  });
  const copy = profile({
    id: 'preset-opencode-go',
    name: 'OpenCode Go 订阅',
    models: [],
  });
  const zen = profile({
    id: 'opencode-zen',
    name: 'OpenCode Zen 订阅',
  });
  const disabled = profile({
    id: 'off',
    name: 'Off',
    enabled: false,
  });

  it('同展示名的两个 provider 共存：不折叠、不丢行（树以 providerId 为键）', () => {
    const providers = [copy, seed, zen, disabled];
    const picked = providers.map((p) => p.id);
    expect(picked).toEqual([
      'preset-opencode-go',
      'opencode-go',
      'opencode-zen',
      'off',
    ]);
    expect(providers.filter((p) => p.name === 'OpenCode Go 订阅')).toHaveLength(
      2
    );
  });

  it('树里不存在的旧 id 一律丢弃，不按展示名改绑', () => {
    const providers = [seed, zen];
    // 旧档案轨里的 `preset-opencode-go` 与 `seed` 同展示名——旧实现会把它
    // 改绑到 `opencode-go`（按展示名认亲），新实现必须丢弃并按记忆/首行回落。
    expect(pickSettingsSelectedId(providers, 'preset-opencode-go', null)).toBe(
      'opencode-go'
    );
    expect(
      pickSettingsSelectedId(providers, 'preset-opencode-go', 'opencode-zen')
    ).toBe('opencode-zen');
  });

  it('pickSettingsSelectedId：已选 → 会话记忆 → 树首行；三者都必须在树里', () => {
    const providers = [seed, zen];
    expect(
      pickSettingsSelectedId(providers, 'opencode-zen', 'opencode-go')
    ).toBe('opencode-zen');
    expect(pickSettingsSelectedId(providers, null, 'opencode-zen')).toBe(
      'opencode-zen'
    );
    expect(pickSettingsSelectedId(providers, null, 'gone')).toBe('opencode-go');
    expect(pickSettingsSelectedId([], null, 'anything')).toBe('');
  });

  it('settingsObjectId 为二元组 JSON 键：跨 provider 隔离且无分隔符碰撞', () => {
    expect(settingsObjectId('a::b', 'c')).not.toBe(
      settingsObjectId('a', 'b::c')
    );
    expect(settingsObjectId('ollama', 'ornith')).toBe(
      settingsObjectId('ollama', 'ornith')
    );
    expect(settingsObjectId('ollama', 'ornith')).not.toBe(
      settingsObjectId('custom-mtyp5k9c', 'ornith')
    );
  });
});

describe('modelSpecRevision（CT-01 签 ModelSpec 全字段）', () => {
  const PROVIDER_ID = 'acme';
  const MODEL_ID = 'acme-think';
  const BASE_MODEL: ModelSpec = {
    id: MODEL_ID,
    displayName: 'Acme Think',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    enabled: true,
    protocol: 'openai/chat',
    supportsTools: true,
    thinking: { Low: 'low', High: 'high' },
    modalities: { input: ['text', 'image'], output: ['text'] },
    pricing: {
      currency: 'CNY',
      input: 0.99,
      output: 2.8,
      cacheRead: 0.08,
      cacheWrite: 0.2,
    },
  };
  const PROVIDERS: Record<string, ProviderSpec> = {
    [PROVIDER_ID]: {
      displayName: 'Acme',
      baseUrl: 'https://example.invalid/v1',
      protocol: 'openai/chat',
      models: [BASE_MODEL],
    },
  };

  function revisionOf(providerId: string, modelId: string): string {
    const model = selectModel(providerId, modelId);
    expect(model, 'store 必须已有该 ModelSpec').toBeTruthy();
    return modelSpecRevision(model!);
  }

  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: 'C:\\Users\\tester\\.conex\\models.yaml',
      content: '',
      template: '',
      revision: 'revision-0',
      credentialStates: {},
      parseError: null,
      tree: {
        version: 2,
        activeModel: null,
        providers: structuredClone(PROVIDERS),
      },
    }));
    mockTauriCommand('workbench_apply_models_config', (args) => {
      const { tree } = args as { tree: unknown };
      return {
        path: 'C:\\Users\\tester\\.conex\\models.yaml',
        revision: 'revision-1',
        content: '',
        template: '',
        credentialStates: {},
        parseError: null,
        tree,
      };
    });
    await modelsCatalogStore.ensureLoaded(true);
    expect(selectModel(PROVIDER_ID, MODEL_ID)?.thinking?.Low).toBe('low');
  });

  it('签名至少含 displayName/contextWindow/thinking/modalities/pricing', () => {
    const rev = revisionOf(PROVIDER_ID, MODEL_ID);
    expect(rev).toContain('Acme Think');
    expect(rev).toContain('128000');
    expect(rev).toMatch(/Low/);
    expect(rev).toMatch(/image/);
    expect(rev).toMatch(/0\.08|cacheRead/);
  });

  it('thinking / modalities / pricing.cacheRead 变化会改 rev（外部改这些字段不得盲签一致）', async () => {
    const before = revisionOf(PROVIDER_ID, MODEL_ID);

    await modelsCatalogStore.updateModel(PROVIDER_ID, MODEL_ID, {
      thinking: { Low: 'low', XHigh: 'ultra_wire' },
    });
    expect(revisionOf(PROVIDER_ID, MODEL_ID)).not.toBe(before);

    const afterThinking = revisionOf(PROVIDER_ID, MODEL_ID);
    await modelsCatalogStore.updateModel(PROVIDER_ID, MODEL_ID, {
      modalities: { input: ['text'], output: ['text'] },
    });
    expect(revisionOf(PROVIDER_ID, MODEL_ID)).not.toBe(afterThinking);

    const afterMod = revisionOf(PROVIDER_ID, MODEL_ID);
    await modelsCatalogStore.updateModel(PROVIDER_ID, MODEL_ID, {
      pricing: {
        currency: 'CNY',
        input: 0.99,
        output: 2.8,
        cacheRead: 0.99,
        cacheWrite: 0.2,
      },
    });
    expect(revisionOf(PROVIDER_ID, MODEL_ID)).not.toBe(afterMod);
  });
});
