import { router } from 'expo-router';
import { SessionsScreen } from '@/presentation/screens';

// 会话列表 Tab（R2-04 部分 3：审批角标；完整会话列表形态归 R2-05）：
// 点击行 / 角标跳转审批列表（任务书允许「跳转审批列表或对应 run 的审批」）
export default function SessionsRoute() {
  return (
    <SessionsScreen onOpenApprovals={() => router.navigate('/approvals')} />
  );
}
