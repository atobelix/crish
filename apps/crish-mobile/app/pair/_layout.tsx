import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';

// 配对流程 Stack（M5 §2.1）：welcome（首次引导）→ manual（手动输入）/ scan（扫码，P2）
// 已配对时回到主界面（配对流程仅未配对可访问）
export default function PairLayout() {
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState === 'paired') {
    return <Redirect href="/(tabs)" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="manual" />
      <Stack.Screen name="scan" />
    </Stack>
  );
}
