import { Redirect, router } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { ApprovalHistoryScreen } from '@/presentation/screens';

// 审批历史全量页（F2 §7 · R4 批次3）：审批中心「已处理」入口的深链目标；
// 路由骨架：守卫（未配对 → 配对页）+ 返回注入；页面组件不感知路由
export default function ApprovalHistoryRoute() {
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState !== 'paired') {
    return <Redirect href="/pair/welcome" />;
  }

  return <ApprovalHistoryScreen onBack={() => router.back()} />;
}
