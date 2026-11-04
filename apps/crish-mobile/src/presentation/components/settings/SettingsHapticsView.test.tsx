// 震动反馈子页交互测试（2026-11-03 裁决：设置控制、默认关）：
// 总开关 + 强度三档渲染 / 开关状态跟随 vm / 点击回调 / 关闭态强度行弱化。
// 注意（同 SettingsNotificationView.test 踩坑）：每个 press 用例只按一次、
// 且排在最后。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement } from 'react';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { SettingsHapticsView } from './SettingsHapticsView';

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

function switchState(
  view: Awaited<ReturnType<typeof renderView>>,
  testID: string
) {
  const node = view.getByTestId(testID);
  return node.props.accessibilityState as {
    checked?: boolean;
    disabled?: boolean;
  };
}

describe('SettingsHapticsView', () => {
  it('渲染总开关与强度三档', async () => {
    const view = await renderView(
      <SettingsHapticsView vm={makeVm()} onBack={jest.fn()} />
    );
    expect(view.getByTestId('setting-haptics-enabled')).toBeTruthy();
    for (const strength of ['light', 'standard', 'strong']) {
      expect(view.getByTestId(`settings-haptics-${strength}`)).toBeTruthy();
    }
    // 页标题与总开关行同名「震动反馈」（标题 + 行各一）
    expect(view.getAllByText('震动反馈')).toHaveLength(2);
    expect(view.getByText('轻')).toBeTruthy();
    expect(view.getByText('标准')).toBeTruthy();
    expect(view.getByText('强')).toBeTruthy();
  });

  it('开关状态跟随 vm（默认关）', async () => {
    const view = await renderView(
      <SettingsHapticsView vm={makeVm()} onBack={jest.fn()} />
    );
    expect(switchState(view, 'setting-haptics-enabled').checked).toBe(false);
  });

  it('开关状态跟随 vm（开启 + 强档）', async () => {
    const view = await renderView(
      <SettingsHapticsView
        vm={makeVm({ hapticsEnabled: true, hapticsStrength: 'strong' })}
        onBack={jest.fn()}
      />
    );
    expect(switchState(view, 'setting-haptics-enabled').checked).toBe(true);
  });

  it('点总开关 → setHapticsEnabled(true)', async () => {
    const vm = makeVm();
    const view = await renderView(
      <SettingsHapticsView vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('setting-haptics-enabled'));
    expect(vm.setHapticsEnabled).toHaveBeenCalledWith(true);
  });

  it('点强度行 → setHapticsStrength(strong)', async () => {
    const vm = makeVm({ hapticsEnabled: true });
    const view = await renderView(
      <SettingsHapticsView vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('settings-haptics-strong'));
    expect(vm.setHapticsStrength).toHaveBeenCalledWith('strong');
  });

  it('点强度行 → setHapticsStrength(light)', async () => {
    const vm = makeVm({ hapticsEnabled: true });
    const view = await renderView(
      <SettingsHapticsView vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('settings-haptics-light'));
    expect(vm.setHapticsStrength).toHaveBeenCalledWith('light');
  });
});
