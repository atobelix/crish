// 主界面：左侧抽屉承载会话与设置入口，无底部 dock。
// 抽屉来自 expo-router 内置的 expo-router/drawer，无需新增依赖。
// 入口守卫：未配对且没有账号用户时进入账号 v3 欢迎页（扫码配对从欢迎页进入）。
// 以 user 判断而非 status：修改密码确认期间 status 会短暂离开 loggedIn。
import { Redirect } from 'expo-router';
import { Drawer } from 'expo-router/drawer';
import { useWindowDimensions } from 'react-native';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { useTheme } from '@/adapters/platform/theme';
import { CrishDrawer } from '@/presentation/components/drawer/CrishDrawer';

export default function MainLayout() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const pairState = useAuthStore((s) => s.pairState);
  const accountUser = useAccountStore((s) => s.user);

  if (pairState !== 'paired' && accountUser === null) {
    return <Redirect href="/welcome" />;
  }

  return (
    <Drawer
      // Android 返回键：会话页先回新对话，再退出应用
      backBehavior="initialRoute"
      drawerContent={(props) => <CrishDrawer {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        swipeEdgeWidth: theme.layout.drawerSwipeEdgeWidth,
        overlayColor: theme.colors.scrim,
        drawerStyle: {
          width: Math.min(
            width * theme.layout.drawerWidthRatio,
            theme.layout.drawerMaxWidth
          ),
          backgroundColor: theme.colors.canvas,
        },
        sceneStyle: { backgroundColor: theme.colors.canvas },
      }}
    >
      {/* "/"：新对话 */}
      <Drawer.Screen name="index" />
      {/* "/session/:id"：URL 与旧路由一致，深链与通知无需改 */}
      <Drawer.Screen name="session/[sessionId]" />
    </Drawer>
  );
}
