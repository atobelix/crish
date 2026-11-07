// 路由安全返回与 Android 物理返回键全局智能守卫测试（实现波方案 01）
// 2026-11-07 裁决：对话界面返回恒回主页——头栏消费面（useSafeBack）与
// 系统返回守卫共用落点原语 navigateHome（dismissTo / navigate），
// 永不 router.back 到上一个对话；题 9 会话访问栈已整套退役。
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
    dismissTo: jest.fn(),
    canGoBack: jest.fn(),
  },
  usePathname: () => mockCurrentPathname,
}));

const backMock = router.back as jest.Mock;
const replaceMock = router.replace as jest.Mock;
const navigateMock = router.navigate as jest.Mock;
const dismissToMock = router.dismissTo as jest.Mock;
const canGoBackMock = router.canGoBack as jest.Mock;

let registeredBackHandler:
  Parameters<typeof BackHandler.addEventListener>[1] | null = null;
let toastSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as { OS: string }).OS = 'android';
  mockCurrentPathname = '/';
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

describe('useSafeBack 对话界面（2026-11-07 裁决：返回恒回主页）', () => {
  it('会话页深栈（主页→A→B）：dismissTo 直落主页，永不回上一个对话', async () => {
    accountStore.setState({ status: 'loggedIn' });
    mockCurrentPathname = '/session/b';
    canGoBackMock.mockReturnValue(true);
    const { result } = await renderHook(() => useSafeBack());

    await act(async () => {
      result.current();
    });

    expect(dismissToMock).toHaveBeenCalledTimes(1);
    expect(dismissToMock).toHaveBeenCalledWith('/');
    expect(backMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('本地线程页同口径：dismissTo 直落主页', async () => {
    accountStore.setState({ status: 'loggedIn' });
    mockCurrentPathname = '/thread/b';
    canGoBackMock.mockReturnValue(true);
    const { result } = await renderHook(() => useSafeBack());

    await act(async () => {
      result.current();
    });

    expect(dismissToMock).toHaveBeenCalledWith('/');
    expect(backMock).not.toHaveBeenCalled();
  });

  it('会话页单屏栈（深链冷启、栈内无主页）：navigate 回主页', async () => {
    accountStore.setState({ status: 'loggedIn' });
    mockCurrentPathname = '/session/only';
    canGoBackMock.mockReturnValue(false);
    const { result } = await renderHook(() => useSafeBack());

    await act(async () => {
      result.current();
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/');
    expect(backMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('未登录态落在会话路由（异常态）：不走回主页原语，落未登录兜底', async () => {
    mockCurrentPathname = '/session/x';
    canGoBackMock.mockReturnValue(false);
    const { result } = await renderHook(() => useSafeBack());

    await act(async () => {
      result.current();
    });

    expect(dismissToMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledWith(AUTH_BACK_FALLBACK_HREF);
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
    it('会话详情页深栈（可常规回退）按返回键：dismissTo 直落主页并消费事件，绝不放行原生 pop', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/session/test-session-1';
      canGoBackMock.mockReturnValue(true);

      await renderGuard();

      const handled = triggerHardwareBack();
      expect(handled).toBe(true);
      expect(dismissToMock).toHaveBeenCalledTimes(1);
      expect(dismissToMock).toHaveBeenCalledWith('/');
      expect(replaceMock).not.toHaveBeenCalled();
    });

    it('本地线程页深栈按返回键同口径：dismissTo 直落主页并消费事件', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/thread/test-thread-1';
      canGoBackMock.mockReturnValue(true);

      await renderGuard();

      const handled = triggerHardwareBack();
      expect(handled).toBe(true);
      expect(dismissToMock).toHaveBeenCalledWith('/');
    });

    it('会话详情页单屏（不可常规回退）按返回键 navigate 回主页 "/" 并消费事件', async () => {
      accountStore.setState({ status: 'loggedIn' });
      mockCurrentPathname = '/session/test-session-1';
      canGoBackMock.mockReturnValue(false);

      await renderGuard();

      const handled = triggerHardwareBack();
      expect(handled).toBe(true);
      expect(navigateMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith('/');
      expect(replaceMock).not.toHaveBeenCalled();
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
