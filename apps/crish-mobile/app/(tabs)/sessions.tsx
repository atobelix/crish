import { router } from 'expo-router';
import { SessionsScreen } from '@/presentation/screens';

// 会话列表 Tab（R2-05 部分 4：会话列表完整形态——预览/相对时间/未读角标/交互）：
// - 行点击 → 会话详情 app/session/[sessionId]（深链目标，F5 §4.1 会话项点击 → 会话详情）；
// - 角标点击 → 审批列表（任务书允许「跳转审批列表或对应 run 的审批」）。
export default function SessionsRoute() {
  return (
    <SessionsScreen
      onOpenApprovals={() => router.navigate('/approvals')}
      onOpenSession={(sessionId) => router.navigate(`/session/${sessionId}`)}
    />
  );
}
