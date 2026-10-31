// 安全返回（实现波总方案 E2）：深链 / 推送冷启动时导航栈只有当前页，
// 裸 router.back() 会静默失效；Android 深链单屏时物理返回键会直接退出应用。
// 统一返回入口 + Android 物理返回键全局兜底（R01 裁决项 3 方案 A）。
import { useCallback, useEffect } from 'react';
import { BackHandler } from 'react-native';
import { router } from 'expo-router';

/** 无返回栈时的兜底落点 */
export const SAFE_BACK_FALLBACK_HREF = '/' as const;

export function useSafeBack(): () => void {
  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(SAFE_BACK_FALLBACK_HREF);
  }, []);
}

/**
 * Android 物理返回键全局兜底（根布局挂载一次）：
 * 导航栈不可回退（深链冷启动单屏）时拦截系统默认退出，replace 回首页；
 * 栈内正常返回不受影响（交由 react-navigation 处理）。
 */
export function useAndroidBackGuard(): void {
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (router.canGoBack()) return false;
        router.replace(SAFE_BACK_FALLBACK_HREF);
        return true;
      }
    );
    return () => subscription.remove();
  }, []);
}

export default useSafeBack;
