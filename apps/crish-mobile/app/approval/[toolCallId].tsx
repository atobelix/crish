import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { ApprovalDetailScreen } from '@/presentation/screens';

// 审批详情（F2 §5.1 / 推送深链目标：crish://approval/<toolCallId>，M4 §4.3）
// L1 路由骨架：守卫（未配对 → 配对页）+ 深链参数落地；页面组件不感知路由
export default function ApprovalDetailRoute() {
  const { toolCallId } = useLocalSearchParams<{ toolCallId: string }>();
  const pairState = useAuthStore((s) => s.pairState);

  if (pairState !== 'paired') {
    return <Redirect href="/pair/welcome" />;
  }

  return (
    <ApprovalDetailScreen
      toolCallId={toolCallId ?? ''}
      onBack={() => router.back()}
    />
  );
}
