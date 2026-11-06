// 路由安全返回与 Android 物理返回键全局智能守卫测试（实现波方案 01）
import { router } from 'expo-router';
import { BackHandler, Platform, ToastAndroid } from 'react-native';
import {
  act,
  cleanup,
  renderHook,
  waitFor,
} from '@testing-library/react-native';
import {
  useSafeBack,
  useAndroidBackGuard,
  useSessionVisitRecorder,
  useSessionVisitStackAccountReset,
  resetSessionVisitStack,
  SAFE_BACK_FALLBACK_HREF,
  AUTH_BACK_FALLBACK_HREF,
} from '@/presentation/navigation/useSafeBack';
import { authStore } from '@/domain/store/authStore';
import { accountStore } from '@/domain/store/accountStore';

(Platform as { OS: string }).OS = 'android';

let mockCurrentPathname = '/';

jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
    canGoBack: jest.fn(),
  },
  usePathname: () => mockCurrentPathname,
}));

const backMock = router.back as jest.Mock;
const replaceMock = router.replace as jest.Mock;
const navigateMock = router.navigate as jest.Mock;
const canGoBackMock = router.canGoBack as jest.Mock;

let registeredBackHandler:
  Parameters<typeof BackHandler.addEventListener>[1] | null = null;
let toastSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as { OS: string }).OS = 'android';
  mockCurrentPathname = '/';
  resetSessionVisitStack();
  authStore.setState({ pairState: 'unpaired' });
  accountStore.setState({ status: 'loggedOut', user: null });
  registeredBackHandler = null;

  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((event, handler) => {
      if (event === 'hardwareBackPress') {
        registeredBackHandler = handler;
      }
      return {
        remove: jest.fn(() => {
          if (registeredBackHandler === handler) {
            registeredBackHandler = null;
          }
        }),
      };
    });

  toastSpy = jest.spyOn(ToastAndroid, 'show').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

async function renderGuard(): Promise<void> {
  await renderHook(() => useAndroidBackGuard());
  await waitFor(() => {
    expect(registeredBackHandler).not.toBeNull();
  });
}

function triggerHardwareBack(): boolean {
  if (!registeredBackHandler) {
    throw new Error('未注册 hardwareBackPress 监听器');
  }
  return Boolean(registeredBackHandler({} as never));
}

describe('useSafeBack', () => {
  it('栈深度足够时正常回退（保留用户来路）', async () => {
    canGoBackMock.mockReturnValue(true);
    const { result } = await renderHook(() => useSafeBack());

    await act(async () => {
      result.current();
    });

    expect(backMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('已登录且栈深度为 1 时回落到首页 "/"', async () => {
    accountStore.setState({ status: 'loggedIn' });
    canGoBackMock.mockReturnValue(false);
    const { result } = await renderHook(() => useSafeBack());

    await act(async () => {
      result.current();
    });

    expect(backMock).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledWith(SAFE_BACK_FALLBACK_HREF);
  });

  it('未登录且栈深度为 1 时回落到欢迎页 "/welcome"', async () => {
    canGoBackMock.mockReturnValue(false);
    const { result } = await renderHook(() => useSafeBack());

    await act(async () => {
      result.current();
    });

    expect(backMock).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledWith(AUTH_BACK_FALLBACK_HREF);
  });

  it('兜底落点常量符合规范', () => {
    expect(SAFE_BACK_FALLBACK_HREF).toBe('/');
    expect(AUTH_BACK_FALLBACK_HREF).toBe('/welcome');
  });

  it('多次触发行为一致（幂等，无隐藏状态）', async () => {
    accountStore.setState({ status: 'loggedIn' });
    canGoBackMock.mockReturnValue(false);
    const { result } = await renderHook(() => useSafeBack());

    await act(async () => {
      result.current();
      result.current();
    });

    expect(replaceMock).toHaveBeenCalledTimes(2);
    expect(replaceMock).toHaveBeenNthCalledWith(1, SAFE_BACK_FALLBACK_HREF);
    expect(replaceMock).toHaveBeenNthCalledWith(2, SAFE_BACK_FALLBACK_HREF);
  });
});

describe('useAndroidBackGuard', () => {
  describe('根页面双击退出防抖（2000ms 黄金窗口）', () => {
    it('已登录态下在 "/"：首次返回键拦截并提示 Toast，2000ms 内再次按下放行给原生退出', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/';

      await renderGuard();

      const dateSpy = jest.spyOn(Date, 'now');
      dateSpy.mockReturnValue(10000);

      // 第 1 次按下：拦截，提示 Toast
      const handled1 = triggerHardwareBack();
      expect(handled1).toBe(true);
      expect(toastSpy).toHaveBeenCalledTimes(1);
      expect(toastSpy).toHaveBeenCalledWith(
        '再按一次退出应用',
        ToastAndroid.SHORT
      );

      // 1200ms 后连击：放行（return false），让原生 MainActivity moveTaskToBack
      dateSpy.mockReturnValue(11200);
      const handled2 = triggerHardwareBack();
      expect(handled2).toBe(false);
      expect(toastSpy).toHaveBeenCalledTimes(1); // 不会重复弹 Toast
      dateSpy.mockRestore();
    });

    it('未登录态下在 "/welcome"：同样具备 2000ms 双击退出能力', async () => {
      mockCurrentPathname = '/welcome';

      await renderGuard();

      const dateSpy = jest.spyOn(Date, 'now');
      dateSpy.mockReturnValue(20000);

      // 第 1 次按下：拦截
      const handled1 = triggerHardwareBack();
      expect(handled1).toBe(true);
      expect(toastSpy).toHaveBeenCalledWith(
        '再按一次退出应用',
        ToastAndroid.SHORT
      );

      // 1500ms 后连击：放行
      dateSpy.mockReturnValue(21500);
      const handled2 = triggerHardwareBack();
      expect(handled2).toBe(false);
      dateSpy.mockRestore();
    });

    it('超过 2000ms 后的连击应重新提示 Toast，不触发退出', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/';

      await renderGuard();

      const dateSpy = jest.spyOn(Date, 'now');
      dateSpy.mockReturnValue(30000);

      // 第 1 次按下
      const handled1 = triggerHardwareBack();
      expect(handled1).toBe(true);
      expect(toastSpy).toHaveBeenCalledTimes(1);

      // 2500ms 后（超时）：再次拦截并重新提示 Toast
      dateSpy.mockReturnValue(32500);
      const handled2 = triggerHardwareBack();
      expect(handled2).toBe(true);
      expect(toastSpy).toHaveBeenCalledTimes(2);
      dateSpy.mockRestore();
    });
  });

  describe('会话子页面与普通页面导航链路', () => {
    it('会话详情页单屏（不可常规回退）按返回键 replace 回主页 "/"', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/session/test-session-1';
      canGoBackMock.mockReturnValue(false);

      await renderGuard();

      const handled = triggerHardwareBack();
      expect(handled).toBe(true);
      expect(replaceMock).toHaveBeenCalledWith('/');
    });

    it('普通子页面有历史栈时返回 false，放行给 React Navigation 正常退栈', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/settings';
      canGoBackMock.mockReturnValue(true);

      await renderGuard();

      const handled = triggerHardwareBack();
      expect(handled).toBe(false);
      expect(replaceMock).not.toHaveBeenCalled();
    });

    it('普通子页面无历史栈时按认证态安全 replace 回根页面', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/settings';
      canGoBackMock.mockReturnValue(false);

      await renderGuard();

      const handled = triggerHardwareBack();
      expect(handled).toBe(true);
      expect(replaceMock).toHaveBeenCalledWith('/');
    });
  });

  describe('路由变化重置退出计时状态', () => {
    it('离开根页面再返回后，不会因先前的点击而直接退出', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/';

      const { rerender } = await renderHook(() => useAndroidBackGuard());
      await waitFor(() => {
        expect(registeredBackHandler).not.toBeNull();
      });

      const dateSpy = jest.spyOn(Date, 'now');
      dateSpy.mockReturnValue(50000);

      // 在首页点击一次
      const handled1 = triggerHardwareBack();
      expect(handled1).toBe(true);

      // 页面切换到 /settings
      mockCurrentPathname = '/settings';
      await rerender({});
      await waitFor(() => {
        expect(registeredBackHandler).not.toBeNull();
      });

      // 页面切换回 /
      mockCurrentPathname = '/';
      await rerender({});
      await waitFor(() => {
        expect(registeredBackHandler).not.toBeNull();
      });

      // 在 500ms 内再次点击：由于路由切换过，重置为初次点击，提示 Toast 而非退出
      dateSpy.mockReturnValue(50500);
      const handled2 = triggerHardwareBack();
      expect(handled2).toBe(true);
      expect(toastSpy).toHaveBeenCalledTimes(2);
      dateSpy.mockRestore();
    });
  });
});

describe('会话访问栈（题 9：A→抽屉→B→返回先回 A，耗尽才回主页）', () => {
  /** 记录器 + 安全返回同挂（根布局 / 会话头栏的真实组合） */
  async function renderRecorderWithSafeBack() {
    const harness = await renderHook(() => {
      useSessionVisitRecorder();
      return useSafeBack();
    });
    return harness;
  }

  async function gotoPath(
    rerender: (props: never) => Promise<void> | void,
    path: string
  ): Promise<void> {
    mockCurrentPathname = path;
    await act(async () => {
      await rerender({} as never);
    });
  }

  it('头栏返回：B 返回先回 A；落地不反压 B（防弹跳）；栈空后回落主页兜底', async () => {
    accountStore.setState({ status: 'loggedIn' });
    canGoBackMock.mockReturnValue(false);

    const { result, rerender } = await renderRecorderWithSafeBack();

    // 主页 → 会话 A（不记录）→ 抽屉切会话 B（记录被替换者 A）
    await gotoPath(rerender, '/session/a');
    await gotoPath(rerender, '/session/b');

    // 在 B 按返回：先回最近会话 A，不走 router.back / replace 兜底
    await act(async () => {
      result.current();
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/session/a');
    expect(backMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();

    // 落地 A（经访问栈返回）：这次落地不得把 B 再压栈
    await gotoPath(rerender, '/session/a');

    // 在 A 再按返回：栈已耗尽 → 既有兜底 replace 主页（若落地误压 B，
    // 这里会错误地 navigate 去 B，断言即失败）
    await act(async () => {
      result.current();
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith(SAFE_BACK_FALLBACK_HREF);
  });

  it('头栏返回：A→B→C 逆序回退（先 B 后 A）', async () => {
    accountStore.setState({ status: 'loggedIn' });
    canGoBackMock.mockReturnValue(false);

    const { result, rerender } = await renderRecorderWithSafeBack();
    await gotoPath(rerender, '/session/a');
    await gotoPath(rerender, '/thread/b');
    await gotoPath(rerender, '/session/c');

    await act(async () => {
      result.current();
    });
    expect(navigateMock).toHaveBeenNthCalledWith(1, '/thread/b');

    await gotoPath(rerender, '/thread/b');
    await act(async () => {
      result.current();
    });
    expect(navigateMock).toHaveBeenNthCalledWith(2, '/session/a');
  });

  it('Android 返回键：会话页有访问记录时先回最近会话并消费事件；耗尽后走既有兜底', async () => {
    accountStore.setState({ status: 'loggedIn' });
    canGoBackMock.mockReturnValue(false);

    const harness = await renderHook(() => {
      useSessionVisitRecorder();
      useAndroidBackGuard();
    });
    await waitFor(() => {
      expect(registeredBackHandler).not.toBeNull();
    });

    await gotoPath(harness.rerender, '/session/a');
    await gotoPath(harness.rerender, '/session/b');
    await waitFor(() => {
      expect(registeredBackHandler).not.toBeNull();
    });

    // 在 B 按物理返回键：消费事件并回 A
    const handled1 = triggerHardwareBack();
    expect(handled1).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith('/session/a');
    expect(replaceMock).not.toHaveBeenCalled();

    // 落地 A 后再按：栈已耗尽 → 既有场景 B 兜底 replace 主页
    await gotoPath(harness.rerender, '/session/a');
    const handled2 = triggerHardwareBack();
    expect(handled2).toBe(true);
    expect(replaceMock).toHaveBeenCalledWith('/');
  });

  it('无访问记录的会话页返回行为与既有口径一致（不被空栈改变）', async () => {
    accountStore.setState({ status: 'loggedIn' });
    canGoBackMock.mockReturnValue(true);
    mockCurrentPathname = '/session/only';

    const { result } = await renderHook(() => useSafeBack());
    await act(async () => {
      result.current();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(backMock).toHaveBeenCalledTimes(1);
  });
});

describe('会话访问栈账号生命周期复位（收口裁定：登出/换号清栈）', () => {
  /** 记录器 + 账号复位 + 安全返回同挂（根布局 / 会话头栏的真实组合） */
  async function renderFullHarness() {
    return renderHook(() => {
      useSessionVisitRecorder();
      useSessionVisitStackAccountReset();
      return useSafeBack();
    });
  }

  async function gotoPath(
    rerender: (props: never) => Promise<void> | void,
    path: string
  ): Promise<void> {
    mockCurrentPathname = path;
    await act(async () => {
      await rerender({} as never);
    });
  }

  it('登出后清栈：会话页返回不再回旧账号的最近会话，落未登录兜底', async () => {
    accountStore.setState({
      status: 'loggedIn',
      user: { id: 'u-1', email: 'a@example.com', name: 'A' },
    });
    canGoBackMock.mockReturnValue(false);

    const { result, rerender } = await renderFullHarness();
    await gotoPath(rerender, '/session/a');
    await gotoPath(rerender, '/session/b');

    // 登出的终局形态（logoutAccount / 删号 / 会话失效同落点）
    await act(async () => {
      accountStore.setState({ status: 'loggedOut', user: null });
    });

    await act(async () => {
      result.current();
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledWith(AUTH_BACK_FALLBACK_HREF);
  });

  it('换号（user.id 变化、仍为登录态）同样清栈', async () => {
    accountStore.setState({
      status: 'loggedIn',
      user: { id: 'u-1', email: 'a@example.com', name: 'A' },
    });
    canGoBackMock.mockReturnValue(false);

    const { result, rerender } = await renderFullHarness();
    await gotoPath(rerender, '/session/a');
    await gotoPath(rerender, '/session/b');

    await act(async () => {
      accountStore.setState({
        user: { id: 'u-2', email: 'b@example.com', name: 'B' },
      });
    });

    await act(async () => {
      result.current();
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledWith(SAFE_BACK_FALLBACK_HREF);
  });

  it('同账号资料变化（同 id 改名）不清栈：返回仍先回最近会话', async () => {
    accountStore.setState({
      status: 'loggedIn',
      user: { id: 'u-1', email: 'a@example.com', name: 'A' },
    });
    canGoBackMock.mockReturnValue(false);

    const { result, rerender } = await renderFullHarness();
    await gotoPath(rerender, '/session/a');
    await gotoPath(rerender, '/session/b');

    await act(async () => {
      accountStore.setState({
        user: { id: 'u-1', email: 'a@example.com', name: 'A 改名' },
      });
    });

    await act(async () => {
      result.current();
    });
    expect(navigateMock).toHaveBeenCalledWith('/session/a');
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
