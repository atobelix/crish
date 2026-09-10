/**
 * modelsCatalogIpc.test.ts —— 诚实 IPC 与序列化边界
 *
 * 钉：只打 workbench_*；读消费 providers；写出 SSOT 键；命令缺失 fail-closed。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../test-setup';
import {
  readModelsYamlIpc,
  writeModelsYamlIpc,
  serializeModelsYamlTree,
  setupModelsYamlHotReloadListener,
} from './modelsCatalogIpc';
import type { ModelsYamlTree, ProviderSpec } from './modelsCatalogTypes';

const ACME_TREE: ModelsYamlTree = {
  version: 2,
  providers: {
    acme: {
      displayName: 'Acme',
      baseUrl: 'https://example.invalid/v1',
      protocol: 'openai/chat',
      apiKey: '$ACME_API_KEY',
      headers: { 'X-Title': 'conex' },
      models: [
        {
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
        },
      ],
    },
  },
};

describe('serializeModelsYamlTree', () => {
  it('写出 §4.1 键：thinking / modalities / cacheRead / baseUrl / apiKey / protocol', () => {
    const text = serializeModelsYamlTree(ACME_TREE);
    expect(text).toContain('thinking:');
    expect(text).toContain('Low: low');
    expect(text).toContain('modalities:');
    expect(text).toContain('cacheRead: 0.1');
    expect(text).toContain('cacheWrite: 0.2');
    expect(text).toContain('baseUrl: https://example.invalid/v1');
    expect(text).toContain('apiKey: $ACME_API_KEY');
    expect(text).toContain('protocol: openai/chat');
    expect(text).toContain('X-Title: conex');
    expect(text).not.toContain('https://api.openai.com/v1');
  });

  it('写出 capabilities.tools；不写 capabilities.image/video', () => {
    const tree: ModelsYamlTree = {
      version: 2,
      providers: {
        acme: {
          displayName: 'Acme',
          baseUrl: 'https://example.invalid/v1',
          protocol: 'openai/chat',
          models: [
            {
              id: 'with-tools',
              capabilities: { tools: true, image: true, video: true },
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
            {
              id: 'no-tools',
              capabilities: { tools: false },
            },
          ],
        },
      },
    };
    const text = serializeModelsYamlTree(tree);
    expect(text).toContain('tools: true');
    expect(text).toContain('tools: false');
    expect(text).not.toMatch(/capabilities:[\s\S]*image:/);
    expect(text).not.toMatch(/capabilities:[\s\S]*video:/);
  });

  it('协议旧名写出 google/generate-content；pricing 只写 SSOT 键；窗口只写 contextWindow', () => {
    const tree: ModelsYamlTree = {
      version: 2,
      providers: {
        g: {
          displayName: 'G',
          baseUrl: 'https://generativelanguage.googleapis.com',
          protocol: 'google/interactions' as unknown as ProviderSpec['protocol'],
          compat: { thinkingFormat: 'google' },
          models: [
            {
              id: 'gemini-x',
              protocol: 'google/interactions' as unknown as ProviderSpec['protocol'],
              contextLength: 1_000_000,
              pricing: {
                currency: 'USD',
                inputPerMTok: 3,
                outputPerMTok: 9,
                cacheReadPerMTok: 0.3,
                cacheWritePerMTok: 0.6,
                perImageCost: 4,
              },
              compat: { thinkingFormat: 'qwen_enable_thinking' },
            },
          ],
        },
      },
    };
    const text = serializeModelsYamlTree(tree);
    expect(text).toContain('google/generate-content');
    expect(text).not.toContain('google/interactions');
    expect(text).toContain('thinkingFormat: gemini');
    expect(text).toContain('thinkingFormat: qwen');
    expect(text).not.toContain('qwen_enable_thinking');
    expect(text).toContain('input: 3');
    expect(text).toContain('output: 9');
    expect(text).toContain('cacheRead: 0.3');
    expect(text).toContain('cacheWrite: 0.6');
    expect(text).toContain('perImage: 4');
    expect(text).not.toContain('inputPerMTok');
    expect(text).not.toContain('outputPerMTok');
    expect(text).not.toContain('cacheReadPerMTok');
    expect(text).not.toContain('contextLength');
    expect(text).toContain('contextWindow: 1000000');
  });
});

describe('readModelsYamlIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('只 invoke workbench_read_models_yaml，成功消费 providers 组装 tree', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: 'C:\\tmp\\models.yaml',
      content: 'version: 2\nproviders: {}\n',
      template: 'version: 2\nproviders: {}\n',
      seeded: false,
      version: 2,
      providers: ACME_TREE.providers,
    }));

    const res = await readModelsYamlIpc();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.providers.acme.apiKey).toBe('$ACME_API_KEY');
    expect(res.data.providers.acme.models[0].thinking?.Low).toBe('low');
    expect(res.data.providers.acme.models[0].modalities?.input).toContain('image');
    expect(res.data.tree).toEqual({ version: 2, providers: res.data.providers });
    expect(res.data.tree.providers.acme.baseUrl).toBe('https://example.invalid/v1');
  });

  it('诚实空 providers: {} 视为成功', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: '/tmp/models.yaml',
      content: 'version: 2\nproviders: {}\n',
      template: '',
      seeded: true,
      providers: {},
    }));
    const res = await readModelsYamlIpc();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.providers).toEqual({});
    expect(res.data.tree).toEqual({ version: 2, providers: {} });
  });

  it('命令 missing → MISSING，不把空树当成功', async () => {
    const res = await readModelsYamlIpc();
    expect(res).toEqual({
      ok: false,
      kind: 'MISSING',
      error: 'workbench_read_models_yaml 命令未注册',
    });
  });

  it('parseError → PARSE_ERROR，不构造生产树', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: '/tmp/models.yaml',
      content: ':::bad',
      template: '',
      seeded: false,
      parseError: { line: 3, column: 1, message: 'bad indentation' },
      providers: null,
    }));
    const res = await readModelsYamlIpc();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('PARSE_ERROR');
    expect(res.error).toContain('第 3 行');
  });

  it('无 parseError 且缺少 providers → 协议漂移 fail-closed', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: '/tmp/models.yaml',
      content: 'version: 2\n',
      template: '',
      seeded: false,
      models: [{ model: 'x', vendor: 'openai' }],
    }));
    const res = await readModelsYamlIpc();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('IPC_ERROR');
    expect(res.error).toContain('providers');
  });

  it('读边界归一 google/interactions 与 thinkingFormat google', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      path: '/tmp/models.yaml',
      content: '',
      template: '',
      seeded: false,
      providers: {
        g: {
          displayName: 'G',
          baseUrl: 'https://example.invalid/gemini',
          protocol: 'google/interactions',
          compat: { thinkingFormat: 'google' },
          models: [{ id: 'g1', protocol: 'google/interactions' }],
        },
      },
    }));
    const res = await readModelsYamlIpc();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.providers.g.protocol).toBe('google/generate-content');
    expect(res.data.providers.g.compat?.thinkingFormat).toBe('gemini');
    expect(res.data.providers.g.models[0].protocol).toBe('google/generate-content');
    expect(res.data.providers.g.baseUrl).toBe('https://example.invalid/gemini');
  });
});

describe('writeModelsYamlIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('唯一路径 workbench_save_models_yaml({ content })，返回 providers 不作失败覆盖', async () => {
    let savedArgs: unknown = null;
    mockTauriCommand('workbench_save_models_yaml', (args) => {
      savedArgs = args;
      return {
        path: '/tmp/models.yaml',
        version: 2,
        providers: ACME_TREE.providers,
      };
    });

    const res = await writeModelsYamlIpc(ACME_TREE);
    expect(res.ok).toBe(true);
    expect(res.providers?.acme.models[0].thinking?.Low).toBe('low');
    expect(savedArgs).toEqual({
      content: expect.stringContaining('acme-think'),
    });
    const content = (savedArgs as { content: string }).content;
    expect(content).toContain('thinking:');
    expect(content).toContain('cacheRead:');
  });

  it('写失败返回 ok:false，不附带空 providers', async () => {
    mockTauriError('workbench_save_models_yaml', 'Permission denied');
    const res = await writeModelsYamlIpc(ACME_TREE);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Permission denied');
    expect(res.providers).toBeUndefined();
  });

  it('命令 missing → ok:false', async () => {
    const res = await writeModelsYamlIpc(ACME_TREE);
    expect(res).toEqual({
      ok: false,
      error: 'workbench_save_models_yaml 命令不可用',
    });
  });
});

describe('setupModelsYamlHotReloadListener', () => {
  it('为 no-op：不抛错，cleanup 可调用', () => {
    const off = setupModelsYamlHotReloadListener(async () => {
      throw new Error('不应被热重载回调触发');
    });
    expect(typeof off).toBe('function');
    off();
  });
});
