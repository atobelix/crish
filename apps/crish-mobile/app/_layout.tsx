// 根布局：安全区 / 主题 / Toast / 启动装配 / 认证水合闸门（纯本地）/ 导航栈 / 全局审批悬浮卡。
// 启动时序（实现波总方案 维 A）：本地水合 ≤50ms 即放行首屏；远程校正、DB 装配、
// 通知层全部后台并行，不经闸门。原生 Splash 由 preventAutoHideAsync 保持到首帧渲染，
// 无 JS 自绘中间帧（无 BrandMark、无 Spinner）。
import { useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { authStore } from '@/domain/store/authStore';
import { useTheme } from '@/adapters/platform/theme';
import { ensureDatabaseForApp } from '@/db/dbBootstrap';
import { startAppRuntime } from '@/adapters/runtime/appRuntime';
import { ensurePairingWiringForApp } from '@/adapters/pairing/pairingController';
import {
  ensureNotificationsForApp,
  type NotificationLayerHandle,
} from '@/notifications/notificationBootstrap';
import { ErrorBoundary } from '@/presentation/components/ErrorBoundary';
import { ApprovalFloat } from '@/presentation/components/approval/ApprovalFloat';
import { ToastProvider } from '@/presentation/ui';
import { useAndroidBackGuard } from '@/presentation/navigation/useSafeBack';

// 原生开屏保持：JS 首帧渲染完成前不自动隐藏（模块顶层一次性调用）
void SplashScreen.preventAutoHideAsync().catch(() => {
  /* swallow-ok: 已隐藏或非原生环境静默忽略 */
});

function RootShell() {
  const theme = useTheme();
  const hydrated = useAuthStore((s) => s.hydrated);
  const accountHydrated = useAccountStore((s) => s.hydrated);
  const notificationLayerRef = useRef<NotificationLayerHandle | null>(null);
  const splashHiddenRef = useRef(false);
  // Android 深链冷启动单屏：物理返回键兜底回首页，不直接退出应用
  useAndroidBackGuard();

  // 首帧布局完成即淡出原生开屏：此后闸门放行前后均无中间帧
  useLayoutEffect(() => {
    if (splashHiddenRef.current) return;
    splashHiddenRef.current = true;
    void SplashScreen.hideAsync().catch(() => {
      /* swallow-ok: 已隐藏或非原生环境静默忽略 */
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void ensurePairingWiringForApp()
      .catch((error: unknown) => {
        console.warn(
          `[startup] 配对接线装配失败，回退未配对态：${error instanceof Error ? error.message : String(error)}`
        );
        return authStore.getState().hydrate();
      })
      .finally(() => {
        if (!cancelled && !authStore.getState().hydrated) {
          void authStore.getState().hydrate();
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    startAppRuntime();
  }, []);

  useEffect(() => {
    // DB 装配与运行时并行（非闸门）；审批接线自行等待 DB 就绪（见 approvalWiring）
    void ensureDatabaseForApp();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void ensureNotificationsForApp({
      // navigate 幂等：目标已在栈顶时不重复推入（通知重复点击/同页多通知）
      navigate: (path) => router.navigate(path),
    })
      .then((handle) => {
        if (cancelled) handle.dispose();
        else notificationLayerRef.current = handle;
      })
      .catch((error: unknown) => {
        console.warn(
          `[notifications] 通知层装配失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    return () => {
      cancelled = true;
      notificationLayerRef.current?.dispose();
      notificationLayerRef.current = null;
    };
  }, [hydrated]);

  // 闸门仅依赖本地水合（SecureStore 读取，≤50ms）；期间原生 Splash 仍在屏
  if (!hydrated || !accountHydrated) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.colors.canvas }]} />
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.canvas }]}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.canvas },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(main)" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="pair" />
        <Stack.Screen name="welcome" />
        <Stack.Screen name="run/[runId]" />
        <Stack.Screen name="terminal/[runId]" />
        <Stack.Screen name="approval-history" />
        <Stack.Screen name="notifications" />
        <Stack.Screen
          name="approval/[toolCallId]"
          options={{
            presentation: 'transparentModal',
            animation: 'fade',
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
        <Stack.Screen
          name="tools/[sessionId]"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: theme.layout.toolSheetDetents,
            // iOS：停在低档时对话不压暗、仍可交互
            sheetLargestUndimmedDetentIndex: 0,
            sheetGrabberVisible: true,
            sheetCornerRadius: theme.radius.sheet,
            contentStyle: { backgroundColor: theme.colors.surfaceRaised },
          }}
        />
        <Stack.Screen
          name="approvals"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: theme.layout.approvalSheetDetents,
            sheetGrabberVisible: true,
            sheetCornerRadius: theme.radius.sheet,
            contentStyle: { backgroundColor: theme.colors.surfaceRaised },
          }}
        />
      </Stack>
      {/* 全局唯一审批入口：悬浮于所有页面之上，隐藏规则见 approvalFloatModel */}
      <ApprovalFloat />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.flex}>
      <View style={styles.flex}>
        <SafeAreaProvider>
          <ToastProvider>
            <ErrorBoundary>
              <RootShell />
            </ErrorBoundary>
          </ToastProvider>
        </SafeAreaProvider>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
