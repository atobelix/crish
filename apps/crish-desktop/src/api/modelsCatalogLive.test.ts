/**
 * modelsCatalogLive.test.ts —— 生产唯一读 API
 *
 * 钉：未加载/找不到不猜测；同 id 跨厂商必须 providerId；
 * 视觉只信 modalities.input；思考无合成「默认」；窗口缺省 undefined。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../test-setup';
import {
  getLiveModel,
  getLiveProvider,
  listLivePickerEntries,
  listThinkingOptions,
  modelAcceptsInput,
  resolveThinkingHandoff,
} from './modelsCatalogLive';
import {
  ensureModelsCatalogLoaded,
  modelsCatalogStore,
  resetModelsCatalogMirror,
  selectEffectiveContextWindow,
  selectModel,
} from './modelsCatalogStore';
import type { ModalityMatrix, ProviderSpec } from './modelsCatalogTypes';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

const LIVE_PROVIDERS: Record<string, ProviderSpec> = {
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai/chat',
    models: [
      {
        id: 'gpt-4o',
        displayName: 'GPT-4o Fake',
        protocol: 'openai/chat',
        contextWindow: 200_000,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: { image: true },
        enabled: true,
      },
      {
        id: 'o3',
        displayName: 'o3',
        thinking: { Low: 'low', High: 'high' },
        modalities: { input: ['text'], output: ['text'] },
        compat: { thinkingFormat: 'openai' },
      },
      {
        id: 'disabled-model',
        enabled: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    ],
  },
  gemini: {
    displayName: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'google/generate-content',
    compat: { thinkingFormat: 'gemini' },
    models: [
      {
        id: 'gpt-4o',
        protocol: 'google/generate-content',
        thinking: { Off: 'disabled', High: 'HIGH' },
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    ],
  },
  offvendor: {
    displayName: 'Off',
    baseUrl: 'https://off.invalid',
    protocol: 'openai/chat',
    enabled: false,
    models: [{ id: 'hidden', modalities: { input: ['text'], output: ['text'] } }],
  },
  emptythink: {
    displayName: 'EmptyThink',
    baseUrl: 'https://empty.invalid',
    protocol: 'openai/chat',
    models: [
      { id: 'blank', thinking: {}, modalities: { input: ['text'], output: ['text'] } },
      { id: 'no-mod' },
      {
        id: 'bad-mod',
        modalities: { input: 'text' as unknown as string[], output: ['text'] },
      },
      {
        id: 'no-input',
        modalities: { output: ['text'] } as ModalityMatrix,
      },
    ],
  },
};

function workbenchReadOk(providers: Record<string, ProviderSpec>) {
  return {
    path: CATALOG_PATH,
    content: '',
    template: '',
    seeded: false,
    parseError: null,
    providers,
  };
}

function mockReadOk(providers: Record<string, ProviderSpec>): void {
  mockTauriCommand('workbench_read_models_yaml', () => workbenchReadOk(providers));
}

async function loadProviders(providers: Record<string, ProviderSpec>): Promise<void> {
  mockReadOk(providers);
  mockTauriCommand('workbench_save_models_yaml', () => ({ path: CATALOG_PATH }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res).toEqual({ ok: true, path: CATALOG_PATH });
  expect(modelsCatalogStore.getState().loaded).toBe(true);
}

describe('modelsCatalogLive 唯一读 API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelsCatalogMirror();
  });

  it('未加载：getLive* 为 undefined，列表空，视觉闭，思考空，handoff 不支持', () => {
    expect(modelsCatalogStore.getState().loaded).toBe(false);
    expect(getLiveProvider('openai')).toBeUndefined();
    expect(getLiveModel('openai', 'gpt-4o')).toBeUndefined();
    expect(listLivePickerEntries()).toEqual([]);
    expect(modelAcceptsInput('openai', 'gpt-4o', 'image')).toBe(false);
    expect(listThinkingOptions('openai', 'o3')).toEqual([]);
    expect(resolveThinkingHandoff('openai', 'o3', 'High')).toEqual({
      supported: false,
      providerId: 'openai',
      modelId: 'o3',
      thinking: undefined,
      selectedTitle: null,
      selectedWire: null,
    });
  });

  it('加载失败后快照仍在，live 仍视为未加载，禁止猜对象', async () => {
    await loadProviders(LIVE_PROVIDERS);
    expect(selectModel('openai', 'gpt-4o')).toBeDefined();

    mockTauriError('workbench_read_models_yaml', '磁盘 IO 故障');
    const bad = await ensureModelsCatalogLoaded(true);
    expect(bad.ok).toBe(false);
    expect(modelsCatalogStore.getState().loaded).toBe(false);
    expect(selectModel('openai', 'gpt-4o')?.id).toBe('gpt-4o');
    expect(getLiveModel('openai', 'gpt-4o')).toBeUndefined();
    expect(getLiveProvider('openai')).toBeUndefined();
    expect(listLivePickerEntries()).toEqual([]);
  });

  it('getLiveModel 原样交出 thinking/modalities/protocol，不改写 google/generate-content', async () => {
    await loadProviders(LIVE_PROVIDERS);

    const openai = getLiveModel('OpenAI', 'GPT-4o');
    expect(openai?.displayName).toBe('GPT-4o Fake');
    expect(openai?.protocol).toBe('openai/chat');
    expect(openai?.modalities?.input).toEqual(['text']);
    expect(openai?.contextWindow).toBe(200_000);
    expect(openai?.enabled).toBe(true);

    const gemini = getLiveModel('gemini', 'gpt-4o');
    expect(gemini?.protocol).toBe('google/generate-content');
    expect(gemini?.thinking).toEqual({ Off: 'disabled', High: 'HIGH' });
    expect(gemini?.modalities?.input).toEqual(['text', 'image']);

    expect(getLiveModel('ghost', 'gpt-4o')).toBeUndefined();
    expect(getLiveModel('openai', 'nope')).toBeUndefined();
    expect(getLiveProvider('gemini')?.protocol).toBe('google/generate-content');
    expect(getLiveProvider('nope')).toBeUndefined();
  });

  it('同 id 跨厂商：传错 provider 不得拿到另一家的 modalities / thinking / protocol', async () => {
    await loadProviders(LIVE_PROVIDERS);

    expect(getLiveModel('openai', 'gpt-4o')?.protocol).toBe('openai/chat');
    expect(getLiveModel('gemini', 'gpt-4o')?.protocol).toBe('google/generate-content');
    expect(modelAcceptsInput('openai', 'gpt-4o', 'image')).toBe(false);
    expect(modelAcceptsInput('gemini', 'gpt-4o', 'image')).toBe(true);
    expect(listThinkingOptions('openai', 'gpt-4o')).toEqual([]);
    expect(listThinkingOptions('gemini', 'gpt-4o').map((o) => o.title)).toEqual(['Off', 'High']);
  });

  it('listLivePickerEntries：只含启用供应商×启用模型，顺序=yaml 插入序', async () => {
    await loadProviders(LIVE_PROVIDERS);

    const entries = listLivePickerEntries();
    expect(entries.map((e) => `${e.providerId}::${e.model.id}`)).toEqual([
      'openai::gpt-4o',
      'openai::o3',
      'gemini::gpt-4o',
      'emptythink::blank',
      'emptythink::no-mod',
      'emptythink::bad-mod',
      'emptythink::no-input',
    ]);
    expect(entries.some((e) => e.model.id === 'disabled-model')).toBe(false);
    expect(entries.some((e) => e.providerId === 'offvendor')).toBe(false);
    expect(getLiveModel('openai', 'disabled-model')?.enabled).toBe(false);
  });

  it('modelAcceptsInput：缺 modalities / input 非数组 / 仅 capabilities.image → false', async () => {
    await loadProviders(LIVE_PROVIDERS);

    expect(modelAcceptsInput('openai', 'gpt-4o', 'image')).toBe(false);
    expect(modelAcceptsInput('openai', 'gpt-4o', 'text')).toBe(true);
    expect(modelAcceptsInput('gemini', 'gpt-4o', 'image')).toBe(true);
    expect(modelAcceptsInput('emptythink', 'no-mod', 'image')).toBe(false);
    expect(modelAcceptsInput('emptythink', 'bad-mod', 'text')).toBe(false);
    expect(modelAcceptsInput('emptythink', 'no-input', 'text')).toBe(false);
    expect(modelAcceptsInput('openai', 'missing', 'image')).toBe(false);
    expect(modelAcceptsInput('', 'gpt-4o', 'image')).toBe(false);
  });

  it('listThinkingOptions：标签=字典 key，无合成默认项；空字典=非思考', async () => {
    await loadProviders(LIVE_PROVIDERS);

    expect(listThinkingOptions('openai', 'o3')).toEqual([
      { title: 'Low', wire: 'low' },
      { title: 'High', wire: 'high' },
    ]);
    expect(listThinkingOptions('openai', 'o3').some((o) => o.title === '默认' || o.wire === 'default')).toBe(
      false
    );
    expect(listThinkingOptions('emptythink', 'blank')).toEqual([]);
    expect(listThinkingOptions('openai', 'gpt-4o')).toEqual([]);
    expect(listThinkingOptions('ghost', 'o3')).toEqual([]);
  });

  it('resolveThinkingHandoff：不在字典 → 第一项；空字典 → supported false', async () => {
    await loadProviders(LIVE_PROVIDERS);

    expect(resolveThinkingHandoff('openai', 'o3', 'High')).toMatchObject({
      supported: true,
      selectedTitle: 'High',
      selectedWire: 'high',
      thinkingFormat: 'openai',
    });
    expect(resolveThinkingHandoff('openai', 'o3', 'Medium')).toMatchObject({
      supported: true,
      selectedTitle: 'Low',
      selectedWire: 'low',
    });
    expect(resolveThinkingHandoff('openai', 'o3', null)).toMatchObject({
      supported: true,
      selectedTitle: 'Low',
      selectedWire: 'low',
    });
    expect(resolveThinkingHandoff('gemini', 'gpt-4o', 'High')).toMatchObject({
      supported: true,
      selectedTitle: 'High',
      selectedWire: 'HIGH',
      thinkingFormat: 'gemini',
      thinking: { Off: 'disabled', High: 'HIGH' },
    });
    expect(resolveThinkingHandoff('emptythink', 'blank', 'High')).toEqual({
      supported: false,
      providerId: 'emptythink',
      modelId: 'blank',
      thinking: undefined,
      selectedTitle: null,
      selectedWire: null,
    });
    expect(resolveThinkingHandoff('openai', 'gpt-4o', 'Low').supported).toBe(false);
    expect(resolveThinkingHandoff('ghost', 'o3', 'Low').supported).toBe(false);
  });

  it('生产窗口缺省 undefined：不发明 128000，不把 contextLength 当窗口', async () => {
    await loadProviders(LIVE_PROVIDERS);

    expect(getLiveModel('openai', 'gpt-4o')?.contextWindow).toBe(200_000);
    expect(selectEffectiveContextWindow('openai', 'gpt-4o')).toBe(200_000);
    expect(getLiveModel('gemini', 'gpt-4o')?.contextWindow).toBeUndefined();
    expect(selectEffectiveContextWindow('gemini', 'gpt-4o')).toBeUndefined();
    expect(selectEffectiveContextWindow('emptythink', 'no-mod')).toBeUndefined();
    expect(selectEffectiveContextWindow('ghost', 'gpt-4o')).toBeUndefined();
  });
});
