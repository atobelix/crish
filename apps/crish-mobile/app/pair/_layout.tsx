// 配对流程 Stack：已配对 → 主界面；未配对 → 欢迎 / 手动 / 扫码。
// 启动水合由根布局统一负责（SplashGate），本层不再重复装配。
import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';

export default function PairLayout() {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);

  if (pairState === 'paired' || accountStatus === 'loggedIn') {
    return <Redirect href="/" />;
  }

  return (
    <Stack
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <Stack.Screen name="welcome" />
      <Stack.Screen name="manual" />
      <Stack.Screen name="scan" />
    </Stack>
  );
}
