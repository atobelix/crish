// 通知层初始化单测（R3-04）：顺序铁律（建渠道 → 权限 → handler → 监听）+ 冷启动深链
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  getLastNotificationResponseAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  setNotificationChannelAsync,
  setNotificationHandler,
} from 'expo-notifications';
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import { notificationPermissionStore } from './permissions';
import { initNotificationLayer } from './index';

const responseWithApproval = {
  actionIdentifier: 'default',
  notification: {
    request: {
      identifier: 'n-1',
      content: {
        title: 'Crish 需要你的批准',
        body: 'bash：执行部署脚本',
        data: {
          eventType: 'approval-requested',
          dedupeKey: 'approval-requested:tc-9f3a',
          screen: 'approval',
          toolCallId: 'tc-9f3a',
        },
      },
    },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  resetNotificationsForTest();
  notificationPermissionStore.setState({
    status: 'undetermined',
    checked: false,
    refreshing: false,
  });
});

describe('initNotificationLayer（初始化顺序铁律，D7 §7.5 / M8 §4.2.3）', () => {
  it('建渠道先于权限查询；handler 与监听就位；返回 dispose 可解绑', async () => {
    const handle = await initNotificationLayer({ navigate: jest.fn() });

    // ① 渠道创建在权限查询之前（invocationCallOrder 断言）
    const channelMock = setNotificationChannelAsync as jest.Mock;
    const permissionMock = getPermissionsAsync as jest.Mock;
    expect(channelMock).toHaveBeenCalledTimes(4);
    expect(channelMock.mock.invocationCallOrder[0]!).toBeLessThan(
      permissionMock.mock.invocationCallOrder[0]!
    );
    // ② 查询不弹窗（init 只 refresh；引导由 UI 层按 D7 §7.5 时机 request）
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    // ③ 前台 handler 安装
    expect(setNotificationHandler).toHaveBeenCalledTimes(1);
    // ④ 监听注册（received + response）
    expect(addNotificationReceivedListener).toHaveBeenCalledTimes(1);
    expect(addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(handle.permissionStatus).toBe('undetermined');

    // dispose 解绑两个监听（subscription.remove 各一次）
    const receivedSub = (addNotificationReceivedListener as jest.Mock).mock
      .results[0]!.value;
    const responseSub = (addNotificationResponseReceivedListener as jest.Mock)
      .mock.results[0]!.value;
    handle.dispose();
    expect(receivedSub.remove).toHaveBeenCalledTimes(1);
    expect(responseSub.remove).toHaveBeenCalledTimes(1);
  });

  it('response 监听到达 → 归一 → app 内同步 + 白名单深链导航', async () => {
    const navigate = jest.fn();
    await initNotificationLayer({ navigate });
    const listener = (addNotificationResponseReceivedListener as jest.Mock).mock
      .calls[0]![0];
    listener(responseWithApproval);
    expect(navigate).toHaveBeenCalledWith('/approval/tc-9f3a');
    expect(notificationStore.getState().items[0]!.status).toBe('resolved');
  });

  it('冷启动：lastResponse 存在 → 补处理深链（D7 §7.3 / M8 §4.1.1 respond）', async () => {
    (getLastNotificationResponseAsync as jest.Mock).mockResolvedValue(
      responseWithApproval
    );
    const navigate = jest.fn();
    await initNotificationLayer({ navigate });
    expect(navigate).toHaveBeenCalledWith('/approval/tc-9f3a');
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('approval-requested:tc-9f3a');
  });

  it('冷启动 lastResponse 为 null / 原生面抛错 → 静默不阻塞', async () => {
    (getLastNotificationResponseAsync as jest.Mock).mockRejectedValue(
      new Error('not supported on web')
    );
    await expect(initNotificationLayer()).resolves.toBeDefined();
    expect(notificationStore.getState().items).toHaveLength(0);
  });
});
