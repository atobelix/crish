// 供应商列表呈现契约（P1 连接诊断移出）：
// - 列表（含当前活跃 Hero 与本机模型卡）不出现任何毫秒/延迟胶囊；
// - 本机模型卡不出现连接诊断入口（本机模型没有网络端点）。
import { render, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { ON_DEVICE_PROVIDER_ID } from '@/adapters/onDevice/onDeviceProviderSync';
import type {
  LocalProviderRow,
  LocalProvidersVm,
} from '@/adapters/viewmodels/useLocalProvidersVm';
import { ToastProvider } from '@/presentation/ui';
import ProvidersListView from './ProvidersListView';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

function makeRow(overrides: Partial<LocalProviderRow> = {}): LocalProviderRow {
  return {
    id: 'p1',
    name: '示例供应商',
    baseUrl: 'https://api.example.com/v1',
    host: 'api.example.com',
    vendor: 'custom',
    vendorKey: 'custom',
    defaultModelId: 'm1',
    defaultModelName: '示例模型',
    modelCount: 2,
    hasKey: true,
    isActive: false,
    ...overrides,
  };
}

function makeVm(): LocalProvidersVm {
  return {
    rows: [makeRow()],
    onDeviceRow: makeRow({
      id: ON_DEVICE_PROVIDER_ID,
      name: '本机模型',
      baseUrl: '',
      host: '',
      defaultModelId: null,
      defaultModelName: null,
      modelCount: 1,
      hasKey: false,
    }),
    presets: [],
    activeProvider: makeRow({ isActive: true }),
    hydrated: true,
    activate: jest.fn(),
    remove: jest.fn(async () => {}),
  };
}

describe('ProvidersListView P1 契约', () => {
  it('列表与 Hero 无延迟胶囊；本机模型卡无诊断入口', async () => {
    const view = await render(
      <ProvidersListView
        vm={makeVm()}
        onBack={() => {}}
        onAddProvider={() => {}}
        onSelectPreset={() => {}}
        onSelectProvider={() => {}}
        onSelectOnDevice={() => {}}
      />,
      { wrapper: Providers }
    );

    // 三个面都在：本机卡、活跃 Hero、普通供应商行
    expect(view.getByTestId('ondevice-provider-card')).toBeTruthy();
    expect(view.getByTestId('active-provider-hero')).toBeTruthy();
    expect(view.getByTestId('provider-card-p1')).toBeTruthy();

    // 全树没有延迟胶囊，也没有任何「数字+ms」文案
    expect(view.queryAllByTestId(/latency/)).toHaveLength(0);
    expect(view.queryByText(/\d+\s?ms/)).toBeNull();

    // 本机模型卡内没有连接诊断入口；列表任何位置都不渲染诊断入口
    const onDeviceCard = within(view.getByTestId('ondevice-provider-card'));
    expect(onDeviceCard.queryByText('连接诊断')).toBeNull();
    expect(view.queryByTestId('btn-open-diagnostics')).toBeNull();
  });
});
