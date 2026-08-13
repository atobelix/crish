import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { RunDetailScreen } from '@/presentation/screens';

// run 详情（R2-05 部分 6：F1 §4.3 状态条 + 事件时间线 + 控制区 + 终端入口）
// L1 路由骨架：守卫（未配对 → 配对页）+ 深链参数落地；页面组件不感知路由
export default function RunDetailRoute() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState !== 'paired') {
    return <Redirect href="/pair/welcome" />;
  }

  const id = runId ?? '';
  return (
    <RunDetailScreen
      runId={id}
      onBack={() => router.back()}
      onOpenTerminal={() => router.push(`/terminal/${id}`)}
    />
  );
}
