// 系统通知面能力门面单测（P0-1 DEF-5）：动态加载 + 安全包装转发（可用环境）
// - jest.setup 的全局 mock 即「dev build 原生模块可用」形态：动态 import 解析为
//   mock 模块 → hasPushModule true → 包装函数转发到原生 API（断言调用面）；
// - 不可用降级路径在 degraded.test.ts（模块工厂抛错模拟 Expo Go 加载失败）。
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  getLastNotificationResponseAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  setNotificationChannelAsync,
  setNotificationHandler,
} from 'expo-notifications';
import {
  addNotificationReceivedListenerSafe,
  addNotificationResponseReceivedListenerSafe,
  getLastNotificationResponseAsyncSafe,
  getPermissionsAsyncSafe,
  hasPushModule,
  requestPermissionsAsyncSafe,
  resetPushModuleProbeForTest,
  scheduleNotificationAsyncSafe,
  setNotificationChannelAsyncSafe,
  setNotificationHandlerSafe,
} from './expoNotificationsFacade';

beforeEach(() => {
  jest.clearAllMocks();
  resetPushModuleProbeForTest();
});

describe('能力探测（动态 import 可用 → 系统通知面可用）', () => {
  it('hasPushModule → true（探测结果缓存，重复调用结论稳定）', async () => {
    await expect(hasPushModule()).resolves.toBe(true);
    await expect(hasPushModule()).resolves.toBe(true);
  });

  it('复位探测缓存后再次探测仍可用（重新走动态 import）', async () => {
    await expect(hasPushModule()).resolves.toBe(true);
    resetPushModuleProbeForTest();
    await expect(hasPushModule()).resolves.toBe(true);
  });
});

describe('安全包装转发（可用环境 → 原生 API 调用面）', () => {
  it('权限查询/请求转发到 getPermissionsAsync / requestPermissionsAsync', async () => {
    await getPermissionsAsyncSafe();
    expect(getPermissionsAsync).toHaveBeenCalledTimes(1);
    await requestPermissionsAsyncSafe();
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('渠道注册转发（实参原样透传）', async () => {
    const ok = await setNotificationChannelAsyncSafe('approval', {
      name: '审批',
      description: '审批请求/过期',
      importance: 7,
    });
    expect(ok).toBe(true);
    expect(setNotificationChannelAsync).toHaveBeenCalledWith('approval', {
      name: '审批',
      description: '审批请求/过期',
      importance: 7,
    });
  });

  it('前台 handler 安装转发', async () => {
    const ok = await setNotificationHandlerSafe({
      handleNotification: async () => ({}),
    });
    expect(ok).toBe(true);
    expect(setNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it('监听订阅返回退订函数（sub.remove 解绑）；null 守卫不炸', async () => {
    const disposeReceived = await addNotificationReceivedListenerSafe(
      jest.fn()
    );
    expect(disposeReceived).not.toBeNull();
    const receivedSub = (addNotificationReceivedListener as jest.Mock).mock
      .results[0]!.value;
    disposeReceived?.();
    expect(receivedSub.remove).toHaveBeenCalledTimes(1);

    const disposeResponse = await addNotificationResponseReceivedListenerSafe(
      jest.fn()
    );
    expect(disposeResponse).not.toBeNull();
    expect(addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
  });

  it('冷启动响应读取与后台呈现转发（返回原生结果）', async () => {
    const last = await getLastNotificationResponseAsyncSafe();
    expect(last).toBeNull();
    expect(getLastNotificationResponseAsync).toHaveBeenCalledTimes(1);

    const id = await scheduleNotificationAsyncSafe({
      content: { title: 't', body: null, data: {} },
      trigger: { channelId: 'general' },
    });
    expect(id).toBe('mock-notification-id');
    expect(scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: 't', body: null, data: {} },
      trigger: { channelId: 'general' },
    });
  });
});
