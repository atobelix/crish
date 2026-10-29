// 受保护路由：未配对统一重定向到欢迎页（账号 v3；扫码配对从欢迎页进入）。
import type { ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';

export function Protected({ children }: { children: ReactNode }) {
  const pairState = useAuthStore((s) => s.pairState);
  if (pairState !== 'paired') {
    return <Redirect href="/welcome" />;
  }
  return children;
}

export default Protected;
