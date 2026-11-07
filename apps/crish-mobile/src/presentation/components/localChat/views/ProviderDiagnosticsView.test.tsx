// 连接诊断页呈现契约（P1）：
// - 进入页面自动测一次（runPing）；
// - 成功：文案是「模型列表请求耗时」+ 毫秒值，全页不把耗时称作「网络延迟」；
// - 失败：展示既有错误原文，不展示耗时值。
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ProviderDetailVm } from '@/adapters/viewmodels/useProviderDetailVm';
import type { LocalProviderSpec } from '@/domain/types/localChat';
import { ToastProvider } from '@/presentation/ui';
import ProviderDiagnosticsView from './ProviderDiagnosticsView';

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

const provider: LocalProviderSpec = {
  displayName: '示例供应商',
  baseUrl: 'https://api.example.com/v1',
  protocol: 'openai/chat',
  models: [],
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
    models: [],
    storedModels: [],
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

describe('ProviderDiagnosticsView P1 契约', () => {
  it('成功分支：自动测一次，文案「模型列表请求耗时」+ 毫秒值', async () => {
    const vm = makeVm({
      pingResult: { ok: true, latencyMs: 123, error: null },
    });
    const view = await render(
      <ProviderDiagnosticsView providerId="p1" vm={vm} onBack={() => {}} />,
      { wrapper: Providers }
    );

    expect(vm.runPing).toHaveBeenCalledTimes(1);
    expect(view.getByText('模型列表请求耗时')).toBeTruthy();
    expect(view.getByTestId('diagnostics-latency-value').props.children).toBe(
      '123ms'
    );
    expect(view.queryByText(/网络延迟/)).toBeNull();
    expect(view.queryByTestId('diagnostics-error')).toBeNull();
  });

  it('失败分支：展示既有错误原文，不展示耗时值', async () => {
    const vm = makeVm({
      pingResult: {
        ok: false,
        latencyMs: 0,
        error: {
          kind: 'network',
          status: null,
          message: '无法连接到服务器，请检查网络后重试',
          retryable: true,
        },
      },
    });
    const view = await render(
      <ProviderDiagnosticsView providerId="p1" vm={vm} onBack={() => {}} />,
      { wrapper: Providers }
    );

    expect(vm.runPing).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('diagnostics-error')).toBeTruthy();
    expect(
      view.getByText('无法连接到服务器，请检查网络后重试')
    ).toBeTruthy();
    expect(view.queryByTestId('diagnostics-latency-value')).toBeNull();
  });
});
