// SettingsScreenView 组件测试（R2-06 设置页主视图 · R4 批次2 单真源）：
// 分组渲染（通用/通知偏好/关于/移除本机）/ 总开关 + 场景开关状态与切换 /
// 权限 denied → 场景开关禁用 + 引导文案（F6 §10.3）/
// 未连接 → 开关禁用 + 「未连接」提示 / 移除本机双保险经 onConfirmRemove 上抛
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import type { PresenceResult } from '@crish/shared-types';
import SettingsScreenView from './SettingsScreenView';

function makeVm(overrides: Partial<SettingsVm> = {}): SettingsVm {
  return {
    connected: true,
    themeMode: 'system',
    setThemeMode: jest.fn(),
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
    aboutStatus: 'loaded',
    presence: {
      desktopOnline: true,
      engineVersion: '1.4.2',
    } satisfies PresenceResult,
    mirror: {
      permissionMode: 'ask',
      trustedCommandCount: 12,
      activeProfileId: null,
    },
    host: '192.168.1.5',
    desktopId: 'hub-1',
    deviceId: 'dev-1',
    refreshAbout: jest.fn(),
    removeLocal: jest.fn(async () => true),
    ...overrides,
  };
}

describe('SettingsScreenView 分组渲染（F6 §12.6）', () => {
  it('渲染三大分组 + 移除本机危险区（缩略图假开关已删除，无「文件」组）', async () => {
    await render(
      <SettingsScreenView vm={makeVm()} onConfirmRemove={jest.fn()} />
    );
    expect(screen.getByText('通用')).toBeTruthy();
    expect(screen.getByText('通知偏好')).toBeTruthy();
    expect(screen.getByText('关于')).toBeTruthy();
    expect(screen.getByTestId('settings-remove-local')).toBeTruthy();
    expect(screen.queryByText('文件')).toBeNull();
  });

  it('渲染总开关 + 三个有通道映射的场景开关（error/deviceOffline 无通道不渲染）', async () => {
    await render(
      <SettingsScreenView vm={makeVm()} onConfirmRemove={jest.fn()} />
    );
    expect(screen.getByTestId('setting-notify-master')).toBeTruthy();
    expect(screen.getByTestId('setting-notify-approval')).toBeTruthy();
    expect(screen.getByTestId('setting-notify-task-done')).toBeTruthy();
    expect(screen.getByTestId('setting-notify-message')).toBeTruthy();
  });

  it('开关状态回显（总开/审批关）', async () => {
    await render(
      <SettingsScreenView
        vm={makeVm({
          notifyScenes: {
            message: true,
            taskDone: true,
            approval: false,
            error: true,
            deviceOffline: false,
          },
        })}
        onConfirmRemove={jest.fn()}
      />
    );
    expect(screen.getByTestId('setting-notify-master-switch').props.value).toBe(
      true
    );
    expect(
      screen.getByTestId('setting-notify-approval-switch').props.value
    ).toBe(false);
    expect(
      screen.getByTestId('setting-notify-task-done-switch').props.value
    ).toBe(true);
  });

  it('开关切换 → vm setter 调用（总开关同步 / 场景开关 async）', async () => {
    const vm = makeVm();
    await render(<SettingsScreenView vm={vm} onConfirmRemove={jest.fn()} />);
    await fireEvent(
      screen.getByTestId('setting-notify-master-switch'),
      'valueChange',
      false
    );
    expect(vm.setNotifyMasterOn).toHaveBeenCalledWith(false);
    await fireEvent(
      screen.getByTestId('setting-notify-approval-switch'),
      'valueChange',
      false
    );
    expect(vm.setNotifyScene).toHaveBeenCalledWith('approval', false);
  });

  it('权限 denied → 场景开关禁用 + 引导文案并入描述（总开关不受门控）', async () => {
    await render(
      <SettingsScreenView
        vm={makeVm({
          notifyPermission: 'denied',
          notifySwitchGate: {
            enabled: false,
            hint: '系统通知权限未开启——前往设置开启',
          },
        })}
        onConfirmRemove={jest.fn()}
      />
    );
    expect(
      screen.getByTestId('setting-notify-approval-switch').props.disabled
    ).toBe(true);
    expect(
      screen.getByTestId('setting-notify-master-switch').props.disabled
    ).toBe(false);
    expect(screen.getAllByText(/前往设置开启/).length).toBeGreaterThan(0);
  });

  it('未连接 → 横幅 + 全部开关禁用（任务书「未连接」禁用态）', async () => {
    await render(
      <SettingsScreenView
        vm={makeVm({ connected: false, aboutStatus: 'disconnected' })}
        onConfirmRemove={jest.fn()}
      />
    );
    expect(screen.getByTestId('settings-disconnected')).toBeTruthy();
    expect(
      screen.getByTestId('setting-notify-master-switch').props.disabled
    ).toBe(true);
    expect(
      screen.getByTestId('setting-notify-approval-switch').props.disabled
    ).toBe(true);
    // 禁用附原因文案（不只靠颜色，M4 §6.2-4）
    expect(screen.getAllByText('未连接').length).toBeGreaterThan(0);
  });

  it('关于区：版本 + 桌面连接信息 + 镜像摘要（只读参考）', async () => {
    await render(
      <SettingsScreenView vm={makeVm()} onConfirmRemove={jest.fn()} />
    );
    expect(screen.getByText('1.4.2')).toBeTruthy();
    expect(screen.getByText('在线')).toBeTruthy();
    expect(screen.getByText('192.168.1.5')).toBeTruthy();
    expect(screen.getByText('桌面 #hub-')).toBeTruthy();
    expect(screen.getByText(/ask/)).toBeTruthy();
  });

  it('移除本机：双保险确认 → onConfirmRemove 上抛一次', async () => {
    const onConfirmRemove = jest.fn(async () => {});
    await render(
      <SettingsScreenView vm={makeVm()} onConfirmRemove={onConfirmRemove} />
    );
    await fireEvent.press(screen.getByTestId('settings-remove-local'));
    await fireEvent.press(screen.getByTestId('settings-remove-confirm'));
    expect(onConfirmRemove).toHaveBeenCalledTimes(1);
  });
});
