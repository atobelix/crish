// 本机模型首页视图测试（L2 / IA §3.3）：概览四行实测、已加载名与
// 空态文案、主动作随状态切换、核对失败错误态、导航回调。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import type {
  OnDeviceModelRow,
  OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import OnDeviceModelsView from './OnDeviceModelsView';

// 默认 hook 惰性替身：视图测试始终注入 fake vm，默认 hook 只需可运行
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

describe('OnDeviceModelsView（本机模型首页）', () => {
  it('概览四行：已校验数、没有未完成、占用带口径标注、没有加载模型', async () => {
    const view = await renderView(
      <OnDeviceModelsView vm={makeVm()} onBack={jest.fn()} />
    );
    expect(view.getByText('已校验')).toBeTruthy();
    expect(view.getByText('0 个')).toBeTruthy();
    expect(view.getByText('没有未完成的下载')).toBeTruthy();
    expect(view.getByText('已计算的模型文件（含未完成文件）')).toBeTruthy();
    expect(view.getByText('当前没有加载模型')).toBeTruthy();
  });

  it('已加载时显示模型名；未完成数大于 0 显示数字与「查看下载」主动作', async () => {
    const row = makeRow({
      state: {
        kind: 'ready',
        modelId: 'test-model-q4_k_m',
        path: '/x',
        sizeBytes: 100,
      },
      statusText: '已就绪',
      usageBytes: 100,
    });
    const onOpenDownloads = jest.fn();
    const view = await renderView(
      <OnDeviceModelsView
        vm={makeVm({
          rows: [row],
          readyCount: 1,
          incompleteCount: 2,
          loadedModelId: row.id,
          totalUsageText: '100 B',
        })}
        onBack={jest.fn()}
        onOpenDownloads={onOpenDownloads}
      />
    );
    expect(view.getAllByText('Test Model（Q4_K_M）').length).toBeGreaterThan(0);
    expect(view.getByText('2 个')).toBeTruthy();
    fireEvent.press(view.getByTestId('ondevice-home-open-downloads'));
    expect(onOpenDownloads).toHaveBeenCalledTimes(1);
  });

  it('无已安装且无未完成：主动作是「浏览模型库」', async () => {
    const onOpenLibrary = jest.fn();
    const view = await renderView(
      <OnDeviceModelsView
        vm={makeVm()}
        onBack={jest.fn()}
        onOpenLibrary={onOpenLibrary}
      />
    );
    fireEvent.press(view.getByTestId('ondevice-home-open-library'));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it('核对失败：错误态 + 原因 + 重试（不显示假概览）', async () => {
    const vm = makeVm({ loadErrorText: 'disk gone' });
    const view = await renderView(
      <OnDeviceModelsView vm={vm} onBack={jest.fn()} />
    );
    expect(view.getByText('暂时无法读取模型目录')).toBeTruthy();
    expect(view.getByText('disk gone')).toBeTruthy();
    expect(view.queryByText('当前没有加载模型')).toBeNull();
    fireEvent.press(view.getByTestId('ondevice-home-retry'));
    expect(vm.refresh).toHaveBeenCalledTimes(1);
  });
});
