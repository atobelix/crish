import { Redirect, router } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { NotificationCenterScreen } from '@/presentation/screens';

// 通知中心（R2-04 部分 5：应用内通知列表 + 未读管理；入口 = 首页顶部铃铛，app/(tabs)/index）
// 路由骨架：守卫（未配对 → 配对页）+ 深链跳转注入（notificationRouteToPath 已在页面层翻译
// 为 expo-router 路径；本层仅 router.push）
export default function NotificationsRoute() {
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState !== 'paired') {
    return <Redirect href="/pair/welcome" />;
  }

  return (
    <NotificationCenterScreen
      onBack={() => router.back()}
      onOpenNotification={(path) => router.push(path)}
    />
  );
}
