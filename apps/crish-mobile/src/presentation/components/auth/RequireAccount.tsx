// 账号页守卫（实现波总方案 E1）：以 user 判断——修改密码流程中 status 会短暂
// 离开 loggedIn（验证码确认），不能因此把账号页踢回欢迎页。
import type { ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';

export function RequireAccount({ children }: { children: ReactNode }) {
  const user = useAccountStore((s) => s.user);
  if (user === null) return <Redirect href="/welcome" />;
  return children;
}

export default RequireAccount;
