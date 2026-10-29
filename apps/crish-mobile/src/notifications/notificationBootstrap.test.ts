// 通知层启动装配测试（R3-04 部分 4）：
// - 装配顺序：偏好接线（connectNotificationPrefs）先于 initNotificationLayer；
// - 选项透传：navigate 深链导航注入直达 initNotificationLayer；
// - 失败降级：initNotificationLayer 抛错 → 降级句柄 + warn 注记，绝不抛给启动链
//   （装配后 app 仍可启动的契约，对齐 dbBootstrap 降级风格）。
import { ensureNotificationsForApp } from './notificationBootstrap';
import { connectNotificationPrefs } from './prefsBinding';
import { initNotificationLayer } from './index';

jest.mock('./prefsBinding', () => ({
  connectNotificationPrefs: jest.fn(),
}));

jest.mock('./index', () => ({
  initNotificationLayer: jest.fn(),
}));

const connectMock = jest.mocked(connectNotificationPrefs);
const initMock = jest.mocked(initNotificationLayer);

beforeEach(() => {
  jest.clearAllMocks();
  initMock.mockResolvedValue({
    permissionStatus: 'undetermined',
    dispose: jest.fn(),
  });
});

describe('ensureNotificationsForApp（通知层启动装配）', () => {
  it('装配顺序：connectNotificationPrefs 先于 initNotificationLayer（invocationCallOrder）', async () => {
    const handle = await ensureNotificationsForApp({ navigate: jest.fn() });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledTimes(1);
    // 顺序断言：偏好接线（部分 3 入口）在通知层初始化之前完成
    expect(connectMock.mock.invocationCallOrder[0]!).toBeLessThan(
      initMock.mock.invocationCallOrder[0]!
    );
    expect(handle.permissionStatus).toBe('undetermined');
  });

  it('navigate 深链导航注入透传 initNotificationLayer', async () => {
    const navigate = jest.fn();
    await ensureNotificationsForApp({ navigate });

    expect(initMock).toHaveBeenCalledWith({ navigate });
  });

  it('缺省选项：不传 navigate 也可装配（仅已读不导航语义）', async () => {
    await expect(ensureNotificationsForApp()).resolves.toBeDefined();
    expect(initMock).toHaveBeenCalledWith({});
  });

  it('initNotificationLayer 抛错 → 降级句柄 + warn 注记，不抛给启动链', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    initMock.mockRejectedValue(new Error('boom'));

    const handle = await ensureNotificationsForApp();

    // 装配后 app 仍可启动：降级句柄（无操作 dispose）+ 诚实化日志注记
    expect(handle.permissionStatus).toBe('undetermined');
    expect(() => handle.dispose()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('通知层装配失败')
    );
    warn.mockRestore();
  });

  it('重复调用幂等（偏好接线可重复绑定；init 每次重建监听）', async () => {
    await ensureNotificationsForApp();
    await ensureNotificationsForApp();

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(initMock).toHaveBeenCalledTimes(2);
  });
});
