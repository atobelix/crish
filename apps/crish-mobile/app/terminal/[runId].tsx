import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { TerminalScreen } from '@/presentation/screens';

// 终端只读回放（R2-05 部分 3：F3 §4 只读终端 / 深链目标 app/terminal/[runId]）
// 路由骨架：守卫（未配对 → 配对页）+ 深链参数落地；页面组件不感知路由
export default function TerminalRoute() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState !== 'paired') {
    return <Redirect href="/pair/welcome" />;
  }

  return <TerminalScreen runId={runId ?? ''} onBack={() => router.back()} />;
}
