import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { ensurePairingWiringForApp } from '@/presentation/pair/pairingBootstrap';

// 配对流程 Stack（M5 §2.1）：welcome（首次引导）→ manual（手动输入）/ scan（扫码，P2）
// - 接线装配点（R2-03 部分 3）：挂载时确保配对接线单例 + 冷启动恢复水合
//   （pairingWiring.hydrate：已配对 → 恢复 paired → (tabs) 守卫自动放行；
//   未配对 → 配对引导）；恢复期间 splash 防 welcome 闪跳（D4 §5.0 SplashGate）；
// - 已配对时回到主界面（配对流程仅未配对可访问）。
export default function PairLayout() {
  const pairState = useAuthStore((s) => s.pairState);
  const [restoring, setRestoring] = useState(true);

  // 冷启动恢复：装配配对接线（幂等单例）+ 水合（读 secure-store 恢复配对态）
  useEffect(() => {
    let mounted = true;
    void ensurePairingWiringForApp()
      .catch(() => {
        // 水合失败不阻塞配对引导（authStore 保持未配对，可重新配对）
      })
      .finally(() => {
        if (mounted) setRestoring(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (restoring) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator />
      </View>
    );
  }

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

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
