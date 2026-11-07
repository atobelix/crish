// 默认模型页 VM 测试（L3）：真源是 config.activeModel；本机可选集
// 以管理器真值（列表 VM 行）为准；失效给说明不顶替；选择只经显式
// select 写 store。列表 VM 以模块 mock 注入行（工厂自包含，行集经
// mock 前缀变量按用例切换）。
import { act, renderHook } from '@testing-library/react-native';
import { localChatStore } from '@/domain/store/localChatStore';
import type {
  LocalModelsConfig,
  LocalProviderSpec,
} from '@/domain/types/localChat';
import type { OnDeviceModelRow } from './useOnDeviceModelsVm';
import { useDefaultModelVm } from './useDefaultModelVm';

let mockRows: OnDeviceModelRow[] = [];
const mockRefresh = jest.fn(async () => {});

jest.mock('./useOnDeviceModelsVm', () => ({
  useOnDeviceModelsVm: () => ({
    rows: mockRows,
    totalUsageText: '0 B',
    readyCount: 0,
    syncErrorText: null,
    loadErrorText: null,
    freeDiskSpaceBytes: null,
    incompleteCount: 0,
    loadedModelId: null,
    download: jest.fn(),
    cancelDownload: jest.fn(async () => {}),
    removeModel: jest.fn(async () => {}),
    removeIncomplete: jest.fn(async () => {}),
    refresh: mockRefresh,
  }),
}));

const M15 = 'qwen2.5-1.5b-instruct-q4_k_m';
const M3B = 'qwen2.5-3b-instruct-q4_k_m';

function cloudProvider(
  models: LocalProviderSpec['models'],
  extra: Partial<LocalProviderSpec> = {}
): LocalProviderSpec {
  return {
    displayName: '云厂商',
    protocol: 'openai/chat',
    models,
    ...extra,
  };
}

function setConfig(config: LocalModelsConfig) {
  localChatStore.setState({ config, hydrated: true, keyPresence: {} });
}

function row(
  id: string,
  kind: 'ready' | 'missing' | 'partial'
): OnDeviceModelRow {
  return {
    id,
    name: id === M15 ? 'Qwen2.5-1.5B' : 'Qwen2.5-3B',
    sizeText: '1.0 GB',
    licenseLabel: 'Apache-2.0 开源许可',
    recommended: id === M15,
    state:
      kind === 'ready'
        ? { kind: 'ready', modelId: id, path: '/m', sizeBytes: 100 }
        : kind === 'partial'
          ? { kind: 'partial', modelId: id, receivedBytes: 10 }
          : { kind: 'missing', modelId: id },
    statusText: '',
    canRetry: false,
    busy: false,
    usageBytes: kind === 'missing' ? 0 : 10,
  };
}

beforeEach(() => {
  mockRows = [];
  mockRefresh.mockClear();
  setConfig({ version: 2, providers: {}, activeModel: null });
});

describe('useDefaultModelVm（L3 默认模型页）', () => {
  it('什么都没配：未设置、无失效说明、无可选；本机全列不可用（未下载）', async () => {
    mockRows = [row(M15, 'missing'), row(M3B, 'missing')];
    const { result } = await renderHook(() => useDefaultModelVm());
    expect(result.current.currentText).toBe('未设置');
    expect(result.current.invalidReasonText).toBeNull();
    expect(result.current.hasAnySelectable).toBe(false);
    const onDevice = result.current.groups.find(
      (g) => g.providerId === 'ondevice'
    );
    expect(onDevice?.unavailable.map((r) => r.reasonText)).toEqual([
      '未下载',
      '未下载',
    ]);
    expect(onDevice?.unavailable[0]?.onDeviceDetailId).toBe(M15);
  });

  it('云默认有效：当前文案是「供应商 · 模型」，对应行标当前', async () => {
    setConfig({
      version: 2,
      providers: {
        'cloud-a': cloudProvider([
          { id: 'm1', displayName: '模型一' },
          { id: 'm2', displayName: '模型二' },
        ]),
      },
      activeModel: { providerId: 'cloud-a', modelId: 'm2' },
    });
    const { result } = await renderHook(() => useDefaultModelVm());
    expect(result.current.currentText).toBe('云厂商 · 模型二');
    expect(result.current.invalidReasonText).toBeNull();
    const group = result.current.groups.find(
      (g) => g.providerId === 'cloud-a'
    );
    expect(group?.selectable.map((r) => [r.modelId, r.isCurrent])).toEqual([
      ['m1', false],
      ['m2', true],
    ]);
  });

  it('默认失效（模型已删）：给失效说明，明示未自动改投；显式选择后恢复', async () => {
    setConfig({
      version: 2,
      providers: {
        'cloud-a': cloudProvider([{ id: 'm1', displayName: '模型一' }]),
      },
      activeModel: { providerId: 'cloud-a', modelId: 'gone' },
    });
    const { result } = await renderHook(() => useDefaultModelVm());
    expect(result.current.currentText).toBe('未设置');
    expect(result.current.invalidReasonText).toContain('没有自动改用其他模型');
    await act(async () => {
      result.current.select('cloud-a', 'm1');
    });
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'cloud-a',
      modelId: 'm1',
    });
    expect(result.current.currentText).toBe('云厂商 · 模型一');
    expect(result.current.invalidReasonText).toBeNull();
  });

  it('本机：就绪可选、未完成不可用带状态词与详情 id；选本机写 ondevice', async () => {
    mockRows = [row(M15, 'ready'), row(M3B, 'partial')];
    const { result } = await renderHook(() => useDefaultModelVm());
    const onDevice = result.current.groups.find(
      (g) => g.providerId === 'ondevice'
    );
    expect(onDevice?.selectable.map((r) => r.modelId)).toEqual([M15]);
    expect(onDevice?.unavailable).toEqual([
      expect.objectContaining({
        modelId: M3B,
        reasonText: '未完成',
        onDeviceDetailId: M3B,
      }),
    ]);
    await act(async () => {
      result.current.select('ondevice', M15);
    });
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'ondevice',
      modelId: M15,
    });
  });

  it('停用模型与停用供应商：列不可用并给原因，不在可选集', async () => {
    setConfig({
      version: 2,
      providers: {
        'cloud-a': cloudProvider([
          { id: 'm1', displayName: '模型一' },
          { id: 'm2', displayName: '模型二', enabled: false },
        ]),
        'cloud-b': cloudProvider([{ id: 'x1', displayName: '模型X' }], {
          displayName: '停用厂商',
          enabled: false,
        }),
      },
      activeModel: null,
    });
    const { result } = await renderHook(() => useDefaultModelVm());
    const a = result.current.groups.find((g) => g.providerId === 'cloud-a');
    expect(a?.selectable.map((r) => r.modelId)).toEqual(['m1']);
    expect(a?.unavailable).toEqual([
      expect.objectContaining({ modelId: 'm2', reasonText: '已停用' }),
    ]);
    const b = result.current.groups.find((g) => g.providerId === 'cloud-b');
    expect(b?.selectable).toEqual([]);
    expect(b?.unavailable).toEqual([
      expect.objectContaining({ modelId: 'x1', reasonText: '供应商已停用' }),
    ]);
  });
});
