// 通知权限单测（R3-04）：三态折叠 / 查询不弹窗 / 请求先建渠道（顺序铁律）
import {
  getPermissionsAsync,
  requestPermissionsAsync,
  setNotificationChannelAsync,
} from 'expo-notifications';
import {
  mapPermissionStatus,
  notificationPermissionStore,
} from './permissions';

const statusOf = () => notificationPermissionStore.getState().status;
const checkedOf = () => notificationPermissionStore.getState().checked;
const refreshingOf = () => notificationPermissionStore.getState().refreshing;

function resetPermissionStoreForTest(): void {
  notificationPermissionStore.setState({
    status: 'undetermined',
    checked: false,
    refreshing: false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPermissionStoreForTest();
});

describe('mapPermissionStatus（三态折叠）', () => {
  it('granted 布尔为最终裁决（iOS PROVISIONAL/EPHEMERAL 亦计 granted，D7 §7.5）', () => {
    expect(mapPermissionStatus({ status: 'granted', granted: true })).toBe(
      'granted'
    );
    expect(mapPermissionStatus({ status: 'undetermined', granted: true })).toBe(
      'granted'
    );
    expect(mapPermissionStatus({ status: 'denied', granted: false })).toBe(
      'denied'
    );
    expect(
      mapPermissionStatus({ status: 'undetermined', granted: false })
    ).toBe('undetermined');
  });
});

describe('refresh（getPermissionsAsync 查询，不弹窗）', () => {
  it('granted → 置位 granted + checked', async () => {
    (getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'granted',
      granted: true,
    });
    await expect(
      notificationPermissionStore.getState().refresh()
    ).resolves.toBe('granted');
    expect(statusOf()).toBe('granted');
    expect(checkedOf()).toBe(true);
    // 查询路径不得触发系统弹窗
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('denied → 拒绝态透出（UI 引导到系统设置）', async () => {
    (getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'denied',
      granted: false,
    });
    await expect(
      notificationPermissionStore.getState().refresh()
    ).resolves.toBe('denied');
    expect(statusOf()).toBe('denied');
    expect(checkedOf()).toBe(true);
  });

  it('undetermined → 未决定态（首次冷启动，UI 按 D7 §7.5 时机引导）', async () => {
    (getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'undetermined',
      granted: false,
    });
    await expect(
      notificationPermissionStore.getState().refresh()
    ).resolves.toBe('undetermined');
    expect(statusOf()).toBe('undetermined');
    expect(checkedOf()).toBe(true);
  });

  it('查询失败回退 undetermined 不阻塞启动', async () => {
    (getPermissionsAsync as jest.Mock).mockRejectedValue(
      new Error('no native module')
    );
    await expect(
      notificationPermissionStore.getState().refresh()
    ).resolves.toBe('undetermined');
    expect(statusOf()).toBe('undetermined');
    expect(refreshingOf()).toBe(false);
  });
});

describe('request（requestPermissionsAsync + 顺序铁律）', () => {
  it('已授权 → 静默返回，不建渠道不弹窗', async () => {
    (getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'granted',
      granted: true,
    });
    await expect(
      notificationPermissionStore.getState().request()
    ).resolves.toBe('granted');
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('未授权 → 先建渠道（顺序铁律 D7 §7.5 / M8 §4.2.3 ①）再请求，返回最终态', async () => {
    (getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'undetermined',
      granted: false,
    });
    (requestPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'granted',
      granted: true,
    });
    await expect(
      notificationPermissionStore.getState().request()
    ).resolves.toBe('granted');
    // 渠道创建必须先于权限请求（Android 13+ 弹窗依赖已存在渠道）
    const channelMock = setNotificationChannelAsync as jest.Mock;
    const requestMock = requestPermissionsAsync as jest.Mock;
    expect(channelMock.mock.invocationCallOrder[0]!).toBeLessThan(
      requestMock.mock.invocationCallOrder[0]!
    );
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(statusOf()).toBe('granted');
    expect(checkedOf()).toBe(true);
  });

  it('用户拒绝 → denied 透出（checked 仍置位，供引导卡展示）', async () => {
    (getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'undetermined',
      granted: false,
    });
    (requestPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'denied',
      granted: false,
    });
    await expect(
      notificationPermissionStore.getState().request()
    ).resolves.toBe('denied');
    expect(statusOf()).toBe('denied');
    expect(checkedOf()).toBe(true);
  });
});
