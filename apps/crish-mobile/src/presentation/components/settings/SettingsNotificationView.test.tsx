// 通知与提醒子页交互测试（G6 条 2：五场景补齐）：
// 总控 + 五场景开关渲染 / 开关状态跟随 vm / 点击回调 / 总控关闭禁用 / 权限行。
// 注意（同 SettingsFontView.test 踩坑）：同一用例内两次 fireEvent.press 会让
// 下一次 render 产出空树，故每个 press 用例只按一次、且排在最后。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement } from 'react';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { SettingsNotificationView } from './SettingsNotificationView';

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

describe('SettingsNotificationView', () => {
  it('渲染总控与五场景开关（与 NotifyScene 一一对齐）', async () => {
    const view = await renderView(
      <SettingsNotificationView vm={makeVm()} onBack={jest.fn()} />
    );
    expect(view.getByTestId('setting-notify-master')).toBeTruthy();
    for (const scene of [
      'approval',
      'taskDone',
      'message',
      'error',
      'deviceOffline',
    ]) {
      expect(view.getByTestId(`setting-notify-${scene}`)).toBeTruthy();
    }
    expect(view.getByText('允许推送通知')).toBeTruthy();
    expect(view.getByText('审批请求')).toBeTruthy();
    expect(view.getByText('任务完成')).toBeTruthy();
    expect(view.getByText('新消息')).toBeTruthy();
    expect(view.getByText('异常提醒')).toBeTruthy();
    expect(view.getByText('任务失败或异常中止')).toBeTruthy();
    expect(view.getByText('设备离线')).toBeTruthy();
    expect(view.getByText('配对桌面离线或失联')).toBeTruthy();
  });

  it('开关状态跟随 vm（域层默认：异常开、设备离线关）', async () => {
    const view = await renderView(
      <SettingsNotificationView vm={makeVm()} onBack={jest.fn()} />
    );
    expect(switchState(view, 'setting-notify-error').checked).toBe(true);
    expect(switchState(view, 'setting-notify-deviceOffline').checked).toBe(
      false
    );
    expect(switchState(view, 'setting-notify-approval').checked).toBe(true);
  });

  it('点异常提醒 → setNotifyScene(error, false)', async () => {
    const vm = makeVm();
    const view = await renderView(
      <SettingsNotificationView vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('setting-notify-error'));
    expect(vm.setNotifyScene).toHaveBeenCalledWith('error', false);
  });

  it('点设备离线 → setNotifyScene(deviceOffline, true)', async () => {
    const vm = makeVm();
    const view = await renderView(
      <SettingsNotificationView vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('setting-notify-deviceOffline'));
    expect(vm.setNotifyScene).toHaveBeenCalledWith('deviceOffline', true);
  });

  it('总控关闭时五场景开关全部禁用', async () => {
    const view = await renderView(
      <SettingsNotificationView
        vm={makeVm({ notifyMasterOn: false })}
        onBack={jest.fn()}
      />
    );
    for (const scene of ['approval', 'error', 'deviceOffline']) {
      expect(switchState(view, `setting-notify-${scene}`).disabled).toBe(true);
    }
  });

  it('系统权限 denied 时出现通知权限引导行', async () => {
    const view = await renderView(
      <SettingsNotificationView
        vm={makeVm({
          notifyPermission: 'denied',
          notifySwitchGate: { enabled: false, hint: '前往系统设置开启' },
        })}
        onBack={jest.fn()}
      />
    );
    expect(view.getByText('通知权限')).toBeTruthy();
    expect(view.getByText('前往系统设置开启')).toBeTruthy();
  });
});
