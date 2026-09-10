// @vitest-environment jsdom
/**
 * 设置页自愈读 live enabled；缺节点视为停用；禁止跨厂商。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import {
  isLiveModelEnabled,
  resolveActiveModelAfterMetaChange,
} from './ModelsSettingsTab';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ModelsSettingsTab.tsx'),
  'utf8'
);

const LIVE_PROVIDERS: Record<string, ProviderSpec> = {
  acme: {
    displayName: 'Acme',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai/chat',
    models: [
      { id: 'acme-a', displayName: 'A', enabled: false },
      { id: 'acme-b', displayName: 'B', enabled: true },
    ],
  },
  beta: {
    displayName: 'Beta',
    baseUrl: 'https://beta.invalid/v1',
    protocol: 'openai/chat',
    models: [{ id: 'beta-1', displayName: 'Beta One', enabled: true }],
  },
};

describe('ModelsSettingsTab live 自愈读源', () => {
  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      content: '',
      template: '',
      seeded: false,
      parseError: null,
      providers: structuredClone(LIVE_PROVIDERS),
    }));
    mockTauriCommand('workbench_save_models_yaml', () => ({ path: CATALOG_PATH }));
    await modelsCatalogStore.ensureLoaded(true);
  });

  afterEach(() => {
    modelsCatalogStore.resetForTesting();
  });

  it('isLiveModelEnabled：缺节点 / enabled:false 为关，缺省为开', () => {
    expect(isLiveModelEnabled('acme', 'acme-a')).toBe(false);
    expect(isLiveModelEnabled('acme', 'acme-b')).toBe(true);
    expect(isLiveModelEnabled('acme', 'missing')).toBe(false);
    expect(isLiveModelEnabled('ghost', 'acme-b')).toBe(false);
  });

  it('当前停用 → 同厂商下一个启用模型', () => {
    const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
      { profileId: 'acme', model: 'acme-a' },
      [],
      isLiveModelEnabled
    );
    expect(selfHealed).toBe(true);
    expect(nextActive).toEqual({ profileId: 'acme', model: 'acme-b' });
  });

  it('活动 id 已从 live 树删除 → 同厂商下一个，不切 beta', () => {
    const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
      { profileId: 'acme', model: 'deleted-id' },
      [],
      isLiveModelEnabled
    );
    expect(selfHealed).toBe(true);
    expect(nextActive).toEqual({ profileId: 'acme', model: 'acme-b' });
  });

  it('同厂商无可用 → 置空，严禁跨厂商', () => {
    const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
      { profileId: 'acme', model: 'acme-a' },
      [],
      (pId, m) => pId === 'beta' && m === 'beta-1'
    );
    expect(selfHealed).toBe(true);
    expect(nextActive).toBeNull();
  });

  it('仍启用则不自愈', () => {
    const current = { profileId: 'acme', model: 'acme-b' };
    const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
      current,
      [],
      isLiveModelEnabled
    );
    expect(selfHealed).toBe(false);
    expect(nextActive).toEqual(current);
  });

  it('tick / 自愈读源：catalogVersion + live enabled，不订 meta tick', () => {
    expect(SRC).toMatch(/\buseModelsCatalogVersion\b/);
    expect(SRC).toMatch(/\bisLiveModelEnabled\b/);
    expect(SRC).toMatch(/\bgetLiveModel\b/);
    expect(SRC).toMatch(/\bgetLiveProvider\b/);
    expect(SRC).not.toMatch(/\buseModelMetaTick\b/);
    expect(SRC).not.toMatch(/\bgetModelMeta\s*\(/);
  });
});
