// 本机模型 · 下载任务视图测试（L2 / IA §3.5）：只列未完成/失败/
// 进行中；进度与速度来自实测字段；下载中可取消；空态诚实。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import type {
  OnDeviceModelRow,
  OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import OnDeviceDownloadsView from './OnDeviceDownloadsView';

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

describe('OnDeviceDownloadsView（下载任务）', () => {
  it('空态：没有未完成的下载；已校验/未下载不入列', async () => {
    const ready = makeRow({
      state: {
        kind: 'ready',
        modelId: 'test-model-q4_k_m',
        path: '/x',
        sizeBytes: 1,
      },
    });
    const view = await renderView(
      <OnDeviceDownloadsView
        vm={makeVm({ rows: [ready, makeRow({ id: 'other-q4_k_m' })] })}
        onBack={jest.fn()}
      />
    );
    expect(view.getByText('没有未完成的下载')).toBeTruthy();
  });

  it('下载中：进度文案 + 实测速度 + 取消按钮回调', async () => {
    const row = makeRow({
      state: {
        kind: 'downloading',
        modelId: 'test-model-q4_k_m',
        fileName: 'f.gguf',
        fileIndex: 1,
        totalFiles: 1,
        receivedBytes: 50,
        totalBytes: 100,
        overallFraction: 0.5,
        progressText: '50 B / 100 B (50%)',
        speedBytesPerSec: 2048,
      },
      statusText: '下载中 50%',
      progressText: '50 B / 100 B (50%)',
      progressFraction: 0.5,
      speedBytesPerSec: 2048,
      usageBytes: 50,
    });
    const vm = makeVm({ rows: [row] });
    const view = await renderView(
      <OnDeviceDownloadsView vm={vm} onBack={jest.fn()} />
    );
    expect(view.getByText(/50 B \/ 100 B \(50%\)/)).toBeTruthy();
    // formatBytes 口径：KB 档取整（2048 → 「2 KB」）
    expect(view.getByText(/2 KB\/s/)).toBeTruthy();
    fireEvent.press(
      view.getByTestId('ondevice-downloads-cancel-test-model-q4_k_m')
    );
    expect(vm.cancelDownload).toHaveBeenCalledWith('test-model-q4_k_m');
  });

  it('失败行显示失败原因（不变成未下载）', async () => {
    const row = makeRow({
      state: {
        kind: 'error',
        modelId: 'test-model-q4_k_m',
        message: '网络中断',
        canRetry: true,
      },
      statusText: '下载失败',
      errorText: '网络中断',
      canRetry: true,
      usageBytes: 12,
    });
    const view = await renderView(
      <OnDeviceDownloadsView vm={makeVm({ rows: [row] })} onBack={jest.fn()} />
    );
    expect(view.getByText('网络中断')).toBeTruthy();
    expect(view.getByText('失败')).toBeTruthy();
    expect(view.queryByText('未下载')).toBeNull();
  });
});
