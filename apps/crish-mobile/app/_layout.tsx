// 根布局：安全区 / 主题 / Toast / 启动装配 / 认证水合闸门 / 导航栈 / 全局审批悬浮卡。
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
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
import { BrandMark, Spinner, ToastProvider } from '@/presentation/ui';

/** 账号 v3 页面（统一推入时长） */
const ACCOUNT_V3_ROUTES = [
  'account/index',
  'account/login',
  'account/code',
  'account/password',
  'account/set-password',
  'account/profile',
  'account/sessions',
  'account/delete',
] as const;

function RootShell() {
  const theme = useTheme();
  const hydrated = useAuthStore((s) => s.hydrated);
  const accountHydrated = useAccountStore((s) => s.hydrated);
  const notificationLayerRef = useRef<NotificationLayerHandle | null>(null);

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
    void ensureDatabaseForApp();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void ensureNotificationsForApp({ navigate: (path) => router.push(path) })
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

  if (!hydrated || !accountHydrated) {
    return (
      <View
        style={[
          styles.splash,
          { gap: theme.space.xl, backgroundColor: theme.colors.canvas },
        ]}
      >
        <BrandMark size={64} />
        <Spinner />
      </View>
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
        {/* 账号 v3：推入时长取 motion.account.push（iOS 生效；自定义缓动曲线原生栈不支持） */}
        {ACCOUNT_V3_ROUTES.map((name) => (
          <Stack.Screen
            key={name}
            name={name}
            options={{ animationDuration: theme.motion.account.push }}
          />
        ))}
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
    <GestureHandlerRootView>
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
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
