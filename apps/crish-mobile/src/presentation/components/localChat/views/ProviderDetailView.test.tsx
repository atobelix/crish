// 供应商详情呈现契约（P1 连接诊断移出）：
// - 模型行不再接收/展示延迟：渲染树里没有 model-latency 胶囊、没有毫秒文案；
// - 详情不再放「测速」按钮；改为一行「连接诊断」入口进入二级诊断页。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type {
  ProviderDetailVm,
  StoredModelRowItem,
} from '@/adapters/viewmodels/useProviderDetailVm';
import type { LocalProviderSpec } from '@/domain/types/localChat';
import { ToastProvider } from '@/presentation/ui';
import ProviderDetailView from './ProviderDetailView';

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

const modelRow: StoredModelRowItem = {
  id: 'm1',
  displayName: '示例模型',
  isDefault: true,
  contextWindow: 131072,
  contextText: '128k',
  thinkingTierText: '关闭',
  supportedModalities: new Set(['text']),
  raw: { id: 'm1', modalities: { input: ['text'], output: ['text'] } },
};

const provider: LocalProviderSpec = {
  displayName: '示例供应商',
  baseUrl: 'https://api.example.com/v1',
  protocol: 'openai/chat',
  latencyMs: 123,
  models: [{ id: 'm1' }],
};

function makeVm(
  overrides: Partial<ProviderDetailVm> = {}
): ProviderDetailVm {
  return {
    providerId: 'p1',
    provider,
    isNotFound: false,
    name: '示例供应商',
    baseUrl: 'https://api.example.com/v1',
    apiKey: '',
    newApiKey: '',
    hasStoredKey: true,
    vendor: 'custom',
    models: [modelRow],
    storedModels: [modelRow],
    pinging: false,
    pingResult: null,
    saved: false,
    setName: jest.fn(),
    setBaseUrl: jest.fn(),
    setApiKey: jest.fn(),
    setNewApiKey: jest.fn(),
    setVendor: jest.fn(),
    clearStoredKey: jest.fn(async () => {}),
    setDefaultModel: jest.fn(async () => {}),
    removeModel: jest.fn(async () => {}),
    runPing: jest.fn(async () => {}),
    testPing: jest.fn(async () => {}),
    save: jest.fn(async () => true),
    saveChanges: jest.fn(async () => true),
    remove: jest.fn(async () => {}),
    deleteProvider: jest.fn(async () => {}),
    ...overrides,
  };
}

describe('ProviderDetailView P1 契约', () => {
  it('模型行无延迟胶囊、无测速按钮；诊断入口直达回调', async () => {
    const onOpenDiagnostics = jest.fn();
    const vm = makeVm();
    const view = await render(
      <ProviderDetailView
        providerId="p1"
        vm={vm}
        onBack={() => {}}
        onNavigateWizard={() => {}}
        onSelectModel={() => {}}
        onOpenDiagnostics={onOpenDiagnostics}
        onDeleted={() => {}}
      />,
      { wrapper: Providers }
    );

    // 模型行在，但即使存储里有 latencyMs 也不展示
    expect(view.getByTestId('stored-model-item-m1')).toBeTruthy();
    expect(view.queryAllByTestId(/model-latency/)).toHaveLength(0);
    expect(view.queryByText(/\d+\s?ms/)).toBeNull();

    // 测速按钮已从详情移除
    expect(view.queryByTestId('btn-run-ping')).toBeNull();

    // 连接诊断入口在位，点按直达回调（收尾执行）
    const entry = view.getByTestId('btn-open-diagnostics');
    expect(entry).toBeTruthy();
    fireEvent.press(entry);
    expect(onOpenDiagnostics).toHaveBeenCalledTimes(1);
    expect(onOpenDiagnostics).toHaveBeenCalledWith('p1');
    await Promise.resolve();
  });
});
