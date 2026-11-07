// 安全返回与 Android 返回键双击防抖退出守卫（实现波方案 01）
// 统一返回入口 + Android 物理返回键全局智能守卫。
// 2026-11-07 导航裁决（覆盖 2026-11-05 语义矩阵的返回条款与波 3
// 裁决 3／题 9）：对话界面（/session/*、/thread/*）的返回恒落主界面，
// 绝不落到上一个打开的对话——头栏钮（已删，见 SessionHeader）、系统
// 返回键与引擎内返回共用同一落点原语 navigateHome；「返回先回最近
// 会话」的会话访问栈整套退役。
import { useCallback, useEffect, useRef } from 'react';
import { BackHandler, Platform, ToastAndroid } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { isAppAuthenticated } from '@/domain/pure/authSelectors';
import {
  evaluateBackPressExit,
  isRouteCurrentRoot,
  isSessionSubRoute,
  INITIAL_BACK_PRESS_EXIT_STATE,
  type BackPressExitState,
} from '@/domain/pure/backPressExit';

/** 无返回栈时的兜底落点 */
export const SAFE_BACK_FALLBACK_HREF = '/' as const;
export const AUTH_BACK_FALLBACK_HREF = '/welcome' as const;

/**
 * 回主页落点原语（2026-11-07 裁决的单一收敛点）：栈内可回退（主页
 * 在栈中）走 dismissTo 弹栈回主页；深链冷启单屏栈（栈内无主页）才
 * navigate——无条件 navigate 会在多层栈下把主页压在旧会话屏之上、
 * 旧屏残留栈内，与 useNewConversation 的落点口径同一实现，全仓
 * 「回主页」导航只此一份。
 */
export function navigateHome(): void {
  if (router.canGoBack()) {
    router.dismissTo('/');
  } else {
    router.navigate('/');
  }
}

/**
 * 安全返回 Hook（UI 按钮消费点）：
 * - 对话界面（已登录）：恒回主界面（2026-11-07 裁决，见文件头）
 * - 有返回栈：正常 router.back()
 * - 无返回栈：根据登录态安全 replace 回根页面，杜绝静默失效
 */
export function useSafeBack(): () => void {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  const authenticated = isAppAuthenticated(pairState, accountStatus);
  const pathname = usePathname() ?? '';

  return useCallback(() => {
    if (authenticated && isSessionSubRoute(pathname)) {
      navigateHome();
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(
      authenticated ? SAFE_BACK_FALLBACK_HREF : AUTH_BACK_FALLBACK_HREF
    );
  }, [authenticated, pathname]);
}

/**
 * Android 物理返回键全局智能守卫（在根布局 _layout.tsx 挂载一次）：
 * 1. 根页面（未登录 /welcome 与已登录 /）：2000ms 双击退出到系统桌面（moveTaskToBack）；
 * 2. 对话界面（/session/*, /thread/*）：恒回主界面（2026-11-07 裁决），
 *    消费事件——绝不放行原生 pop 到上一个打开的对话；
 * 3. 普通子页面（/settings, /account/* 等）：正常 pop 回上一级；
 * 4. 严禁已登录状态退回任何 (auth) 栈。
 */
export function useAndroidBackGuard(): void {
  const pathname = usePathname();
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  const authenticated = isAppAuthenticated(pairState, accountStatus);

  const exitStateRef = useRef<BackPressExitState>(
    INITIAL_BACK_PRESS_EXIT_STATE
  );

  // 路由变化时重置退出计时状态，避免跨页面误触退出
  useEffect(() => {
    exitStateRef.current = INITIAL_BACK_PRESS_EXIT_STATE;
  }, [pathname]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        const currentPath = pathname ?? '';
        const isRoot = isRouteCurrentRoot(currentPath, authenticated);

        // 场景 A：当前处于根页面（未登录 /welcome 或已登录 /）
        if (isRoot) {
          const decision = evaluateBackPressExit(
            exitStateRef.current,
            Date.now()
          );
          exitStateRef.current = decision.nextState;

          if (decision.action === 'toast') {
            // 原生 Android Toast 具有最高可见度且不依赖复杂 UI 挂载
            ToastAndroid.show(decision.message, ToastAndroid.SHORT);
            return true; // 拦截事件，等待下一次点击
          }

          if (decision.action === 'exit') {
            // 连击生效：返回 false 放行给原生 MainActivity.invokeDefaultOnBackPressed
            // 该原生方法会调用 moveTaskToBack(false)，退至系统桌面且保留后台进程
            return false;
          }
        }

        // 场景 B（2026-11-07 裁决）：当前处于对话界面 → 恒回主界面，
        // 消费事件；栈内可回退与否都不落入场景 C 的原生 pop（pop 的
        // 落点是上一个打开的对话，正是裁决禁止的落点）
        if (authenticated && isSessionSubRoute(currentPath)) {
          navigateHome();
          return true; // 消费事件
        }

        // 场景 C：其他子页面且原生栈可正常回退
        if (router.canGoBack()) {
          // 放行给 React Navigation 正常退栈
          return false;
        }

        // 场景 D：冷启动深链单屏或异常脱水栈兜底
        router.replace(authenticated ? '/' : '/welcome');
        return true;
      }
    );

    return () => subscription.remove();
  }, [pathname, authenticated]);
}

export default useSafeBack;
