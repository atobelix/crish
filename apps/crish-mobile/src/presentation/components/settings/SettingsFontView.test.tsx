// 字体与字号子页交互测试（W-A 条 5）：选项渲染 / 点击回调 / 预览区 / 选中态。
// 注意（实测踩坑）：同一用例内两次 fireEvent.press 会让下一次 render 产出空树
// （RNTL v14 与本工程 jest 环境的交互问题），故每个 press 用例只按一次、且排在最后。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement } from 'react';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { SettingsFontView } from './SettingsFontView';

afterEach(() => {
  cleanup();
});

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

function makeVm(overrides: Partial<SettingsVm> = {}): SettingsVm {
  return {
    connected: false,
    host: null,
    port: null,
    themeMode: 'system',
    setThemeMode: jest.fn(),
    fontScale: 'standard',
    setFontScale: jest.fn(),
    monoFont: 'system',
    setMonoFont: jest.fn(),
    hapticsEnabled: false,
    hapticsStrength: 'standard',
    setHapticsEnabled: jest.fn(),
    setHapticsStrength: jest.fn(),
    notifyMasterOn: true,
    notifyScenes: {
      message: true,
      taskDone: true,
      approval: true,
      error: true,
      deviceOffline: false,
    },
    webSearchEnabled: false,
    notifyPermission: 'granted',
    notifySwitchGate: { enabled: true, hint: null },
    setNotifyMasterOn: jest.fn(),
    setNotifyScene: jest.fn(async () => {}),
    removeLocal: jest.fn(async () => {}),
    ...overrides,
  };
}

async function renderView(element: ReactElement) {
  return render(element, { wrapper: Providers });
}

describe('SettingsFontView', () => {
  it('渲染两组选项与预览区', async () => {
    const view = await renderView(
      <SettingsFontView vm={makeVm()} onBack={jest.fn()} />
    );
    expect(view.getByTestId('settings-font-scale-standard')).toBeTruthy();
    expect(view.getByTestId('settings-font-mono-system')).toBeTruthy();
    expect(view.getByText('字体与字号')).toBeTruthy();
    expect(view.getByText('正文字号')).toBeTruthy();
    expect(view.getByText('标准')).toBeTruthy();
    expect(view.getByText('大')).toBeTruthy();
    expect(view.getByText('特大')).toBeTruthy();
    expect(view.getByText('代码字体')).toBeTruthy();
    expect(view.getByText('系统等宽')).toBeTruthy();
    expect(view.getByText('JetBrains Mono')).toBeTruthy();
    expect(view.getByText('Fira Code')).toBeTruthy();
    // 预览：正文样本 + 配对码数字（Q1 即时预览 / Q2 codeDigit）
    expect(
      view.getByText('清晨的阳光落在窗台上，新的一天才刚刚开始。')
    ).toBeTruthy();
    expect(view.getByText('483920')).toBeTruthy();
  });

  it('选中态跟随 vm 值呈现（xlarge / jetbrains 不误报回调）', async () => {
    const vm = makeVm({ fontScale: 'xlarge', monoFont: 'jetbrains' });
    const view = await renderView(
      <SettingsFontView vm={vm} onBack={jest.fn()} />
    );
    expect(view.getByTestId('settings-font-scale-xlarge')).toBeTruthy();
    expect(view.getByTestId('settings-font-mono-jetbrains')).toBeTruthy();
    expect(vm.setFontScale).not.toHaveBeenCalled();
    expect(vm.setMonoFont).not.toHaveBeenCalled();
  });

  it('点「大」→ setFontScale(large)', async () => {
    const vm = makeVm();
    const view = await renderView(
      <SettingsFontView vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('settings-font-scale-large'));
    expect(vm.setFontScale).toHaveBeenCalledWith('large');
  });

  it('点 Fira Code → setMonoFont(fira)', async () => {
    const vm = makeVm();
    const view = await renderView(
      <SettingsFontView vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('settings-font-mono-fira'));
    expect(vm.setMonoFont).toHaveBeenCalledWith('fira');
  });
});
