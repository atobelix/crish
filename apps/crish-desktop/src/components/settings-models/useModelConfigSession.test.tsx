// @vitest-environment jsdom
/** 使用真实编辑 Hook、目录 Store 和 IPC 桥；只替换宿主命令及通用编辑会话通知。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { mockTauriCommand, mockTauriError } from '../../test-setup';
import { useModelConfigSession } from './useModelConfigSession';
import { modelsCatalogStore, selectModel } from '../../api/modelsCatalogStore';
import { modelRefKey } from '../../api/modelsCatalogTypes';
import type {
  ModelSpec,
  ModelsYamlTree,
  ModelsCatalogSnapshot,
} from '../../api/modelsCatalogTypes';
import type { ConfigDraft } from './modelsIpcHelpers';

const hooks = vi.hoisted(() => ({
  open: vi.fn(),
  commit: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../../api/chat-bridge/editSessionConsumer', () => ({
  editSessionConsumer: hooks,
  invalidateEditObjects: vi.fn(),
  bindEditSession: vi.fn(),
  getBoundEditSession: vi.fn(() => null),
  isEditSessionConsumerBound: vi.fn(() => false),
}));
const PROVIDER = 'Acme';
const MODEL_ID = 'Model::Shared';
const MODEL: ModelSpec = {
  id: MODEL_ID,
  displayName: 'Original',
  enabled: true,
  order: 0,
  supportsTools: false,
  contextWindow: 200000,
  maxOutputTokens: 8192,
  cacheTtl: '30m',
  protocol: 'openai/responses',
  headers: { 'X-Model-Only': 'original' },
  compat: {
    thinkingFormat: 'openai',
    cacheControlFormat: 'disabled',
    strictJsonSchema: false,
  },
  modalities: { input: ['text', 'pdf'], output: ['text'] },
  thinking: { Low: 'low', XHigh: ' wire ' },
  pricing: {
    currency: 'USD',
    unit: 'per_image',
    perImage: 0.08,
    input: 0,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0.1,
    tiers: [{ inputTokensAbove: 100, input: 3, output: 5, cacheRead: 0 }],
  },
};
let documentTree: ModelsYamlTree;
let revision: string;
let writeMock: ReturnType<typeof vi.fn>;
let revisionCounter: number;
function snapshot(): ModelsCatalogSnapshot {
  return {
    path: 'C:/test/models.yaml',
    content: JSON.stringify(documentTree),
    revision,
    tree: structuredClone(documentTree),
    credentialStates: {},
    template: '',
  };
}
function save(payload: unknown): ModelsCatalogSnapshot {
  const input = payload as { tree: ModelsYamlTree; expectedRevision: string };
  if (input.expectedRevision !== revision)
    throw { code: 'REVISION_CONFLICT', message: 'configuration changed' };
  documentTree = structuredClone(input.tree);
  revision = 'r' + ++revisionCounter;
  return snapshot();
}
const notify = vi.fn();
function useSessionHarness(selected: { id: string } | null = { id: PROVIDER }) {
  const [configOpenId, setConfigOpenId] = useState<string | null>(null);
  const [cfgDraft, setCfgDraft] = useState<ConfigDraft | null>(null);
  const session = useModelConfigSession({
    selected,
    configOpenId,
    setConfigOpenId,
    cfgDraft,
    setCfgDraft,
    setManualOpen: vi.fn(),
    notify,
    runAsLocalMutation: async <T,>(fn: () => Promise<T> | T) => await fn(),
  });
  return { ...session, cfgDraft, setCfgDraft, configOpenId };
}
beforeEach(async () => {
  vi.clearAllMocks();
  modelsCatalogStore.resetForTesting();
  documentTree = {
    version: 2,
    activeModel: null,
    providers: {
      [PROVIDER]: {
        protocol: 'openai/chat',
        enabled: true,
        stream: false,
        models: [structuredClone(MODEL)],
      },
    },
  };
  revision = 'r0';
  revisionCounter = 0;
  mockTauriCommand('workbench_read_models_yaml', snapshot);
  writeMock = vi.fn(save);
  mockTauriCommand('workbench_apply_models_config', writeMock);
  expect(await modelsCatalogStore.ensureLoaded()).toBe(true);
});

describe('真实保存调用保持完整模型', () => {
  it('只改显示名，不改价格、headers、cache、模态、false和0', async () => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        displayName: 'Renamed',
      })
    );
    await act(async () => {
      await result.current.saveConfig();
    });
    expect(documentTree.providers[PROVIDER]!.models[0]).toEqual({
      ...MODEL,
      displayName: 'Renamed',
    });
    expect(writeMock.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 'r0',
    });
    expect(hooks.commit).toHaveBeenCalledWith(
      modelRefKey({ providerId: PROVIDER, modelId: MODEL_ID })
    );
    expect(result.current.cfgDraft?.pricing?.tiers?.[0]?.input).toBe('3');
  });
  it('用户显式调整思考、模态、价格和窗口进入同次结构化提交', async () => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        contextWindow: '1048576',
        maxOutputTokens: '16384',
        supportsTools: true,
        modalities: { input: ['text', 'image'], output: [] },
        thinkingMap: { Low: 'low', 'X-High': ' special wire ' },
        pricing: {
          currency: 'CNY',
          input: '0.99',
          output: '2.8',
          cacheRead: '0.08',
          cacheWrite: '0',
          perImage: '0',
          unit: 'token',
          tiers: [],
        },
      })
    );
    await act(async () => {
      await result.current.saveConfig();
    });
    const saved = documentTree.providers[PROVIDER]!.models[0]!;
    expect(saved).toMatchObject({
      contextWindow: 1048576,
      maxOutputTokens: 16384,
      supportsTools: true,
      modalities: { input: ['text', 'image'], output: [] },
      thinking: { Low: 'low', XHigh: ' special wire ' },
      pricing: {
        currency: 'CNY',
        input: 0.99,
        cacheRead: 0.08,
        cacheWrite: 0,
        perImage: 0,
        unit: 'token',
        tiers: [],
      },
    });
    const payload = JSON.stringify(writeMock.mock.calls[0]?.[0]);
    for (const key of [
      'contextLength',
      'capabilities',
      'inputPerMTok',
      'defaultThinkingLevel',
    ])
      expect(payload).not.toContain(key);
  });
  it('关闭思考、清空上限和价格有明确删除语义', async () => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        thinkingEnabled: false,
        maxOutputTokens: '',
        pricing: undefined,
      })
    );
    await act(async () => {
      await result.current.saveConfig();
    });
    const saved = documentTree.providers[PROVIDER]!.models[0]!;
    for (const key of ['thinking', 'maxOutputTokens', 'pricing'])
      expect(saved).not.toHaveProperty(key);
    expect(saved.headers).toEqual(MODEL.headers);
  });
  it('成功保存不写任何旧配置浏览器介质', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        displayName: 'Saved',
      })
    );
    await act(async () => {
      await result.current.saveConfig();
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('保存期间的编辑输入', () => {
  it('保存回执不覆盖等待期间继续输入的草稿', async () => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        displayName: 'First edit',
      })
    );
    let complete!: () => void;
    writeMock.mockImplementationOnce(
      (payload: unknown) =>
        new Promise<ModelsCatalogSnapshot>((resolve) => {
          complete = () => resolve(save(payload));
        })
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.saveConfig();
    });
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        displayName: 'Continued typing',
      })
    );
    await act(async () => {
      complete();
      await pending;
    });
    expect(selectModel(PROVIDER, MODEL_ID)?.displayName).toBe('First edit');
    expect(result.current.cfgDraft?.displayName).toBe('Continued typing');
    await act(async () => {
      await result.current.saveConfig();
    });
    expect(selectModel(PROVIDER, MODEL_ID)?.displayName).toBe(
      'Continued typing'
    );
  });
});

describe('拒绝有损和过期提交', () => {
  it.each(['-1.5', '1e3', '128k', '0'])(
    '非法窗口在真实保存入口被拒绝：%s',
    async (value) => {
      const { result } = renderHook(() => useSessionHarness());
      await act(async () => {
        await result.current.openConfigFor(MODEL_ID);
      });
      act(() =>
        result.current.setCfgDraft({
          ...result.current.cfgDraft!,
          contextWindow: value,
        })
      );
      await act(async () => {
        await result.current.saveConfig();
      });
      expect(writeMock).not.toHaveBeenCalled();
      expect(result.current.cfgDraft?.contextWindow).toBe(value);
      expect(notify).toHaveBeenCalledWith(false, expect.any(String));
      expect(hooks.commit).not.toHaveBeenCalled();
    }
  );
  it('未知思考键失败，不删除wire伪装成保存成功', async () => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        thinkingMap: { Custom: 'user wire' },
      })
    );
    await act(async () => {
      await result.current.saveConfig();
    });
    expect(writeMock).not.toHaveBeenCalled();
    expect(result.current.cfgDraft?.thinkingMap).toEqual({
      Custom: 'user wire',
    });
    expect(notify).toHaveBeenCalledWith(
      false,
      expect.stringContaining('不受支持')
    );
  });
  it.each([
    {
      pricing: {
        ...MODEL.pricing!,
        tiers: [{ inputTokensAbove: 100, input: 99 }],
      },
    },
    { pricing: { ...MODEL.pricing!, perImage: 9 } },
    { headers: { 'X-Model-Only': 'external' } },
    { compat: { ...MODEL.compat!, strictJsonSchema: true } },
  ])('外部只改完整语义字段，旧草稿也必须拒绝：%j', async (patch) => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        displayName: 'Stale name',
      })
    );
    await act(async () => {
      await modelsCatalogStore.updateModel(PROVIDER, MODEL_ID, patch);
    });
    writeMock.mockClear();
    await act(async () => {
      await result.current.saveConfig();
    });
    expect(writeMock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      false,
      '配置已被外部修改，保存已取消，请重新确认'
    );
    expect(result.current.cfgDraft?.displayName).toBe('Stale name');
    expect(selectModel(PROVIDER, MODEL_ID)?.displayName).toBe('Original');
    expect(hooks.commit).not.toHaveBeenCalled();
  });
  it('写盘失败保留草稿和上次已提交镜像', async () => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    act(() =>
      result.current.setCfgDraft({
        ...result.current.cfgDraft!,
        displayName: 'Retain draft',
      })
    );
    mockTauriError('workbench_apply_models_config', 'Permission denied');
    await act(async () => {
      await result.current.saveConfig();
    });
    expect(result.current.cfgDraft?.displayName).toBe('Retain draft');
    expect(selectModel(PROVIDER, MODEL_ID)?.displayName).toBe('Original');
    expect(notify).toHaveBeenCalledWith(
      false,
      expect.stringContaining('Permission denied')
    );
    expect(hooks.commit).not.toHaveBeenCalled();
  });
  it('编辑目标被删除时不重新创建供应商或空模型', async () => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor(MODEL_ID);
    });
    await act(async () => {
      await modelsCatalogStore.removeModel(PROVIDER, MODEL_ID);
    });
    writeMock.mockClear();
    await act(async () => {
      await result.current.saveConfig();
    });
    expect(writeMock).not.toHaveBeenCalled();
    expect(documentTree.providers[PROVIDER]!.models).toEqual([]);
    expect(result.current.cfgDraft).not.toBeNull();
    expect(notify).toHaveBeenCalledWith(
      false,
      expect.stringContaining('不存在')
    );
  });
  it('不存在的模型不能用只有id的伪草稿打开', async () => {
    const { result } = renderHook(() => useSessionHarness());
    await act(async () => {
      await result.current.openConfigFor('Missing');
    });
    expect(result.current.cfgDraft).toBeNull();
    expect(notify).toHaveBeenCalledWith(
      false,
      expect.stringContaining('不存在')
    );
    expect(writeMock).not.toHaveBeenCalled();
  });
});
