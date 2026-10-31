// 受保护路由守卫（实现波总方案 E1）：认证判定统一走 authSelectors SSOT。
// 放行口径 = 局域网配对 **或** 账号登录（双轨并存）；纯账号中继模式下二级页
// （run/terminal/approval/approval-history/notifications）正常直达，不再弹回。
import type { ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { shouldAllowProtectedRoute } from '@/domain/pure/authSelectors';

export function Protected({ children }: { children: ReactNode }) {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  if (!shouldAllowProtectedRoute(pairState, accountStatus)) {
    return <Redirect href="/welcome" />;
  }
  return children;
}

export default Protected;
