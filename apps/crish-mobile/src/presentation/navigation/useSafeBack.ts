// 安全返回与 Android 返回键双击防抖退出守卫（实现波方案 01）
// 统一返回入口 + Android 物理返回键全局智能守卫。
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
 * 安全返回 Hook（UI 按钮消费点）：
 * - 有返回栈：正常 router.back()
 * - 无返回栈：根据登录态安全 replace 回根页面，杜绝静默失效
 */
export function useSafeBack(): () => void {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  const authenticated = isAppAuthenticated(pairState, accountStatus);

  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(
      authenticated ? SAFE_BACK_FALLBACK_HREF : AUTH_BACK_FALLBACK_HREF
    );
  }, [authenticated]);
}

/**
 * Android 物理返回键全局智能守卫（在根布局 _layout.tsx 挂载一次）：
 * 1. 根页面（未登录 /welcome 与已登录 /）：2000ms 双击退出到系统桌面（moveTaskToBack）；
 * 2. 会话单页（/session/*, /thread/*）：若栈底为空，安全 replace 回主对话界面；
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

        // 场景 B：当前处于会话页，且不可常规回退（因为进入时使用了 replace）
        if (
          authenticated &&
          isSessionSubRoute(currentPath) &&
          !router.canGoBack()
        ) {
          router.replace('/');
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
