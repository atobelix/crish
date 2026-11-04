// 连接设备 Sheet（G4）：账号多设备列表/切换、离线灰置、局域网行保留与让位。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { DeviceStatusVm } from '@/adapters/viewmodels/useDeviceStatusVm';
import { DeviceSheet } from './DeviceSheet';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function makeVm(overrides: Partial<DeviceStatusVm> = {}): DeviceStatusVm {
  return {
    connected: false,
    phaseLabel: '未连接',
    host: null,
    lastError: null,
    reconnect: jest.fn(),
    accountMode: false,
    relayEngaged: false,
    devices: [],
    targetDeviceId: null,
    pairedHost: null,
    switchDevice: jest.fn(),
    refreshDevices: jest.fn(),
    currentDeviceName: '本机',
    localDevice: { name: '本机', selected: true },
    switchToLocal: jest.fn(),
    ...overrides,
  };
}

async function renderSheet(
  vm: DeviceStatusVm,
  onClose = jest.fn(),
  onOpenScan = jest.fn(),
  onUseLocal = jest.fn()
) {
  const view = await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <DeviceSheet
        visible
        onClose={onClose}
        device={vm}
        onOpenScan={onOpenScan}
        onUseLocal={onUseLocal}
        testID="device-sheet"
      />
    </SafeAreaProvider>
  );
  return { view, onClose, onOpenScan, onUseLocal };
}

describe('DeviceSheet · 本机行（恒在）', () => {
  it('非账号模式：本机行在场，本地生效时选中（无多余 subtitle）', async () => {
    const vm = makeVm({ pairedHost: '192.168.1.2' });
    const { view } = await renderSheet(vm);
    const localRow = view.getByTestId('device-sheet-local');
    expect(localRow.props.accessibilityState.selected).toBe(true);
    expect(view.queryByText('当前设备')).toBeNull();
  });

  it('非账号模式远端在效时点本机行 = onUseLocal 导航（不解绑配对）', async () => {
    const vm = makeVm({
      pairedHost: '192.168.1.2',
      host: '192.168.1.2',
      connected: true,
      localDevice: { name: '本机', selected: false },
    });
    const { view, onClose, onUseLocal } = await renderSheet(vm);
    await fireEvent.press(view.getByTestId('device-sheet-local'));
    expect(onUseLocal).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
    expect(vm.switchToLocal).not.toHaveBeenCalled();
  });
});

describe('DeviceSheet · 非账号模式（历史单设备形态不回归）', () => {
  it('渲染配对行 + 扫码行，无账号设备行', async () => {
    const vm = makeVm({ pairedHost: '192.168.1.2', host: '192.168.1.2' });
    const { view } = await renderSheet(vm);
    expect(view.getByTestId('device-sheet-current')).toBeTruthy();
    expect(view.getByText('192.168.1.2')).toBeTruthy();
    expect(view.getByTestId('device-sheet-scan')).toBeTruthy();
    expect(view.queryByText('暂无已知电脑')).toBeNull();
  });

  it('未连接时点配对行 = 重连并关闭', async () => {
    const vm = makeVm({ pairedHost: '192.168.1.2' });
    const { view, onClose } = await renderSheet(vm);
    await fireEvent.press(view.getByTestId('device-sheet-current'));
    expect(vm.reconnect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('DeviceSheet · 账号模式多设备', () => {
  const twoDevices: DeviceStatusVm['devices'] = [
    { id: 'desk-a', name: '办公电脑', online: true, isTarget: true },
    { id: 'desk-b', name: '家里的电脑', online: false, isTarget: false },
    { id: 'desk-c', name: '书房电脑', online: true, isTarget: false },
  ];

  it('打开时补一轮发现；渲染全部设备行，目标带选中、离线行禁用', async () => {
    const vm = makeVm({
      accountMode: true,
      relayEngaged: true,
      devices: twoDevices,
      targetDeviceId: 'desk-a',
      connected: true,
      host: '办公电脑',
    });
    const { view } = await renderSheet(vm);
    expect(vm.refreshDevices).toHaveBeenCalled();
    expect(view.getByText('办公电脑')).toBeTruthy();
    expect(view.getByText('家里的电脑')).toBeTruthy();
    expect(view.getByText('书房电脑')).toBeTruthy();
    const offlineRow = view.getByTestId('device-sheet-device-desk-b');
    expect(offlineRow.props.accessibilityState.disabled).toBe(true);
    const targetRow = view.getByTestId('device-sheet-device-desk-a');
    expect(targetRow.props.accessibilityState.selected).toBe(true);
    // 纯净极简：无冗余状态字（在线/离线/当前设备）
    expect(view.queryByText('在线')).toBeNull();
    expect(view.queryByText('离线')).toBeNull();
    expect(view.queryByText('当前设备')).toBeNull();
    // 中继接管时配对行让位（不把非当前连接误报为当前设备）
    expect(view.queryByTestId('device-sheet-current')).toBeNull();
  });

  it('点在线非目标设备 = 切换并关闭', async () => {
    const vm = makeVm({
      accountMode: true,
      relayEngaged: true,
      devices: twoDevices,
      targetDeviceId: 'desk-a',
      connected: true,
    });
    const { view, onClose } = await renderSheet(vm);
    await fireEvent.press(view.getByTestId('device-sheet-device-desk-c'));
    expect(vm.switchDevice).toHaveBeenCalledWith('desk-c');
    expect(onClose).toHaveBeenCalled();
  });

  it('点当前目标行（未连接）= 重连，不触发切换', async () => {
    const vm = makeVm({
      accountMode: true,
      relayEngaged: true,
      devices: twoDevices,
      targetDeviceId: 'desk-a',
      connected: false,
      phaseLabel: '连接中',
    });
    const { view } = await renderSheet(vm);
    await fireEvent.press(view.getByTestId('device-sheet-device-desk-a'));
    expect(vm.reconnect).toHaveBeenCalledTimes(1);
    expect(vm.switchDevice).not.toHaveBeenCalled();
  });

  it('空目录：纯净极简（无多余文字，仅本机行与扫码行）', async () => {
    const vm = makeVm({ accountMode: true, devices: [] });
    const { view } = await renderSheet(vm);
    expect(view.queryByText('暂无已知电脑')).toBeNull();
    expect(view.queryByText('登录同一账号的电脑将显示在此')).toBeNull();
    expect(view.queryByText('当前设备')).toBeNull();
    expect(view.getByTestId('device-sheet-local')).toBeTruthy();
    expect(view.getByTestId('device-sheet-scan')).toBeTruthy();
  });

  it('本机行恒在且本地生效时选中（账号模式，目录非空）', async () => {
    const vm = makeVm({
      accountMode: true,
      relayEngaged: false,
      devices: twoDevices,
      targetDeviceId: null,
      localDevice: { name: '本机', selected: true },
    });
    const { view } = await renderSheet(vm);
    const localRow = view.getByTestId('device-sheet-local');
    expect(localRow).toBeTruthy();
    expect(localRow.props.accessibilityState.selected).toBe(true);
    expect(view.getByText('本机')).toBeTruthy();
  });

  it('账号模式点本机行 = 切本地（switchToLocal）并关闭', async () => {
    const vm = makeVm({
      accountMode: true,
      relayEngaged: true,
      devices: twoDevices,
      targetDeviceId: 'desk-a',
      connected: true,
      localDevice: { name: '本机', selected: false },
    });
    const { view, onClose } = await renderSheet(vm);
    await fireEvent.press(view.getByTestId('device-sheet-local'));
    expect(vm.switchToLocal).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('中继未接管且已配对：账号行与配对行并存（配对设备管理不回归）', async () => {
    const vm = makeVm({
      accountMode: true,
      relayEngaged: false,
      pairedHost: '192.168.1.2',
      devices: twoDevices,
      targetDeviceId: 'desk-a',
    });
    const { view } = await renderSheet(vm);
    expect(view.getByTestId('device-sheet-device-desk-a')).toBeTruthy();
    expect(view.getByTestId('device-sheet-current')).toBeTruthy();
  });
});
