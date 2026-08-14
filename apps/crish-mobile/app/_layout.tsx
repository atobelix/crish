import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { authStore } from '@/domain/store/authStore';
import { ensureDatabaseForApp } from '@/db/dbBootstrap';
import {
  ensureNotificationsForApp,
  type NotificationLayerHandle,
} from '@/notifications/notificationBootstrap';

// 根布局（M5 §2.1 app/_layout.tsx）：SplashGate + Stack
// 路由守卫（D4 §5.0）落在 (tabs)/_layout（未配对 → 配对流程）与
// ProtectedPlaceholder（深链详情页）；通知层装配（R3-04 部分 4）随 SplashGate
// 之后执行（见下方装配 effect）；DB 启动装配（R2-13 部分 2）由 ensureDatabaseForApp
// 接入（src/db/dbBootstrap）
export default function RootLayout() {
  const hydrated = useAuthStore((s) => s.hydrated);

  // 启动水合：骨架期 hydrate 为同步置位；R2-03 在此接 secure-store + kv-store 读取
  useEffect(() => {
    void authStore.getState().hydrate();
  }, []);

  // DB 启动装配（R2-13 部分 2）：openDatabaseAsync → migrateIfNeeded →
  // configureSqlitePersistence → settings/notification hydrate；不阻塞首屏
  // （SplashGate 只等 auth hydrate；DB 失败降级内存态 + 日志注记，见 dbBootstrap）
  useEffect(() => {
    void ensureDatabaseForApp();
  }, []);

  // 通知层装配（R3-04 部分 4）：SplashGate（auth hydrate）之后执行——
  // 路由树就绪，冷启动深链导航（getLastNotificationResponseAsync → navigate →
  // router.push）安全；深链导航注入 = router.push 包装（notificationRouteToPath
  // 已翻译为 expo-router 路径，deepLink.ts / M4 §4.3 白名单）；
  // - 配对状态不 gate：桌面只在配对后推送（D7 §6.4「未配对不推」是发送面语义），
  //   监听注册无害；推送到达按 authStore 状态处理（PushWiring 离开 paired 清
  //   去重表，pushConsumer attach）；权限引导由 UI 层配对后触发（D7 §7.5）；
  // - Expo Go 降级（P0-1 DEF-5）：系统通知面不可用 → 应用内通知 only，
  //   不抛错不阻塞启动（notificationBootstrap catch + warn 兜底）；
  // - 卸载/热重载：dispose 解绑监听，重装配幂等。
  const notificationLayerRef = useRef<NotificationLayerHandle | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void ensureNotificationsForApp({
      navigate: (path) => router.push(path),
    })
      .then((handle) => {
        if (cancelled) {
          handle.dispose();
        } else {
          notificationLayerRef.current = handle;
        }
      })
      .catch((err: unknown) => {
        // 兜底防线：ensureNotificationsForApp 内部已降级不抛（DEF-5 契约），
        // 此处再防未来回归——装配异常不阻塞启动，仅日志注记
        console.warn(
          `[notifications] 通知层装配异常（不阻塞启动）：${err instanceof Error ? err.message : String(err)}`
        );
      });
    return () => {
      cancelled = true;
      notificationLayerRef.current?.dispose();
      notificationLayerRef.current = null;
    };
  }, [hydrated]);

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
