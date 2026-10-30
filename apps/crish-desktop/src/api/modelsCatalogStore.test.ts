// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockTauriCommand,
  mockTauriError,
  mockTauriMissing,
} from '../test-setup';
import { onUiEvent } from './uiEvents';
import {
  modelsCatalogStore,
  addProvider,
  updateProvider,
  removeProvider,
  addModel,
  updateModel,
  removeModel,
  selectProvider,
  selectModel,
  selectEffectiveProtocol,
  selectEffectiveContextWindow,
  selectSupportsThinking,
  selectThinkingLevelsMap,
  getActiveModelRef,
  listCatalogModels,
  searchCatalogModels,
  findCatalogModel,
} from './modelsCatalogStore';
import { normalizeModelsTree, setActiveModel } from './modelsCatalogActions';
import { modelRefKey } from './modelsCatalogTypes';
import type {
  ModelSpec,
  ModelsCatalogSnapshot,
  ModelsYamlTree,
  ProviderSpec,
} from './modelsCatalogTypes';
import { catalogSnapshot } from '../test-utils/modelsCatalogSnapshot';

const READ = 'workbench_read_models_yaml';
const APPLY = 'workbench_apply_models_config';
const MODEL: ModelSpec = {
  id: 'Shared',
  enabled: true,
  contextWindow: 1000000,
  supportsTools: false,
  thinking: { Low: 'low', XHigh: 'exact wire' },
  headers: { 'X-Model': 'kept' },
  pricing: {
    currency: 'USD',
    perImage: 0.1,
    tiers: [{ inputTokensAbove: 100, cacheRead: 0 }],
  },
};
const PROVIDER: ProviderSpec = {
  protocol: 'openai/chat',
  enabled: true,
  stream: false,
  displayName: 'Acme',
  baseUrl: 'https://example.invalid',
  apiKeyRef: 'env:TEST_PROVIDER_KEY',
  models: [MODEL],
};
function tree(): ModelsYamlTree {
  return {
    version: 2,
    activeModel: null,
    providers: { Acme: structuredClone(PROVIDER) },
  };
}
let hostTree: ModelsYamlTree;
let hostRevision: string;
let counter: number;
let readMock: ReturnType<typeof vi.fn>;
let writeMock: ReturnType<typeof vi.fn>;
// 回执夹具统一走 test-utils 的唯一工厂（默认值单一真源，D3 契约防线要求）；
// 本包装只补本文件特有的 tree/revision 默认值与「空树带 parseError」语义。
const snapshot = (
  value: ModelsYamlTree | null = hostTree,
  revision = hostRevision
) =>
  catalogSnapshot({
    tree: value,
    revision,
    ...(value ? {} : { parseError: { message: 'invalid yaml' } }),
  });
function acceptWrite(payload: unknown): ModelsCatalogSnapshot {
  const args = payload as { tree: ModelsYamlTree; expectedRevision: string };
  if (args.expectedRevision !== hostRevision)
    throw { code: 'REVISION_CONFLICT', message: 'revision changed' };
  hostTree = structuredClone(args.tree);
  hostRevision = 'revision-' + ++counter;
  return snapshot();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  modelsCatalogStore.resetForTesting();
  hostTree = tree();
  hostRevision = 'revision-0';
  counter = 0;
  readMock = vi.fn(() => snapshot());
  writeMock = vi.fn(acceptWrite);
  mockTauriCommand(READ, readMock);
  mockTauriCommand(APPLY, writeMock);
});

describe('真实IPC桥上的目录镜像', () => {
  it('只从完整快照安装目录、修订及凭据状态，加载单飞', async () => {
    const changed = vi.fn();
    const off = onUiEvent('models-catalog-changed', changed);
    await Promise.all([
      modelsCatalogStore.ensureLoaded(),
      modelsCatalogStore.ensureLoaded(),
    ]);
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(modelsCatalogStore.getState()).toMatchObject({
      loaded: true,
      revision: 'revision-0',
      credentialStates: { Acme: { hasKey: true } },
      warning: null,
    });
    expect(selectModel(' Acme ', ' Shared ')?.pricing).toEqual(MODEL.pricing);
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });
  it('命令缺失时拒绝配置写入', async () => {
    mockTauriMissing(READ);
    expect(await modelsCatalogStore.ensureLoaded()).toBe(false);
    expect((await modelsCatalogStore.addModel('Acme', { id: 'New' })).ok).toBe(
      false
    );
    expect(writeMock).not.toHaveBeenCalled();
  });
  it('解析错误或读取异常保留上次完整树，但禁止以旧树继续写', async () => {
    await modelsCatalogStore.ensureLoaded();
    const previous = modelsCatalogStore.getState().tree;
    readMock.mockReturnValueOnce(snapshot(null));
    expect(await modelsCatalogStore.ensureLoaded(true)).toBe(false);
    expect(modelsCatalogStore.getState().tree).toBe(previous);
    expect(modelsCatalogStore.getState().lastError?.message).toContain(
      'invalid yaml'
    );
    expect(
      (
        await modelsCatalogStore.updateModel('Acme', 'Shared', {
          displayName: 'forbidden',
        })
      ).ok
    ).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
    mockTauriError(READ, 'read denied');
    expect(await modelsCatalogStore.ensureLoaded(true)).toBe(false);
    expect(modelsCatalogStore.getState().tree).toBe(previous);
  });
  it('有损旧包络不能假装读取成功，合法空树可以加载', async () => {
    readMock.mockReturnValueOnce({ path: 'old', providers: {} });
    expect(await modelsCatalogStore.ensureLoaded()).toBe(false);
    hostTree = { version: 2, activeModel: null, providers: {} };
    expect(await modelsCatalogStore.ensureLoaded()).toBe(true);
    expect(listCatalogModels()).toEqual([]);
  });
  it('确认镜像不可被消费方直接改写', async () => {
    await modelsCatalogStore.ensureLoaded();
    expect(() => {
      selectModel('Acme', 'Shared')!.contextWindow = 1;
    }).toThrow();
    expect(selectModel('Acme', 'Shared')?.contextWindow).toBe(1000000);
  });
});

describe('全部索引和读口使用相同身份', () => {
  it('大小写不同身份、同名模型、含分隔符身份均互不覆盖', async () => {
    hostTree.providers.acme = {
      ...PROVIDER,
      models: [{ id: 'Shared', enabled: true }],
    };
    hostTree.providers.Acme!.models.push({ id: 'SHARED', enabled: true });
    hostTree.providers['a::b'] = {
      ...PROVIDER,
      models: [{ id: 'c', enabled: true }],
    };
    hostTree.providers.a = {
      ...PROVIDER,
      models: [{ id: 'b::c', enabled: true }],
    };
    await modelsCatalogStore.ensureLoaded();
    expect(modelsCatalogStore.getState().modelIndex.size).toBe(5);
    expect(selectProvider(' Acme ')?.displayName).toBe('Acme');
    expect(selectProvider('ACME')).toBeUndefined();
    expect(selectModel('acme', 'Shared')?.contextWindow).toBeUndefined();
    expect(findCatalogModel('Shared', 'Acme')?.model.contextWindow).toBe(
      1000000
    );
    expect(
      modelsCatalogStore
        .getState()
        .modelIndex.has(modelRefKey({ providerId: 'a::b', modelId: 'c' }))
    ).toBe(true);
    expect(searchCatalogModels('shared', 'acme')).toHaveLength(1);
    expect(modelsCatalogStore.getState()).not.toHaveProperty(
      'globalModelIndex'
    );
    await modelsCatalogStore.updateModel('acme', 'Shared', {
      contextWindow: 1,
    });
    expect(selectModel('Acme', 'Shared')?.contextWindow).toBe(1000000);
    await modelsCatalogStore.removeModel('Acme', 'SHARED');
    expect(selectModel('Acme', 'Shared')).toBeDefined();
  });
  it('规范化后重复身份明确拒绝', () => {
    expect(() =>
      normalizeModelsTree({
        ...tree(),
        providers: { Acme: PROVIDER, ' Acme ': PROVIDER },
      })
    ).toThrow('重复');
    expect(() =>
      normalizeModelsTree({
        ...tree(),
        providers: {
          Acme: { ...PROVIDER, models: [MODEL, { ...MODEL, id: ' Shared ' }] },
        },
      })
    ).toThrow('重复');
  });
  it('协议继承和百万窗口直通；不存在则没有协议兜底', async () => {
    await modelsCatalogStore.ensureLoaded();
    expect(selectEffectiveProtocol('Acme', 'Shared')).toBe('openai/chat');
    expect(selectEffectiveContextWindow('Acme', 'Shared')).toBe(1000000);
    expect(selectEffectiveProtocol('missing', 'Shared')).toBeUndefined();
    expect(selectSupportsThinking('Acme', 'Shared')).toBe(true);
    expect(selectThinkingLevelsMap('Acme', 'Shared')).toEqual(MODEL.thinking);
  });
});

describe('纯操作和活动选择', () => {
  it('供应商增改删只有精确身份，重复创建不会覆盖', () => {
    const initial = tree();
    const added = addProvider(initial, ' acme ', PROVIDER);
    expect(added.providers.Acme).toEqual(initial.providers.Acme);
    expect(added.providers.acme).toBeDefined();
    expect(() => addProvider(added, 'Acme', PROVIDER)).toThrow('已存在');
    expect(
      updateProvider(added, 'acme', { stream: false, enabled: false }).providers
        .acme?.stream
    ).toBe(false);
    expect(removeProvider(added, 'acme').providers.Acme).toBeDefined();
    expect(initial.providers.acme).toBeUndefined();
  });
  it('新增模型只采用用户提交字段，重复新增不会覆盖微调', () => {
    const next = addModel(tree(), 'Acme', { id: 'gpt-5.6' });
    expect(next.providers.Acme!.models[1]).toEqual({
      id: 'gpt-5.6',
      enabled: true,
    });
    expect(() =>
      addModel(next, 'Acme', { id: 'Shared', displayName: 'overwrite' })
    ).toThrow('已存在');
    expect(
      updateModel(next, 'Acme', 'Shared', { displayName: 'name only' })
        .providers.Acme!.models[0]?.pricing
    ).toEqual(MODEL.pricing);
    expect(
      removeModel(next, 'Acme', 'Shared').providers.Acme!.models[0]?.id
    ).toBe('gpt-5.6');
  });
  it('停用或删除当前项在同一棵树中清空选择，不自动替换', async () => {
    await modelsCatalogStore.ensureLoaded();
    await modelsCatalogStore.addModel('Acme', { id: 'Another' });
    await modelsCatalogStore.setActiveModel({
      providerId: 'Acme',
      modelId: 'Shared',
    });
    expect(getActiveModelRef()).toEqual({
      providerId: 'Acme',
      modelId: 'Shared',
    });
    await modelsCatalogStore.updateModel('Acme', 'Shared', { enabled: false });
    expect(hostTree.activeModel).toBeNull();
    expect(getActiveModelRef()).toBeNull();
    expect(() =>
      setActiveModel(hostTree, { providerId: 'Acme', modelId: 'Shared' })
    ).toThrow('停用');
    await modelsCatalogStore.setActiveModel({
      providerId: 'Acme',
      modelId: 'Another',
    });
    await modelsCatalogStore.removeProvider('Acme');
    expect(hostTree.activeModel).toBeNull();
  });
  it.each([
    { contextWindow: 0 },
    { maxOutputTokens: 0 },
    { contextWindow: -1 },
    { pricing: { currency: 'USD', input: -1 } },
    { thinking: { Custom: 'wire' } },
    { capabilities: { tools: true } },
    { contextLength: 123 },
  ])('非法或旧字段禁止进入规范树：%j', (change) => {
    const invalid = { ...MODEL, ...change } as unknown as ModelSpec;
    expect(() =>
      normalizeModelsTree({
        ...tree(),
        providers: { Acme: { ...PROVIDER, models: [invalid] } },
      })
    ).toThrow();
  });
});

describe('确认后发布与顺序事务', () => {
  it('延迟返回的保存回执不能覆盖已经接收的新快照', async () => {
    await modelsCatalogStore.ensureLoaded();
    const receipt = deferred<ModelsCatalogSnapshot>();
    writeMock.mockImplementationOnce(() => receipt.promise);
    const pending = modelsCatalogStore.updateModel('Acme', 'Shared', {
      displayName: 'delayed',
    });
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    const external = updateModel(hostTree, 'Acme', 'Shared', {
      displayName: 'newer snapshot',
    });
    modelsCatalogStore.acceptSnapshot(snapshot(external, 'external-revision'));
    receipt.resolve(
      snapshot(
        updateModel(hostTree, 'Acme', 'Shared', { displayName: 'delayed' }),
        'delayed-revision'
      )
    );
    expect((await pending).ok).toBe(false);
    expect(modelsCatalogStore.getState().revision).toBe('external-revision');
    expect(selectModel('Acme', 'Shared')?.displayName).toBe('newer snapshot');
  });
  it('在途保存不改镜像，成功后采用宿主回执而非候选副本', async () => {
    await modelsCatalogStore.ensureLoaded();
    const receipt = deferred<ModelsCatalogSnapshot>();
    writeMock.mockImplementationOnce(() => receipt.promise);
    const pending = modelsCatalogStore.updateModel('Acme', 'Shared', {
      displayName: 'candidate',
    });
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    expect(selectModel('Acme', 'Shared')?.displayName).toBeUndefined();
    const accepted = updateModel(hostTree, 'Acme', 'Shared', {
      displayName: 'host accepted',
    });
    receipt.resolve(snapshot(accepted, 'host-revision'));
    expect(await pending).toEqual({ ok: true });
    expect(selectModel('Acme', 'Shared')?.displayName).toBe('host accepted');
    expect(modelsCatalogStore.getState().revision).toBe('host-revision');
  });
  it('排队的函数动作基于最新确认树，两个独立修改不会互相丢失', async () => {
    await modelsCatalogStore.ensureLoaded();
    const receipt = deferred<ModelsCatalogSnapshot>();
    let firstPayload: unknown;
    writeMock.mockImplementationOnce((payload: unknown) => {
      firstPayload = payload;
      return receipt.promise;
    });
    const first = modelsCatalogStore.updateModel('Acme', 'Shared', {
      displayName: 'first',
    });
    const second = modelsCatalogStore.updateModel('Acme', 'Shared', {
      contextWindow: 2048,
    });
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    receipt.resolve(acceptWrite(firstPayload));
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(writeMock.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 'revision-1',
    });
    expect(hostTree.providers.Acme!.models[0]).toMatchObject({
      displayName: 'first',
      contextWindow: 2048,
    });
  });
  it('先前写失败不会成为后续修改的基础', async () => {
    await modelsCatalogStore.ensureLoaded();
    writeMock.mockImplementationOnce(() => {
      throw new Error('write denied');
    });
    const first = modelsCatalogStore.updateModel('Acme', 'Shared', {
      displayName: 'failed candidate',
    });
    const second = modelsCatalogStore.updateModel('Acme', 'Shared', {
      contextWindow: 2048,
    });
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
    expect(hostTree.providers.Acme!.models[0]).not.toHaveProperty(
      'displayName'
    );
    expect(hostTree.providers.Acme!.models[0]?.contextWindow).toBe(2048);
  });
  it('整树草稿与显式修订不覆盖排队期间已提交的新版本', async () => {
    await modelsCatalogStore.ensureLoaded();
    const stale = structuredClone(hostTree);
    const first = modelsCatalogStore.updateModel('Acme', 'Shared', {
      displayName: 'new revision',
    });
    const second = modelsCatalogStore.updateTree(stale, 'revision-0');
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(false);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(hostTree.providers.Acme!.models[0]?.displayName).toBe(
      'new revision'
    );
  });
});

describe('外部冲突、通知与增量追加', () => {
  it('外部冲突保留原镜像和诊断，并要求重新读取', async () => {
    await modelsCatalogStore.ensureLoaded();
    const previous = modelsCatalogStore.getState().tree;
    mockTauriError(APPLY, {
      code: 'REVISION_CONFLICT',
      message: 'external change',
      currentRevision: 'elsewhere',
    });
    expect(
      (
        await modelsCatalogStore.updateModel('Acme', 'Shared', {
          displayName: 'stale',
        })
      ).ok
    ).toBe(false);
    expect(modelsCatalogStore.getState().tree).toEqual(previous);
    expect(modelsCatalogStore.getState().lastError?.kind).toBe(
      'REVISION_CONFLICT'
    );
    expect(modelsCatalogStore.getState().loaded).toBe(true);
  });
  it('广播失败仍保留已提交成功，单独展示同步告警', async () => {
    await modelsCatalogStore.ensureLoaded();
    writeMock.mockImplementationOnce((payload: unknown) => ({
      ...acceptWrite(payload),
      notificationError: 'window sync failed',
    }));
    expect(
      await modelsCatalogStore.updateModel('Acme', 'Shared', {
        displayName: 'saved',
      })
    ).toEqual({ ok: true });
    expect(modelsCatalogStore.getState()).toMatchObject({
      loaded: true,
      lastError: null,
      warning: 'window sync failed',
    });
    expect(selectModel('Acme', 'Shared')?.displayName).toBe('saved');
  });
  it('扫描仅追加精确差集，不从预填资料覆盖已保存模型', async () => {
    await modelsCatalogStore.ensureLoaded();
    const result = await modelsCatalogStore.probeAndAppendModels(' Acme ', [
      'Shared',
      ' shared ',
      'gpt-5.6',
      'gpt-5.6',
    ]);
    expect(result).toMatchObject({
      providerId: 'Acme',
      totalProbed: 3,
      existingRetained: 1,
      appendedModelIds: ['shared', 'gpt-5.6'],
    });
    expect(hostTree.providers.Acme!.models[0]).toEqual(MODEL);
    expect(hostTree.providers.Acme!.models[2]).toEqual({
      id: 'gpt-5.6',
      enabled: true,
    });
  });
});
