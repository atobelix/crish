import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { SessionDetailScreen } from '@/presentation/screens';

// 会话详情（R2-05 部分 3：该会话事件流 + 未读清零；深链目标 app/session/[sessionId]）
// 路由骨架：守卫（未配对 → 配对页）+ 深链参数落地；页面组件不感知路由
export default function SessionDetailRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState !== 'paired') {
    return <Redirect href="/pair/welcome" />;
  }

  return (
    <SessionDetailScreen
      sessionId={sessionId ?? ''}
      onBack={() => router.back()}
    />
  );
}
