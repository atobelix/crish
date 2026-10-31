// 主界面：自定义层叠卡片抽屉（CrishDrawerLayout）承载新对话与会话页。
// 入口守卫走 authSelectors SSOT：未认证（未配对且未登录）进入欢迎页。
// 抽屉开启句柄统一经 useDrawerController（useOpenDrawer 为其便捷封装）。
import { Redirect, Slot } from 'expo-router';
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
      {/* "/"：新对话；"/session/:id"：URL 与旧路由一致，深链与通知无需改 */}
      <Slot />
    </CrishDrawerLayout>
  );
}
