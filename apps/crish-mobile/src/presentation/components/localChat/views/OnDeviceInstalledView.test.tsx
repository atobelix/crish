// 本机模型 · 已安装视图测试（L2 / IA §3.4 + §2.8 回归）：占用大于
// 0 的未完成行显示「未完成」且绝不出现「未下载」；纯未下载不入列；
// 行上不出现许可；状态词走 IA 表（已校验/待校验/当前已加载）。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import type {
  OnDeviceModelRow,
  OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import OnDeviceInstalledView from './OnDeviceInstalledView';

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

describe('OnDeviceInstalledView（已安装）', () => {
  it('未完成行（占用 > 0）：显示「未完成」与真实占用，全页无「未下载」、无许可', async () => {
    const row = makeRow({
      state: {
        kind: 'partial',
        modelId: 'test-model-q4_k_m',
        receivedBytes: 40 * 1024 * 1024,
      },
      statusText: '未完成',
      usageBytes: 40 * 1024 * 1024,
    });
    const view = await renderView(
      <OnDeviceInstalledView vm={makeVm({ rows: [row] })} onBack={jest.fn()} />
    );
    expect(view.getByText('未完成')).toBeTruthy();
    expect(view.getByText(/占用 40\.0 MB/)).toBeTruthy();
    expect(view.queryByText('未下载')).toBeNull();
    expect(view.queryByText(/Apache/)).toBeNull();
  });

  it('纯未下载不入列；空态引导去模型库', async () => {
    const onOpenLibrary = jest.fn();
    const view = await renderView(
      <OnDeviceInstalledView
        vm={makeVm({ rows: [makeRow()] })}
        onBack={jest.fn()}
        onOpenLibrary={onOpenLibrary}
      />
    );
    expect(view.getByText('还没有已安装的模型')).toBeTruthy();
    fireEvent.press(view.getByTestId('ondevice-installed-open-library'));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it('状态词：已校验 / 待校验 / 当前已加载；点行进详情', async () => {
    const ready = makeRow({
      id: 'a-q4_k_m',
      name: 'A',
      state: { kind: 'ready', modelId: 'a-q4_k_m', path: '/a', sizeBytes: 10 },
      statusText: '已就绪',
      usageBytes: 10,
    });
    const unverified = makeRow({
      id: 'b-q4_k_m',
      name: 'B',
      state: { kind: 'unverified', modelId: 'b-q4_k_m', sizeBytes: 10 },
      statusText: '待校验',
      usageBytes: 10,
    });
    const onOpenDetail = jest.fn();
    const view = await renderView(
      <OnDeviceInstalledView
        vm={makeVm({ rows: [ready, unverified], loadedModelId: 'a-q4_k_m' })}
        onBack={jest.fn()}
        onOpenDetail={onOpenDetail}
      />
    );
    expect(view.getByText('当前已加载')).toBeTruthy();
    expect(view.getByText('待校验')).toBeTruthy();
    fireEvent.press(view.getByTestId('ondevice-installed-b-q4_k_m'));
    expect(onOpenDetail).toHaveBeenCalledWith('b-q4_k_m');
  });
});
