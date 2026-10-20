// @vitest-environment jsdom
/**
 * T2-7 §9.2 #8：启用开关关闭后 yaml 该节点 enabled: false。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { parse as parseYaml } from 'yaml';
import { mockTauriCommand } from '../../test-setup';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import { ModelList } from './ModelList';

const LIST_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ModelList.tsx'),
  'utf8'
);

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

function lastSavedYaml(saveImpl: ReturnType<typeof vi.fn>): string {
  const last = saveImpl.mock.calls[saveImpl.mock.calls.length - 1]?.[0] as
    { tree?: unknown } | undefined;
  return JSON.stringify(last?.tree ?? null);
}

describe('ModelList 启用开关写 yaml', () => {
  let saveImpl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    modelsCatalogStore.resetForTesting();
    localStorage.clear();
    localStorage.setItem(
      'crish_models_ls_import_v1',
      JSON.stringify({ done: true, version: 1 })
    );
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: CATALOG_PATH,
      content: '',
      template: '',
      revision: 'revision-0',
      credentialStates: {},
      parseError: null,
      tree: {
        version: 2,
        activeModel: null,
        providers: {
          acme: {
            displayName: 'Acme',
            baseUrl: 'https://example.invalid/v1',
            protocol: 'openai/chat',
            models: [
              {
                id: 'acme-think',
                displayName: 'Acme Think',
                enabled: true,
                thinking: { Low: 'low' },
              },
            ],
          },
        },
      },
    }));
    saveImpl = vi.fn((args: unknown) => {
      const { tree } = args as { tree: unknown };
      return {
        path: CATALOG_PATH,
        revision: 'revision-1',
        content: '',
        template: '',
        credentialStates: {},
        parseError: null,
        tree,
      };
    });
    mockTauriCommand('workbench_apply_models_config', saveImpl);
    await modelsCatalogStore.ensureLoaded(true);
  });

  afterEach(() => {
    modelsCatalogStore.resetForTesting();
  });

  it('停用开关 → yaml enabled: false，thinking 不被空草稿覆盖', async () => {
    render(
      <ModelList
        providerId="acme"
        modelsList={['acme-think']}
        modelsCount={1}
        modelFilter=""
        configOpenId={null}
        cfgDraft={null}
        setCfgDraft={vi.fn()}
        openConfigFor={vi.fn()}
        closeConfig={vi.fn()}
        saveConfig={vi.fn()}
        runTest={vi.fn(async () => {})}
        testBusy={null}
        refresh={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('switch', { name: '停用模型' }));

    await waitFor(() => {
      expect(lastSavedYaml(saveImpl)).toMatch(/enabled":\s*false/);
    });

    const doc = parseYaml(lastSavedYaml(saveImpl)) as {
      providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
    };
    const node = doc.providers?.acme?.models?.find(
      (m) => m.id === 'acme-think'
    );
    expect(node?.enabled).toBe(false);
    expect(node?.thinking).toEqual({ Low: 'low' });
  });

  it('展示名/开关/窗口读 selectModel，getModelMeta 仅 lastTest', () => {
    expect(LIST_SRC).toMatch(/\bgetLiveModel\s*\(/);
    expect(LIST_SRC).toMatch(/model\?\.displayName/);
    expect(LIST_SRC).toMatch(/model\?\.enabled/);
    expect(LIST_SRC).toMatch(/model\?\.contextWindow/);
    expect(LIST_SRC).not.toMatch(
      /getModelMeta\([^)]+\)\.(enabled|displayName|contextWindow|contextLength)/
    );
    expect(LIST_SRC).toMatch(/getModelMeta\([^)]+\)\.lastTest/);
  });
});
