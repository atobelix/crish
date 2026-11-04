import type { ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { isAppAuthenticated } from '@/domain/pure/authSelectors';

export interface RequireGuestProps {
  children: ReactNode;
}

/**
 * 访客逆向守卫：仅允许未认证用户访问。
 * 一旦用户已登录或已配对，严禁访问任何登录/设密页面，直接无条件弹回首页。
 * 彻底杜绝“返回键退到登录界面”的视觉倒退。
 */
export function RequireGuest({ children }: RequireGuestProps) {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);

  if (isAppAuthenticated(pairState, accountStatus)) {
    return <Redirect href="/" />;
  }

  return <>{children}</>;
}

export default RequireGuest;
