// 配对流程 Stack（实现波总方案 E3）：
// - 已配对 → 主界面（配对态即认证态，无需重复扫码）；
// - 账号登录用户仍可进入 scan / manual 扫码直连新桌面（双轨并存，不整栈拦截）；
// - 僵尸引导页 pair/welcome 已删除（根 /welcome 承担引导职责）。
import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';

export default function PairLayout() {
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState === 'paired') {
    return <Redirect href="/" />;
  }

  return (
    <Stack
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <Stack.Screen name="manual" />
      <Stack.Screen name="scan" />
    </Stack>
  );
}
