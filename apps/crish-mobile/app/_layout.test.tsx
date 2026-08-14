// 根布局装配测试（R3-04 部分 4）：通知层装配调用点
// - 装配时机：SplashGate（auth hydrate）之后才装配（路由树就绪，深链导航安全）；
//   DB 装配挂载即执行（fire-and-forget 不 gate）——装配顺序：DB → 水合 → 通知层；
// - 配对状态不 gate：未配对（unpaired）水合后照常装配（D7 §6.4 未配对不推是
//   发送面语义，监听注册无害；PushWiring 离开 paired 清去重表）；
// - 导航注入：装配传入的 navigate 经 router.push 转发（深链白名单路径）；
// - 卸载 → dispose 解绑；装配异常 → warn 注记，启动继续不崩。
import { act, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import {
  authStore,
  configureAuthPersistence,
  type AuthPersist,
} from '@/domain/store/authStore';
import { ensureDatabaseForApp } from '@/db/dbBootstrap';
import { ensureNotificationsForApp } from '@/notifications/notificationBootstrap';
import RootLayout from './_layout';

jest.mock('expo-router', () => ({
  Stack: () => null,
  router: { push: jest.fn() },
}));

jest.mock('expo-status-bar', () => ({
  StatusBar: () => null,
}));

jest.mock('@/db/dbBootstrap', () => ({
  ensureDatabaseForApp: jest.fn(async () => ({ ok: true, version: 1 })),
}));

jest.mock('@/notifications/notificationBootstrap', () => ({
  ensureNotificationsForApp: jest.fn(async () => ({
    permissionStatus: 'undetermined',
    dispose: jest.fn(),
  })),
}));

const pushMock = router.push as jest.Mock;
const dbMock = jest.mocked(ensureDatabaseForApp);
const notifMock = jest.mocked(ensureNotificationsForApp);

/** 挂起的水合持久化：load 永不 resolve——SplashGate 期（hydrated=false）可控，
 *  通知层装配时机由测试显式 setHydrated 推进（真实启动 = secure-store 读取完成） */
const pendingAuthPersist: AuthPersist = {
  load: () => new Promise(() => {}),
  save: async () => {},
  clear: async () => {},
};

/** 置水合标志（act 包裹；hydrated=true 触发 SplashGate 通过 → 通知层装配 effect） */
async function setHydrated(value: boolean): Promise<void> {
  await act(async () => {
    authStore.setState({ hydrated: value });
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  authStore.getState().revokeLocal();
  configureAuthPersistence(pendingAuthPersist);
  authStore.setState({ hydrated: false });
});

afterEach(() => {
  configureAuthPersistence(null);
});

describe('根布局通知层装配（R3-04 部分 4）', () => {
  it('装配顺序：DB 挂载即装配（不 gate）；通知层在 SplashGate（水合）之后装配', async () => {
    await render(<RootLayout />);

    // 挂载即装配：DB bootstrap fire-and-forget（dbBootstrap 语义，不 gate）
    expect(dbMock).toHaveBeenCalledTimes(1);
    // 通知层 gate 在 SplashGate 之后（路由树就绪才可导航）
    expect(notifMock).not.toHaveBeenCalled();

    await setHydrated(true);
    expect(notifMock).toHaveBeenCalledTimes(1);
  });

  it('配对状态不 gate：未配对（unpaired）水合后照常装配通知层', async () => {
    expect(authStore.getState().pairState).toBe('unpaired');
    await render(<RootLayout />);
    await setHydrated(true);

    expect(notifMock).toHaveBeenCalledTimes(1);
  });

  it('装配注入 navigate → router.push（冷启动深链导航接线）', async () => {
    await render(<RootLayout />);
    await setHydrated(true);

    const opts = notifMock.mock.calls[0]?.[0] as {
      navigate: (path: string) => void;
    };
    expect(typeof opts.navigate).toBe('function');
    await act(async () => {
      opts.navigate('/approval/tc-9f3a');
    });
    expect(pushMock).toHaveBeenCalledWith('/approval/tc-9f3a');
  });

  it('卸载 → dispose 解绑通知层监听（退场即退订）', async () => {
    const dispose = jest.fn();
    notifMock.mockResolvedValueOnce({
      permissionStatus: 'undetermined',
      dispose,
    });
    const view = await render(<RootLayout />);
    await setHydrated(true);
    // 等装配 promise resolve 到组件（微任务 flush）
    await act(async () => {});

    await view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('装配异常 → warn 注记，启动继续不崩（不阻塞渲染）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    notifMock.mockRejectedValueOnce(new Error('boom'));
    await render(<RootLayout />);

    await setHydrated(true);
    // 等装配 promise 的 catch 注记执行（微任务 flush）
    await act(async () => {});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('通知层装配异常')
    );
    // 启动继续：后续水合/渲染不受影响（再次水合触发重装配仍可用）
    notifMock.mockResolvedValueOnce({
      permissionStatus: 'undetermined',
      dispose: jest.fn(),
    });
    await setHydrated(false);
    await setHydrated(true);
    expect(notifMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
