// 主界面：自定义层叠卡片抽屉（CrishDrawerLayout）承载新对话与会话页。
// 入口守卫走 authSelectors SSOT：未认证（未配对且未登录）进入欢迎页。
// 抽屉开启句柄统一经 useDrawerController（useOpenDrawer 为其便捷封装）。
//
// 导航器（2026-11-05 导航语义矩阵）：(main) 组从 <Slot/> 改为显式
// <Stack>——旧 Slot 下 expo-router 对同名动态路由的 NAVIGATE 会"挤掉当前
// 条目再压栈"，会话 A→B 时 A 被挤出历史，返回永远只剩主页（见战役分析
// §2.9 源码证据）。显式 Stack 给动态屏配 getId 后：
// - 同 id 导航 = 复用置顶（去重，不堆叠重复层）；
// - 异 id 导航 = 真压栈（前进语义不变）；
// - 返回落点（2026-11-07 裁决，覆盖本矩阵原"返回 = 上一个界面"）：
//   对话界面返回恒回主页（落点原语见 navigation/useSafeBack），故
//   gestureEnabled: false 关闭原生 pop 手势——它绕过 JS 落点逻辑直
//   接退到上一个对话，且与抽屉自有横滑手势（CrishDrawerLayout）争抢；
// - animation: 'none' 保持"壳内换内容无转场"的既有观感。
import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { isAppAuthenticated } from '@/domain/pure/authSelectors';
import { CrishDrawerLayout } from '@/presentation/components/drawer/CrishDrawerLayout';

export default function MainLayout() {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);

  if (!isAppAuthenticated(pairState, accountStatus)) {
    return <Redirect href="/welcome" />;
  }

  return (
    <CrishDrawerLayout>
      {/* "/"：新对话；"/session/:id" 与 "/thread/:id"：URL 与旧路由一致，
          深链与通知无需改。getId 以动态段派生路由 id：同名屏按 id 去重/压栈。 */}
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'none',
          gestureEnabled: false,
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen
          name="session/[sessionId]"
          getId={({ params }) => `session-${params?.sessionId ?? 'unknown'}`}
        />
        <Stack.Screen
          name="thread/[threadId]"
          getId={({ params }) => `thread-${params?.threadId ?? 'unknown'}`}
        />
      </Stack>
    </CrishDrawerLayout>
  );
}
