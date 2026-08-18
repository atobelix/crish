// SettingsScreenView 组件测试（R2-06 设置页主视图）：
// 分组渲染（通用/通知偏好/文件/关于/移除本机）/ 开关状态与切换 /
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
    approvalNotifications: true,
    eventNotifications: true,
    thumbnailWifiOnly: true,
    setApprovalNotifications: jest.fn(),
    setEventNotifications: jest.fn(),
    setThumbnailWifiOnly: jest.fn(),
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
  it('渲染四大分组 + 移除本机危险区', async () => {
    await render(
      <SettingsScreenView vm={makeVm()} onConfirmRemove={jest.fn()} />
    );
    expect(screen.getByText('通用')).toBeTruthy();
    expect(screen.getByText('通知偏好')).toBeTruthy();
    expect(screen.getByText('文件')).toBeTruthy();
    expect(screen.getByText('关于')).toBeTruthy();
    expect(screen.getByTestId('settings-remove-local')).toBeTruthy();
  });

  it('开关状态回显（开/关）', async () => {
    await render(
      <SettingsScreenView
        vm={makeVm({
          approvalNotifications: false,
          eventNotifications: true,
          thumbnailWifiOnly: false,
        })}
        onConfirmRemove={jest.fn()}
      />
    );
    expect(
      screen.getByTestId('setting-approval-notifications-switch').props.value
    ).toBe(false);
    expect(
      screen.getByTestId('setting-event-notifications-switch').props.value
    ).toBe(true);
    expect(
      screen.getByTestId('setting-thumbnail-wifi-switch').props.value
    ).toBe(false);
  });

  it('开关切换 → vm setter 调用', async () => {
    const vm = makeVm();
    await render(<SettingsScreenView vm={vm} onConfirmRemove={jest.fn()} />);
    await fireEvent(
      screen.getByTestId('setting-approval-notifications-switch'),
      'valueChange',
      false
    );
    expect(vm.setApprovalNotifications).toHaveBeenCalledWith(false);
    await fireEvent(
      screen.getByTestId('setting-thumbnail-wifi-switch'),
      'valueChange',
      true
    );
    expect(vm.setThumbnailWifiOnly).toHaveBeenCalledWith(true);
  });

  it('未连接 → 横幅 + 开关禁用（任务书「未连接」禁用态）', async () => {
    await render(
      <SettingsScreenView
        vm={makeVm({ connected: false, aboutStatus: 'disconnected' })}
        onConfirmRemove={jest.fn()}
      />
    );
    expect(screen.getByTestId('settings-disconnected')).toBeTruthy();
    expect(
      screen.getByTestId('setting-approval-notifications-switch').props.disabled
    ).toBe(true);
    expect(
      screen.getByTestId('setting-event-notifications-switch').props.disabled
    ).toBe(true);
    expect(
      screen.getByTestId('setting-thumbnail-wifi-switch').props.disabled
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
