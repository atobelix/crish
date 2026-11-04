// 供应商编辑页呈现契约（2026-11-02 用户点名整治）：
// - 保存主按钮填充 = actionPrimary 亮绿（裁决恢复，推翻 D3 深绿）；
// - 四个输入框均为 field 白盒（grouped 背景上可见），不是 fillSubtle 隐形壳；
// - 拉取模型列表 / 连通性检查 / 添加 是真按钮形态（surface 白填充胶囊、
//   可按压、点按直达 VM 动作），不再是大号粗黑字与标题无异。
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { lightTheme } from '@/adapters/platform/theme';
import type { LocalProviderEditVm } from '@/adapters/viewmodels/useLocalProviderEditVm';
import { ToastProvider } from '@/presentation/ui';
import LocalProviderEditView from './LocalProviderEditView';

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

type FlatStyle = Record<string, unknown>;

/** 解析节点 style（数组 / 函数式 Pressable style 均摊平为单对象，未按下态） */
function flatStyleOf(node: { props: { style?: unknown } }): FlatStyle {
  const raw = node.props.style as unknown;
  const resolved =
    typeof raw === 'function'
      ? (raw as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : raw;
  return (StyleSheet.flatten(resolved as never) ?? {}) as FlatStyle;
}

function makeVm(
  overrides: Partial<LocalProviderEditVm> = {}
): LocalProviderEditVm {
  return {
    providerId: 'p1',
    isNew: false,
    draft: {
      name: 'nee',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      modelIds: ['gpt-6-luna'],
      defaultModelId: 'gpt-6-luna',
    },
    hasStoredKey: true,
    issues: [],
    canSave: true,
    fetchingModels: false,
    fetchError: null,
    checking: false,
    checkResult: null,
    saved: false,
    setName: jest.fn(),
    setBaseUrl: jest.fn(),
    setApiKey: jest.fn(),
    setDefaultModelId: jest.fn(),
    addModel: jest.fn(),
    removeModel: jest.fn(),
    fetchModels: jest.fn(async () => {}),
    checkConnectivity: jest.fn(async () => {}),
    save: jest.fn(async () => true),
    clearStoredKey: jest.fn(async () => {}),
    ...overrides,
  };
}

async function renderView(vm: LocalProviderEditVm) {
  return await render(
    <LocalProviderEditView
      vm={vm}
      onBack={() => {}}
      onSaved={() => {}}
      onDelete={async () => {}}
    />,
    { wrapper: Providers }
  );
}

describe('LocalProviderEditView 呈现契约', () => {
  // 单例合并：本页第二个 render 在先行用例的异步 press 处理落定前按 testID
  // 查找 TextInput 会落空（bisect 实测的跨用例 act 污染），故全部断言同居
  // 一例、一次渲染完成；点按断言放最后，避免悬挂的异步处理影响查询。
  it('保存 = 亮绿；拉取/检查/添加 = 白胶囊按钮；四输入框 = field 白盒', async () => {
    const vm = makeVm();
    const view = await renderView(vm);

    // 主按钮：亮绿填充
    expect(
      flatStyleOf(view.getByTestId('local-provider-save')).backgroundColor
    ).toBe(lightTheme.colors.actionPrimary);

    // 次级动作：surface 白填充胶囊（与主按钮亮绿区分）
    const fetchBtn = view.getByTestId('local-provider-fetch-models');
    expect(flatStyleOf(fetchBtn).backgroundColor).toBe(
      lightTheme.colors.surface
    );
    const checkBtn = view.getByTestId('local-provider-check-connectivity');
    expect(flatStyleOf(checkBtn).backgroundColor).toBe(
      lightTheme.colors.surface
    );
    expect(
      flatStyleOf(view.getByTestId('local-model-add')).backgroundColor
    ).toBe(lightTheme.colors.surface);

    // 四个输入框均为 field 白盒（壳底 = field，不是与背景同值的 fillSubtle；
    // 壳 = TextInput 的父节点，reanimated 桩下动画底色求值为静置端）
    for (const testID of [
      'local-provider-name',
      'local-provider-base-url',
      'local-provider-api-key',
      'local-model-input',
    ]) {
      const shell = view.getByTestId(testID).parent;
      expect(shell).toBeTruthy();
      expect(flatStyleOf(shell!).backgroundColor).toBe(lightTheme.colors.field);
    }

    // 点按直达 VM 动作（收尾执行）
    fireEvent.press(fetchBtn);
    expect(vm.fetchModels).toHaveBeenCalledTimes(1);
    fireEvent.press(checkBtn);
    expect(vm.checkConnectivity).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});
