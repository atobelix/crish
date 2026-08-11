import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { authStore } from '@/domain/store/authStore';

// 根布局（M5 §2.1 app/_layout.tsx）：SplashGate + Stack
// 路由守卫（D4 §5.0）落在 (tabs)/_layout（未配对 → 配对流程）与
// ProtectedPlaceholder（深链详情页）；SQLiteProvider / NotificationObserver
// 分别随 R2-13 / R3-04 接入
export default function RootLayout() {
  const hydrated = useAuthStore((s) => s.hydrated);

  // 启动水合：骨架期 hydrate 为同步置位；R2-03 在此接 secure-store + kv-store 读取
  useEffect(() => {
    void authStore.getState().hydrate();
  }, []);

  // SplashGate：令牌未读出前不挂导航树，防配对页闪跳（D4 §5.0）
  if (!hydrated) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
