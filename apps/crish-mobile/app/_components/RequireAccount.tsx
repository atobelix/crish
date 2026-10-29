// 账号页守卫：没有账号用户时回到欢迎页。
// 以 user 而非 status 判断：修改密码会经过验证码确认，期间 status 会短暂变为 loggingIn / error，
// 不能因此把账号页踢回欢迎页。
import type { ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';

export function RequireAccount({ children }: { children: ReactNode }) {
  const user = useAccountStore((s) => s.user);
  if (user === null) return <Redirect href="/welcome" />;
  return children;
}

export default RequireAccount;
