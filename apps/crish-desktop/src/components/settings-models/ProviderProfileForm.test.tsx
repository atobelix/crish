// @vitest-environment jsdom
/**
 * T2-7 §9.2 #7：服务商协议 Select 改 google/generate-content 后，
 * 捕获 workbench_save_models_yaml 文本含该字面量。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { parse as parseYaml } from 'yaml';
import { mockTauriCommand } from '../../test-setup';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import type { ProviderProfile } from '../../api/providerProfiles';
import { ProviderProfileForm } from './ProviderProfileForm';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

vi.mock('../../api/providerProfiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/providerProfiles')>();
  return {
    ...actual,
    saveProfileBaseUrl: vi.fn(async () => ({ ok: true })),
    upsertProfile: vi.fn(),
  };
});

const SELECTED: ProviderProfile = {
  id: 'acme',
  name: 'Acme',
  baseUrl: 'https://example.invalid/v1',
  models: ['acme-think'],
  hasKey: true,
  protocol: 'openai/chat',
};

function lastSavedYaml(saveImpl: ReturnType<typeof vi.fn>): string {
  const last = saveImpl.mock.calls[saveImpl.mock.calls.length - 1]?.[0] as
    | { tree?: unknown }
    | undefined;
  return JSON.stringify(last?.tree ?? null);
}

describe('ProviderProfileForm 协议写 yaml', () => {
  let saveImpl: ReturnType<typeof vi.fn>;
  let setItemSpy: ReturnType<typeof vi.spyOn>;

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
          models: [{ id: 'acme-think', displayName: 'Acme Think' }],
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
    setItemSpy = vi.spyOn(localStorage, 'setItem');
  });

  afterEach(() => {
    setItemSpy.mockRestore();
    modelsCatalogStore.resetForTesting();
  });

  it('协议选项只含默认三种（用户裁决：google/generate-content 不再可选）', async () => {
    render(
      <ProviderProfileForm
        selected={SELECTED}
        hasKeySelected={true}
        keyDraft=""
        setKeyDraft={vi.fn()}
        saveKey={vi.fn(async () => {})}
        notify={vi.fn()}
        refresh={vi.fn()}
        defaultCollapsed={false}
      />
    );

    fireEvent.click(screen.getByRole('combobox'));
    await screen.findByRole('option', { name: /Anthropic Messages/ });
    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent || '');
    const lower = labels.join(' ').toLowerCase();
    expect(lower).toContain('openai chat');
    expect(lower).toContain('openai responses');
    expect(lower).toContain('anthropic messages');
    expect(lower).not.toContain('google/generate-content');

    // 仍可选默认三种之一并写入 yaml（选择 anthropic 验证写路径）
    const anthropicOpt = options.find((o) =>
      /Anthropic Messages/.test(o.textContent || '')
    );
    fireEvent.click(anthropicOpt!);

    await waitFor(() => {
      expect(lastSavedYaml(saveImpl)).toContain(
        '"protocol":"anthropic/messages"'
      );
    });

    const content = lastSavedYaml(saveImpl);
    const doc = parseYaml(content) as {
      providers?: Record<string, { protocol?: string }>;
    };
    expect(doc.providers?.acme?.protocol).toBe('anthropic/messages');

    const profileWrites = setItemSpy.mock.calls.filter(
      (c) => c[0] === 'crish_provider_profiles_v1'
    );
    for (const [, val] of profileWrites) {
      expect(String(val)).not.toMatch(/google\/generate-content/);
    }
  });

  it('连接与凭据已配置时默认折叠：点击标题展开/收起表单', () => {
    render(
      <ProviderProfileForm
        selected={SELECTED}
        hasKeySelected={true}
        keyDraft=""
        setKeyDraft={vi.fn()}
        saveKey={vi.fn(async () => {})}
        notify={vi.fn()}
        refresh={vi.fn()}
      />
    );

    // 默认折叠，显示「连接与凭据」及「已配置」微标签
    expect(screen.getByText('连接与凭据')).toBeInTheDocument();
    expect(screen.getByText('已配置')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    // 点击展开
    fireEvent.click(screen.getByText('连接与凭据'));
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    // 再次点击收起
    fireEvent.click(screen.getByText('连接与凭据'));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('自定义服务商渲染「厂商名称」必填项且标签去除紫色冗余副标题', () => {
    const customProfile: ProviderProfile = {
      id: 'custom-12345',
      name: '',
      baseUrl: '',
      models: [],
      hasKey: false,
      protocol: 'openai/chat',
    };

    render(
      <ProviderProfileForm
        selected={customProfile}
        hasKeySelected={false}
        keyDraft=""
        setKeyDraft={vi.fn()}
        saveKey={vi.fn(async () => {})}
        notify={vi.fn()}
        refresh={vi.fn()}
      />
    );

    // 未配置服务商默认展开
    expect(screen.getByText(/厂商名称/)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('例如: senseNova、SiliconFlow、Ollama（必填）')
    ).toBeInTheDocument();

    // 首要通信协议标签无 (Default Protocol) 或继承提示
    expect(screen.getByText('首要通信协议')).toBeInTheDocument();
    expect(screen.queryByText(/Default Protocol/)).not.toBeInTheDocument();
    expect(screen.queryByText(/该服务商下属模型默认继承此协议/)).not.toBeInTheDocument();
  });
});
