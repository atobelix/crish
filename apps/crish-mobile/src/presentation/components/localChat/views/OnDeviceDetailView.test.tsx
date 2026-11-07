// 本机模型 · 详情视图测试（L2 / IA §3.6）：未知 id 诚实空态（无
// 下载按钮）；主动作随状态变；无凭据未完成是「重新下载」且先确认
// 覆盖，有凭据才是「继续下载」；许可/sha256/配置生效值在详情后部。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import type { OnDeviceModelSpec } from '@/adapters/onDevice/onDeviceModelCatalog';
import type { OnDeviceModelDetailVm } from '@/adapters/viewmodels/useOnDeviceModelDetailVm';
import OnDeviceDetailView from './OnDeviceDetailView';

jest.mock('@/adapters/viewmodels/useOnDeviceModelDetailVm', () => ({
  useOnDeviceModelDetailVm: () => ({
    found: false,
    spec: null,
    state: null,
    usageBytes: 0,
    usageText: '0 B',
    sizeText: '',
    quantLabel: null,
    resumeAvailable: false,
    loaded: false,
    loading: false,
    isDefault: false,
    busy: false,
    actionErrorText: null,
    contextSize: 4096,
    sourceRepo: null,
    refresh: jest.fn(async () => {}),
    download: jest.fn(),
    cancelDownload: jest.fn(async () => {}),
    removeModel: jest.fn(async () => {}),
    removeIncomplete: jest.fn(async () => {}),
    load: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
    setAsDefault: jest.fn(),
  }),
  onDeviceQuantLabel: () => null,
  onDeviceSourceRepo: () => null,
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

const SPEC: OnDeviceModelSpec = {
  id: 'test-model-q4_k_m',
  displayName: 'Test Model（Q4_K_M）',
  fileName: 'test-model-q4_k_m.gguf',
  size: 1000,
  sha256: 'a'.repeat(64),
  urls: ['https://hf-mirror.com/Qwen/Test-GGUF/resolve/main/test.gguf'],
  license: { id: 'Apache-2.0', label: 'Apache-2.0 开源许可' },
};

function makeVm(
  overrides: Partial<OnDeviceModelDetailVm> = {}
): OnDeviceModelDetailVm {
  return {
    found: true,
    spec: SPEC,
    state: { kind: 'missing', modelId: SPEC.id },
    usageBytes: 0,
    usageText: '0 B',
    sizeText: '1000 B',
    quantLabel: 'Q4_K_M',
    resumeAvailable: false,
    loaded: false,
    loading: false,
    isDefault: false,
    busy: false,
    actionErrorText: null,
    contextSize: 4096,
    sourceRepo: 'Qwen/Test-GGUF',
    refresh: jest.fn(async () => {}),
    download: jest.fn(),
    cancelDownload: jest.fn(async () => {}),
    removeModel: jest.fn(async () => {}),
    removeIncomplete: jest.fn(async () => {}),
    load: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
    setAsDefault: jest.fn(),
    ...overrides,
  };
}

describe('OnDeviceDetailView（详情）', () => {
  it('未知 id：诚实空态，没有下载按钮', async () => {
    const view = await renderView(
      <OnDeviceDetailView
        modelId="nope"
        vm={makeVm({ found: false, spec: null })}
        onBack={jest.fn()}
      />
    );
    expect(view.getByText('该模型不在目录中')).toBeTruthy();
    expect(view.queryByTestId('ondevice-detail-download')).toBeNull();
  });

  it('未下载：主动作「下载」；后部有许可、sha256 与配置生效值', async () => {
    const vm = makeVm();
    const view = await renderView(
      <OnDeviceDetailView modelId={SPEC.id} vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('ondevice-detail-download'));
    expect(vm.download).toHaveBeenCalledTimes(1);
    expect(view.getByText('Apache-2.0 开源许可')).toBeTruthy();
    expect(view.getByText('a'.repeat(64))).toBeTruthy();
    expect(view.getByText('Qwen/Test-GGUF')).toBeTruthy();
    expect(view.getByText('4096')).toBeTruthy();
    expect(view.getByText('由运行时决定')).toBeTruthy();
  });

  it('未完成无凭据：主动作是「重新下载」，先弹确认说明会覆盖半成品', async () => {
    const vm = makeVm({
      state: { kind: 'partial', modelId: SPEC.id, receivedBytes: 10 },
      usageBytes: 10,
      usageText: '10 B',
      resumeAvailable: false,
    });
    const view = await renderView(
      <OnDeviceDetailView modelId={SPEC.id} vm={vm} onBack={jest.fn()} />
    );
    expect(view.queryByTestId('ondevice-detail-resume')).toBeNull();
    fireEvent.press(view.getByTestId('ondevice-detail-redownload'));
    // RN Modal 子树在 visible 翻转后延迟一拍挂载：首断言走异步查询
    expect(
      await view.findByText(
        '没有可用的续传凭据，重新下载会覆盖未完成文件并从头开始。'
      )
    ).toBeTruthy();
    // 确认前 download 不得被调用；点对话框内的「重新下载」才真正重下
    expect(vm.download).not.toHaveBeenCalled();
    const redownloadButtons = view.getAllByText('重新下载');
    fireEvent.press(redownloadButtons[redownloadButtons.length - 1]!);
    expect(vm.download).toHaveBeenCalledTimes(1);
  });

  it('未完成有凭据：主动作是「继续下载」', async () => {
    const vm = makeVm({
      state: { kind: 'partial', modelId: SPEC.id, receivedBytes: 10 },
      usageBytes: 10,
      usageText: '10 B',
      resumeAvailable: true,
    });
    const view = await renderView(
      <OnDeviceDetailView modelId={SPEC.id} vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('ondevice-detail-resume'));
    expect(vm.download).toHaveBeenCalledTimes(1);
  });

  it('已加载：主动作是「释放」，状态词「当前已加载」', async () => {
    const vm = makeVm({
      state: { kind: 'ready', modelId: SPEC.id, path: '/x', sizeBytes: 1000 },
      usageBytes: 1000,
      usageText: '1000 B',
      loaded: true,
    });
    const view = await renderView(
      <OnDeviceDetailView modelId={SPEC.id} vm={vm} onBack={jest.fn()} />
    );
    expect(view.getByText('当前已加载')).toBeTruthy();
    fireEvent.press(view.getByTestId('ondevice-detail-release'));
    expect(vm.release).toHaveBeenCalledTimes(1);
  });

  // 注：「已校验未加载」条排在最末——它的「加载 + 对话框确认」组合在
  // 本仓 jest 环境会留悬空 act 作用域（RN Modal 延迟挂载与 RNTL act
  // 队列的交互，实测二分定位），其后用例的渲染会被吞；排末尾后悬空
  // 作用域随文件结束消亡。各条断言与顺序无关。
  it('已校验未加载：主动作「加载」+「设为默认」；删除确认按默认文案', async () => {
    const vm = makeVm({
      state: { kind: 'ready', modelId: SPEC.id, path: '/x', sizeBytes: 1000 },
      usageBytes: 1000,
      usageText: '1000 B',
      isDefault: true,
    });
    const view = await renderView(
      <OnDeviceDetailView modelId={SPEC.id} vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('ondevice-detail-load'));
    expect(vm.load).toHaveBeenCalledTimes(1);
    expect(view.getByText('当前默认')).toBeTruthy();
    fireEvent.press(view.getByTestId('ondevice-detail-remove'));
    // RN Modal 子树在 visible 翻转后延迟一拍挂载：首断言走异步查询
    expect(
      await view.findByText(/默认模型变为未设置，不会自动改用云端或其他模型/)
    ).toBeTruthy();
    // 点对话框内的「删除」才真正删除（页面行与对话框动作同名，取最后一个）
    const deleteButtons = view.getAllByText('删除');
    fireEvent.press(deleteButtons[deleteButtons.length - 1]!);
    expect(vm.removeModel).toHaveBeenCalledTimes(1);
    // 注：jest 环境里 RN Modal 关闭后子树滞留（原生 dismiss 握手不
    // 完成），不做「文本消失」断言——关闭的真源是 visible 状态与回调。
  });
});
