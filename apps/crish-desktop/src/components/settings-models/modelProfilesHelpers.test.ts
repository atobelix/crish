import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderProfile } from '../../api/providerProfiles';
import { mockTauriCommand } from '../../test-setup';
import {
  modelsCatalogStore,
  selectModel,
} from '../../api/modelsCatalogStore';
import type { ModelSpec, ProviderSpec } from '../../api/modelsCatalogTypes';
import {
  foldSettingsProfiles,
  modelSpecRevision,
  pickSettingsSelectedId,
  resolveSettingsSelectedId,
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

describe('modelProfilesHelpers 设置列表折叠', () => {
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

  it('foldSettingsProfiles 同展示名只留一行且保留停用项', () => {
    const folded = foldSettingsProfiles([copy, seed, zen, disabled]);
    expect(folded.map((p) => p.id)).toEqual([
      'opencode-go',
      'opencode-zen',
      'off',
    ]);
    expect(
      folded.filter((p) => p.name === 'OpenCode Go 订阅')
    ).toHaveLength(1);
  });

  it('resolveSettingsSelectedId 把被折叠的拷贝改绑胜者', () => {
    const raw = [seed, copy, zen];
    const folded = foldSettingsProfiles(raw);
    expect(resolveSettingsSelectedId(folded, raw, 'preset-opencode-go')).toBe(
      'opencode-go'
    );
    expect(resolveSettingsSelectedId(folded, raw, 'opencode-go')).toBe(
      'opencode-go'
    );
    expect(resolveSettingsSelectedId(folded, raw, 'missing')).toBe('');
  });

  it('pickSettingsSelectedId：已选拷贝 → 胜者；否则活动；否则首行', () => {
    const raw = [seed, copy, zen];
    const folded = foldSettingsProfiles(raw);
    expect(
      pickSettingsSelectedId(folded, raw, 'preset-opencode-go', 'opencode-zen')
    ).toBe('opencode-go');
    expect(pickSettingsSelectedId(folded, raw, null, 'opencode-zen')).toBe(
      'opencode-zen'
    );
    expect(pickSettingsSelectedId(folded, raw, null, 'gone')).toBe(
      'opencode-go'
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
      tree: { version: 2, activeModel: null, providers: structuredClone(PROVIDERS) },
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
