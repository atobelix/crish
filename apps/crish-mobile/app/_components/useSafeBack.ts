// 安全返回：深链 / 推送冷启动时导航栈只有当前页，裸 router.back() 会静默失效。
//
// 二级页（session/run/approval/terminal/notifications/account/pair 等）的统一
// 返回入口。栈深度足够时正常回退（保留用户来路），否则 replace 到首页——
// 不能让用户困在页面里只能强杀应用。
import { useCallback } from 'react';
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

export default useSafeBack;
