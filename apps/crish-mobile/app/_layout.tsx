// 根布局：安全区 / 主题 / Toast / 启动装配 / 认证水合闸门（纯本地）/ 导航栈 / 全局审批悬浮卡。
// 键盘：KeyboardProvider 是全仓唯一的键盘高度/状态生产者（键盘审计 §4.2 单源
// 纪律）；系统栏在本 app 为全透明 edge-to-edge 形态，故两个 translucent 标志
// 均按真值开启，让库按含系统栏的窗口坐标计算键盘帧。
// 启动时序（实现波总方案 维 A）：本地水合 ≤50ms 即放行首屏；远程校正、DB 装配、
// 通知层全部后台并行，不经闸门。原生 Splash 由 preventAutoHideAsync 保持到首帧渲染，
// 无 JS 自绘中间帧（无 BrandMark、无 Spinner）。
import { useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { enableFreeze, enableScreens } from 'react-native-screens';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import {
  FiraCode_400Regular,
  FiraCode_600SemiBold,
} from '@expo-google-fonts/fira-code';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_600SemiBold,
} from '@expo-google-fonts/jetbrains-mono';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { authStore } from '@/domain/store/authStore';
import { useTheme } from '@/adapters/platform/theme';
import { createLogger } from '@/adapters/platform/logger';
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
import { useOverlayBackHandler } from '@/presentation/ui/overlayStack';
import { useAndroidBackGuard } from '@/presentation/navigation/useSafeBack';

const log = createLogger('startup');
const notificationsLog = createLogger('notifications');

// 全局启用原生屏幕与后台视口冰冻（方案 21：转场期间后台页面 React Suspense 冻结，消灭退栈幽灵重绘）
enableScreens(true);
enableFreeze(true);

// 原生开屏保持：JS 首帧渲染完成前不自动隐藏（模块顶层一次性调用）
void SplashScreen.preventAutoHideAsync().catch(() => {
  /* swallow-ok: 已隐藏或非原生环境静默忽略 */
});

function RootShell() {
  const theme = useTheme();
  const hydrated = useAuthStore((s) => s.hydrated);
  const accountHydrated = useAccountStore((s) => s.hydrated);
  // 等宽字体预载（设置·字体真源；加载期原生 Splash 仍在屏，无字体切换闪帧）
  const [fontsLoaded, fontError] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_600SemiBold,
    FiraCode_400Regular,
    FiraCode_600SemiBold,
  });
  // 字体就绪 = 加载成功或已失败：失败时必须放行（回落系统等宽），否则闸门
  // 永远等不到 fontsLoaded，应用会无报错地卡死在开屏（W-A 风险 2 修法）
  const fontsReady = fontsLoaded || fontError != null;
  useEffect(() => {
    if (fontError) {
      log.warn(`等宽字体加载失败，已回落系统字体：${fontError.message}`);
    }
  }, [fontError]);
  const notificationLayerRef = useRef<NotificationLayerHandle | null>(null);
  const splashHiddenRef = useRef(false);
  // Android 深链冷启动单屏：物理返回键兜底回首页，不直接退出应用
  useAndroidBackGuard();
  // 覆盖层返回分发（批 D）：订阅顺序在 back guard 之后（BackHandler
  // 后订阅先调用）——非 Modal 浮层（菜单/锚点 Popover）打开时返回
  // 先关栈顶浮层，栈空不消费、落回 guard 的导航兜底
  useOverlayBackHandler();

  // 字体就绪 + 首帧布局完成才淡出原生开屏：此后闸门放行前后均无中间帧
  useLayoutEffect(() => {
    if (!fontsReady || splashHiddenRef.current) return;
    splashHiddenRef.current = true;
    void SplashScreen.hideAsync().catch(() => {
      /* swallow-ok: 已隐藏或非原生环境静默忽略 */
    });
  }, [fontsReady]);

  useEffect(() => {
    let cancelled = false;
    void ensurePairingWiringForApp()
      .catch((error: unknown) => {
        log.warn('配对接线装配失败，回退未配对态', error);
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
        notificationsLog.warn('通知层装配失败', error);
      });
    return () => {
      cancelled = true;
      notificationLayerRef.current?.dispose();
      notificationLayerRef.current = null;
    };
  }, [hydrated]);

  // 闸门 = 字体就绪（含失败放行）+ 本地水合（SecureStore 读取，≤50ms）；期间原生 Splash 仍在屏
  if (!fontsReady || !hydrated || !accountHydrated) {
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
      <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
        <View style={styles.flex}>
          <SafeAreaProvider>
            <ToastProvider>
              <ErrorBoundary>
                <RootShell />
              </ErrorBoundary>
            </ToastProvider>
          </SafeAreaProvider>
        </View>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
