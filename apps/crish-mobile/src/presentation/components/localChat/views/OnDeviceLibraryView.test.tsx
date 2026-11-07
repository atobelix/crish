// 本机模型 · 模型库视图测试（L2 / IA §3.5 + §2.8）：只列未校验
// 条目；行上是完整文件大小/量化/推荐，许可绝不进行；名称筛选可用。
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import type {
  OnDeviceModelRow,
  OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import OnDeviceLibraryView from './OnDeviceLibraryView';

jest.mock('@/adapters/viewmodels/useOnDeviceModelsVm', () => ({
  useOnDeviceModelsVm: () => ({
    rows: [],
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
    refresh: jest.fn(async () => {}),
  }),
}));

afterEach(() => {
  cleanup();
});

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

async function renderView(element: ReactElement) {
  return render(element, { wrapper: Providers });
}

function makeRow(overrides: Partial<OnDeviceModelRow> = {}): OnDeviceModelRow {
  return {
    id: 'test-model-q4_k_m',
    name: 'Test Model（Q4_K_M）',
    sizeText: '1.0 GB',
    licenseLabel: 'Apache-2.0 开源许可',
    recommended: false,
    state: { kind: 'missing', modelId: 'test-model-q4_k_m' },
    statusText: '未下载',
    canRetry: false,
    busy: false,
    usageBytes: 0,
    ...overrides,
  };
}

function makeVm(overrides: Partial<OnDeviceModelsVm> = {}): OnDeviceModelsVm {
  return {
    rows: [],
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
    refresh: jest.fn(async () => {}),
    ...overrides,
  };
}

describe('OnDeviceLibraryView（模型库）', () => {
  it('未下载行：完整文件大小 + 量化 + 推荐标记；无许可、无研究许可警示', async () => {
    const row = makeRow({
      recommended: true,
      licenseWarning: 'Qwen Research License 警示不应出现在库行',
    });
    const view = await renderView(
      <OnDeviceLibraryView vm={makeVm({ rows: [row] })} onBack={jest.fn()} />
    );
    expect(
      view.getByText(/完整文件 1\.0 GB · Q4_K_M · 推荐/)
    ).toBeTruthy();
    expect(view.queryByText(/Apache/)).toBeNull();
    expect(view.queryByText(/Research License/)).toBeNull();
  });

  it('已校验条目不入列', async () => {
    const ready = makeRow({
      state: {
        kind: 'ready',
        modelId: 'test-model-q4_k_m',
        path: '/x',
        sizeBytes: 10,
      },
      statusText: '已就绪',
    });
    const view = await renderView(
      <OnDeviceLibraryView vm={makeVm({ rows: [ready] })} onBack={jest.fn()} />
    );
    expect(view.getByText('没有符合条件的模型')).toBeTruthy();
    expect(view.queryByText('Test Model（Q4_K_M）')).toBeNull();
  });

  it('按名称筛选：输入后只留匹配行；点行进详情', async () => {
    const a = makeRow({ id: 'alpha-q4_k_m', name: 'Alpha 模型' });
    const b = makeRow({ id: 'beta-q4_k_m', name: 'Beta 模型' });
    const onOpenDetail = jest.fn();
    const view = await renderView(
      <OnDeviceLibraryView
        vm={makeVm({ rows: [a, b] })}
        onBack={jest.fn()}
        onOpenDetail={onOpenDetail}
      />
    );
    fireEvent.changeText(view.getByTestId('ondevice-library-search'), 'alph');
    await waitFor(() => {
      expect(view.queryByText('Beta 模型')).toBeNull();
    });
    fireEvent.press(view.getByTestId('ondevice-library-alpha-q4_k_m'));
    expect(onOpenDetail).toHaveBeenCalledWith('alpha-q4_k_m');
  });
});
