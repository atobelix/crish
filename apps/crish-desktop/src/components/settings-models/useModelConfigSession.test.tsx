// @vitest-environment jsdom
/**
 * T2-7：抽屉 saveConfig 的完成句是 yaml 文本含字段，不是 setter spy / 有保存按钮。
 * mock 仅 workbench_read_models_yaml / workbench_save_models_yaml。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { parse as parseYaml } from 'yaml';
import { invoke } from '@tauri-apps/api/core';
import {
  mockTauriCommand,
  mockTauriError,
} from '../../test-setup';
import {
  modelsCatalogStore,
  selectModel,
} from '../../api/modelsCatalogStore';
import * as pricingStore from '../../api/pricingStore';
import type { ProviderProfile } from '../../api/providerProfiles';
import type { ModelSpec, ProviderSpec } from '../../api/modelsCatalogTypes';
import { useModelConfigSession } from './useModelConfigSession';
import type { ConfigDraft } from './modelsIpcHelpers';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';
const PROVIDER_ID = 'acme';
const MODEL_ID = 'acme-think';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  commit: vi.fn(),
  invalidate: vi.fn(),
  isOpen: vi.fn(),
  notify: vi.fn(),
  refresh: vi.fn(),
  setManualOpen: vi.fn(),
}));

vi.mock('../../api/chat-bridge/editSessionConsumer', () => ({
  editSessionConsumer: {
    open: mocks.open,
    commit: mocks.commit,
    invalidate: mocks.invalidate,
    isOpen: mocks.isOpen,
  },
  invalidateEditObjects: vi.fn(),
  bindEditSession: vi.fn(),
  getBoundEditSession: vi.fn(() => null),
  isEditSessionConsumerBound: vi.fn(() => false),
}));

const BASE_MODEL: ModelSpec = {
  id: MODEL_ID,
  displayName: 'Acme Think',
  contextWindow: 128000,
  maxOutputTokens: 8192,
  enabled: true,
  capabilities: { tools: true },
  thinking: { Low: 'low', High: 'high' },
  modalities: { input: ['text'], output: ['text'] },
  pricing: {
    currency: 'USD',
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 0.2,
  },
};

const BASE_PROVIDERS: Record<string, ProviderSpec> = {
  [PROVIDER_ID]: {
    displayName: 'Acme',
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai/chat',
    models: [BASE_MODEL],
  },
};

const SELECTED: ProviderProfile = {
  id: PROVIDER_ID,
  name: 'Acme',
  baseUrl: 'https://example.invalid/v1',
  models: [MODEL_ID],
  hasKey: true,
  protocol: 'openai/chat',
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

function mockSaveOk(): ReturnType<typeof vi.fn> {
  const impl = vi.fn((_args: unknown) => ({ path: CATALOG_PATH }));
  mockTauriCommand('workbench_save_models_yaml', impl);
  return impl;
}

function lastSavedYaml(saveImpl: ReturnType<typeof vi.fn>): string {
  const calls = saveImpl.mock.calls;
  const last = calls[calls.length - 1]?.[0] as { content?: string } | undefined;
  return last?.content ?? '';
}

function parseProviders(content: string): {
  protocol?: string;
  models?: Array<Record<string, unknown>>;
} {
  const doc = parseYaml(content) as {
    providers?: Record<string, { protocol?: string; models?: Array<Record<string, unknown>> }>;
  };
  return doc.providers?.[PROVIDER_ID] ?? {};
}

function parseModel(content: string): Record<string, unknown> | undefined {
  const models = parseProviders(content).models ?? [];
  return models.find((m) => m.id === MODEL_ID);
}

function assertCanonicalWrite(content: string): void {
  expect(content).not.toMatch(/inputPerMTok/);
  expect(content).not.toMatch(/outputPerMTok/);
  expect(content).not.toMatch(/cacheReadPerMTok/);
  expect(content).not.toMatch(/contextLength:/);
  expect(content).not.toMatch(/defaultThinkingLevel/);
  expect(content).not.toMatch(/google\/interactions/);
  expect(content).not.toMatch(/\blevels:/);
}

function invokedCommands(): string[] {
  return (invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    (c) => String(c[0])
  );
}

const FULL_DRAFT: ConfigDraft = {
  displayName: 'Acme Think',
  contextLength: '200000',
  maxOutputTokens: '8192',
  caps: { tools: true, image: true, video: false, reasoning: true },
  thinkingEnabled: true,
  thinkingMap: { Low: 'low', CustomUltra: 'ultra_wire' },
  modalities: { input: ['text', 'image'], output: ['text'] },
  pricing: {
    currency: 'CNY',
    input: '0.99',
    output: '2.8',
    cacheRead: '0.08',
    cacheWrite: '0.2',
  },
};

function useSessionHarness(selected: ProviderProfile) {
  const [configOpenId, setConfigOpenId] = useState<string | null>(null);
  const [cfgDraft, setCfgDraft] = useState<ConfigDraft | null>(null);
  const runAsLocalMutation = useCallback(async <T,>(fn: () => Promise<T> | T) => {
    return await fn();
  }, []);
  const session = useModelConfigSession({
    selected,
    configOpenId,
    cfgDraft,
    setConfigOpenId,
    setCfgDraft,
    setManualOpen: mocks.setManualOpen,
    refresh: mocks.refresh,
    notify: mocks.notify,
    runAsLocalMutation,
  });
  return { ...session, configOpenId, cfgDraft, setCfgDraft, notify: mocks.notify };
}

async function awaitSave(fn: () => unknown): Promise<void> {
  await act(async () => {
    const ret = fn();
    await Promise.resolve(ret);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useModelConfigSession 保存即落盘 yaml', () => {
  let saveImpl: ReturnType<typeof vi.fn>;
  let upsertSpy: ReturnType<typeof vi.spyOn>;
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    modelsCatalogStore.resetForTesting();
    localStorage.clear();
    localStorage.setItem(
      'crish_models_ls_import_v1',
      JSON.stringify({ done: true, version: 1 })
    );
    mockTauriCommand('workbench_read_models_yaml', () =>
      workbenchReadOk(structuredClone(BASE_PROVIDERS))
    );
    saveImpl = mockSaveOk();
    const loaded = await modelsCatalogStore.ensureLoaded(true);
    expect(loaded).toBe(true);
    upsertSpy = vi.spyOn(pricingStore, 'upsertPrice');
    setItemSpy = vi.spyOn(localStorage, 'setItem');
  });

  afterEach(() => {
    upsertSpy.mockRestore();
    setItemSpy.mockRestore();
    modelsCatalogStore.resetForTesting();
  });

  it('改 thinking / modalities / pricing.cacheRead 后保存：write content 含这些键且 cacheRead 不是 input×0.1', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));

    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({ ...FULL_DRAFT });
    });

    await awaitSave(() => result.current.saveConfig());

    await waitFor(() => {
      expect(lastSavedYaml(saveImpl).length).toBeGreaterThan(0);
    });

    const content = lastSavedYaml(saveImpl);
    assertCanonicalWrite(content);
    expect(content).toContain('thinking:');
    expect(content).toContain('CustomUltra');
    expect(content).toContain('ultra_wire');
    expect(content).toContain('modalities:');
    expect(content).toContain('cacheRead:');
    expect(content).toContain('contextWindow:');
    expect(content).not.toContain('contextLength:');

    const node = parseModel(content);
    expect(node).toBeTruthy();
    expect(node?.thinking).toEqual({ Low: 'low', CustomUltra: 'ultra_wire' });
    expect(node?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
    const pricing = node?.pricing as Record<string, unknown> | undefined;
    expect(pricing?.currency).toBe('CNY');
    expect(pricing?.input).toBe(0.99);
    expect(pricing?.output).toBe(2.8);
    expect(pricing?.cacheRead).toBe(0.08);
    expect(pricing?.cacheWrite).toBe(0.2);
    expect(pricing?.cacheRead).not.toBeCloseTo(0.99 * 0.1);
    expect(node?.contextWindow).toBe(200000);

    expect(invokedCommands()).toContain('workbench_save_models_yaml');
    expect(invokedCommands()).not.toContain('models_yaml_write');
    expect(mocks.commit).toHaveBeenCalledWith(`${PROVIDER_ID}::${MODEL_ID}`);
  });

  it('关掉推理后保存：该节点无 thinking 键', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));
    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({
        ...FULL_DRAFT,
        thinkingEnabled: false,
        caps: { ...FULL_DRAFT.caps, reasoning: false },
      });
    });

    await awaitSave(() => result.current.saveConfig());
    await waitFor(() => {
      expect(lastSavedYaml(saveImpl).length).toBeGreaterThan(0);
    });

    const node = parseModel(lastSavedYaml(saveImpl));
    expect(node).toBeTruthy();
    expect(node).not.toHaveProperty('thinking');
    expect(lastSavedYaml(saveImpl)).not.toMatch(
      new RegExp(`id: ${MODEL_ID}[\\s\\S]*thinking:`)
    );
  });

  it('改 modalities 增删 image：yaml modalities.input 同步', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));
    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({
        ...FULL_DRAFT,
        modalities: { input: ['text', 'image'], output: ['text'] },
        caps: { ...FULL_DRAFT.caps, image: true },
      });
    });

    await awaitSave(() => result.current.saveConfig());
    await waitFor(() => {
      expect(parseModel(lastSavedYaml(saveImpl))?.modalities).toBeTruthy();
    });

    const node = parseModel(lastSavedYaml(saveImpl));
    expect(node?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
  });

  it('填四维价 CNY：yaml pricing 四键与 currency，cacheRead 等于输入值', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));
    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({
        ...FULL_DRAFT,
        pricing: {
          currency: 'CNY',
          input: '0.99',
          output: '2.8',
          cacheRead: '0.08',
          cacheWrite: '0.2',
        },
      });
    });

    await awaitSave(() => result.current.saveConfig());
    await waitFor(() => {
      expect(lastSavedYaml(saveImpl)).toContain('cacheRead:');
    });

    const pricing = parseModel(lastSavedYaml(saveImpl))?.pricing as
      | Record<string, unknown>
      | undefined;
    expect(pricing).toMatchObject({
      currency: 'CNY',
      input: 0.99,
      output: 2.8,
      cacheRead: 0.08,
      cacheWrite: 0.2,
    });
  });

  it('四维全空保存：节点无 pricing；upsertPrice 零调用', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));
    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({
        ...FULL_DRAFT,
        pricing: {
          currency: 'USD',
          input: '',
          output: '',
          cacheRead: '',
          cacheWrite: '',
        },
      });
    });

    upsertSpy.mockClear();
    await awaitSave(() => result.current.saveConfig());
    await waitFor(() => {
      expect(lastSavedYaml(saveImpl).length).toBeGreaterThan(0);
    });

    const node = parseModel(lastSavedYaml(saveImpl));
    expect(node).toBeTruthy();
    expect(node).not.toHaveProperty('pricing');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('改上下文 1048576：yaml contextWindow 为该数，不含 contextLength 键', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));
    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({
        ...FULL_DRAFT,
        contextLength: '1048576',
      });
    });

    await awaitSave(() => result.current.saveConfig());
    await waitFor(() => {
      expect(parseModel(lastSavedYaml(saveImpl))?.contextWindow).toBe(1048576);
    });

    const content = lastSavedYaml(saveImpl);
    expect(content).toContain('contextWindow: 1048576');
    expect(content).not.toContain('contextLength:');
  });

  it('写盘拒绝：捕获命令失败；LS 三键不被 setItem；草稿仍在', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));
    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({ ...FULL_DRAFT });
    });

    mockTauriError('workbench_save_models_yaml', 'Permission denied');
    setItemSpy.mockClear();

    await awaitSave(() => result.current.saveConfig());

    await waitFor(() => {
      expect(result.current.notify).toHaveBeenCalled();
    });

    const failMsg = result.current.notify.mock.calls.find(
      (c) => c[0] === false
    )?.[1];
    expect(String(failMsg ?? '')).toMatch(/Permission denied|写入|保存失败|拒绝/);
    expect(result.current.cfgDraft).not.toBeNull();
    expect(result.current.cfgDraft?.thinkingMap?.CustomUltra).toBe('ultra_wire');
    expect(mocks.commit).not.toHaveBeenCalled();

    const banned = setItemSpy.mock.calls.filter(
      (c) =>
        c[0] === 'crish_model_meta_v1' ||
        c[0] === 'crish_model_prices_v1' ||
        c[0] === 'crish_provider_profiles_v1'
    );
    expect(banned).toHaveLength(0);

    // 内存回滚：磁盘未写上，store 仍是打开时的节点
    expect(selectModel(PROVIDER_ID, MODEL_ID)?.thinking).toEqual({
      Low: 'low',
      High: 'high',
    });
  });

  it('CT-01：打开后 store 被外部改过 → 保存拒绝，不把陈旧草稿写盘', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));
    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({
        ...FULL_DRAFT,
        displayName: '陈旧草稿名',
      });
    });

    saveImpl.mockClear();
    await modelsCatalogStore.updateModel(PROVIDER_ID, MODEL_ID, {
      contextWindow: 777777,
      displayName: '外部已改',
    });
    const callsAfterExternal = saveImpl.mock.calls.length;
    const yamlAfterExternal = lastSavedYaml(saveImpl);
    expect(parseModel(yamlAfterExternal)?.contextWindow).toBe(777777);

    await awaitSave(() => result.current.saveConfig());

    expect(result.current.notify).toHaveBeenCalledWith(
      false,
      '配置已被外部修改，保存已取消，请重新确认'
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      `${PROVIDER_ID}::${MODEL_ID}`,
      'external'
    );
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(result.current.cfgDraft).not.toBeNull();
    expect(saveImpl.mock.calls.length).toBe(callsAfterExternal);
    expect(lastSavedYaml(saveImpl)).not.toContain('陈旧草稿名');
    expect(parseModel(lastSavedYaml(saveImpl))?.displayName).toBe('外部已改');
  });

  it('保存成功后不以 crish_model_meta_v1 / crish_model_prices_v1 为 key 写入本次 thinking/pricing', async () => {
    const { result } = renderHook(() => useSessionHarness(SELECTED));
    act(() => {
      result.current.openConfigFor(MODEL_ID);
    });
    act(() => {
      result.current.setCfgDraft({ ...FULL_DRAFT });
    });
    setItemSpy.mockClear();

    await awaitSave(() => result.current.saveConfig());
    await waitFor(() => {
      expect(lastSavedYaml(saveImpl)).toContain('ultra_wire');
    });

    for (const [key, value] of setItemSpy.mock.calls) {
      if (key === 'crish_model_meta_v1' || key === 'crish_model_prices_v1') {
        expect(String(value)).not.toContain('ultra_wire');
        expect(String(value)).not.toContain('"cacheRead":0.08');
      }
    }
  });
});
