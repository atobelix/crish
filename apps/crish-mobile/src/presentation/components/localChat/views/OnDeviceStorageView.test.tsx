// 本机模型 · 存储视图测试（L2 / IA §3.9）：两行实测分开标注；
// 可用空间读不到写「未能读取」；清理只含 .part 行（下载中不入列）；
// 删除未完成文件走确认后调 removeIncomplete。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import type {
  OnDeviceModelRow,
  OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import OnDeviceStorageView from './OnDeviceStorageView';

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

describe('OnDeviceStorageView（存储）', () => {
  it('实测两行：模型文件带口径标注；可用空间读不到写「未能读取」', async () => {
    const view = await renderView(
      <OnDeviceStorageView
        vm={makeVm({ totalUsageText: '3.5 GB', freeDiskSpaceBytes: null })}
        onBack={jest.fn()}
      />
    );
    expect(view.getByText('含未完成文件，不含校验标记')).toBeTruthy();
    expect(view.getByText('3.5 GB')).toBeTruthy();
    expect(view.getByText('未能读取')).toBeTruthy();
  });

  it('可用空间有值时显示格式化数值', async () => {
    const view = await renderView(
      <OnDeviceStorageView
        vm={makeVm({ freeDiskSpaceBytes: 2048 })}
        onBack={jest.fn()}
      />
    );
    // formatBytes 口径：KB 档取整（2048 → 「2 KB」）
    expect(view.getByText('2 KB')).toBeTruthy();
  });

  it('清理列表只有 .part 行：确认后调 removeIncomplete；下载中不入列', async () => {
    const partial = makeRow({
      state: { kind: 'partial', modelId: 'test-model-q4_k_m', receivedBytes: 7 },
      statusText: '未完成',
      usageBytes: 7,
    });
    const downloading = makeRow({
      id: 'other-q4_k_m',
      name: 'Other',
      state: {
        kind: 'downloading',
        modelId: 'other-q4_k_m',
        fileName: 'f',
        fileIndex: 1,
        totalFiles: 1,
        receivedBytes: 1,
        totalBytes: 2,
        overallFraction: 0.5,
      },
      statusText: '下载中 50%',
      usageBytes: 1,
    });
    const vm = makeVm({ rows: [partial, downloading] });
    const view = await renderView(
      <OnDeviceStorageView vm={vm} onBack={jest.fn()} />
    );
    expect(
      view.getByTestId('ondevice-storage-clean-test-model-q4_k_m')
    ).toBeTruthy();
    expect(view.queryByTestId('ondevice-storage-clean-other-q4_k_m')).toBeNull();
    fireEvent.press(
      view.getByTestId('ondevice-storage-clean-test-model-q4_k_m')
    );
    // RN Modal 子树在 visible 翻转后延迟一拍挂载：首断言走异步查询
    expect(await view.findByText(/进度不能恢复/)).toBeTruthy();
    const deleteButtons = view.getAllByText('删除');
    fireEvent.press(deleteButtons[deleteButtons.length - 1]!);
    expect(vm.removeIncomplete).toHaveBeenCalledWith('test-model-q4_k_m');
  });
});
