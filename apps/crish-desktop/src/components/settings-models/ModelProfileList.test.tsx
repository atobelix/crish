// @vitest-environment jsdom
/**
 * 设置页默认模型级联：启用过滤 / 展示名只读 live 树，不读 getModelMeta。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockTauriCommand } from '../../test-setup';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import type { ProviderProfile } from '../../api/providerProfiles';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import {
  FALLBACK_EMPTY_SELECTION,
  ModelsCascadeSelect,
} from './ModelProfileList';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ModelProfileList.tsx'),
  'utf8'
);

const CREDENTIAL_PROFILES: ProviderProfile[] = [
  {
    id: 'acme',
    name: 'Acme From LS',
    baseUrl: 'https://example.invalid/v1',
    models: ['acme-on', 'acme-off', 'ghost-from-ls'],
    hasKey: true,
    enabled: true,
  },
];

const LIVE_PROVIDERS: Record<string, ProviderSpec> = {
  acme: {
    displayName: 'Acme Live',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai/chat',
    models: [
      { id: 'acme-on', displayName: 'Live On', enabled: true },
      { id: 'acme-off', displayName: 'Live Off', enabled: false },
    ],
  },
  other: {
    displayName: 'Other Co',
    baseUrl: 'https://other.invalid/v1',
    protocol: 'openai/chat',
    enabled: false,
    models: [{ id: 'other-m', displayName: 'Other Model', enabled: true }],
  },
};

async function seedCatalog(
  providers: Record<string, ProviderSpec>
): Promise<void> {
  modelsCatalogStore.resetForTesting();
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    seeded: false,
    parseError: null,
    providers: structuredClone(providers),
  }));
  mockTauriCommand('workbench_save_models_yaml', () => ({ path: CATALOG_PATH }));
  await modelsCatalogStore.ensureLoaded(true);
}

describe('ModelsCascadeSelect live 启用过滤', () => {
  beforeEach(async () => {
    await seedCatalog(LIVE_PROVIDERS);
  });

  afterEach(() => {
    cleanup();
    modelsCatalogStore.resetForTesting();
  });

  it('触发器展示 live 展示名，不读凭据壳名称', () => {
    render(
      <ModelsCascadeSelect
        profiles={CREDENTIAL_PROFILES}
        activeProfileId="acme"
        activeModelId="acme-on"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText('Acme Live · Live On')).toBeInTheDocument();
    expect(screen.queryByText(/Acme From LS/)).not.toBeInTheDocument();
  });

  it('停用模型与停用供应商不出现在级联；凭据壳幽灵 id 也不出现', async () => {
    render(
      <ModelsCascadeSelect
        profiles={CREDENTIAL_PROFILES}
        activeProfileId="acme"
        activeModelId="acme-on"
        onChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Acme Live')).toBeInTheDocument();
    expect(screen.queryByText('Other Co')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'ArrowRight' });
    expect(await screen.findByRole('option', { name: /Live On/ })).toBeInTheDocument();
    expect(screen.queryByText('Live Off')).not.toBeInTheDocument();
    expect(screen.queryByText('ghost-from-ls')).not.toBeInTheDocument();
    expect(screen.queryByText('Other Model')).not.toBeInTheDocument();
  });

  it('yaml 停用当前活动模型后触发器离开该模型', async () => {
    render(
      <ModelsCascadeSelect
        profiles={CREDENTIAL_PROFILES}
        activeProfileId="acme"
        activeModelId="acme-on"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText('Acme Live · Live On')).toBeInTheDocument();

    await act(async () => {
      await modelsCatalogStore.updateModel('acme', 'acme-on', { enabled: false });
    });

    await waitFor(() => {
      expect(
        screen.getByText(FALLBACK_EMPTY_SELECTION.triggerLabel)
      ).toBeInTheDocument();
    });
  });

  it('全停用走安全空态，不回落凭据壳 models', async () => {
    await seedCatalog({
      acme: {
        displayName: 'Acme Live',
        baseUrl: 'https://example.invalid/v1',
        protocol: 'openai/chat',
        models: [{ id: 'acme-off', displayName: 'Live Off', enabled: false }],
      },
    });
    render(
      <ModelsCascadeSelect
        profiles={CREDENTIAL_PROFILES}
        activeProfileId="acme"
        activeModelId="acme-off"
        onChange={vi.fn()}
      />
    );
    expect(
      screen.getByText(FALLBACK_EMPTY_SELECTION.triggerLabel)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(
      await screen.findByText(FALLBACK_EMPTY_SELECTION.emptyMenuText)
    ).toBeInTheDocument();
  });

  it('生产源码不订 useModelMetaTick、不把 getModelMeta 当 enabled/displayName', () => {
    expect(SRC).not.toMatch(/\buseModelMetaTick\b/);
    expect(SRC).not.toMatch(/\bgetModelMeta\s*\(/);
    expect(SRC).not.toMatch(/\bformatModelDisplayName\b/);
    expect(SRC).toMatch(/\buseModelsCatalogVersion\b/);
    expect(SRC).toMatch(/\blistLivePickerEntries\b/);
    expect(SRC).toMatch(/\bgetLiveModel\b/);
  });
});
