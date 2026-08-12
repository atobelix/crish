import { router } from 'expo-router';
import { ApprovalListScreen } from '@/presentation/screens';

// 审批中心 Tab（F2 §4 待办列表）：路由层注入导航回调
// （页面组件不感知 expo-router，组件测试可直接挂载，对齐 approval/[toolCallId] 先例）
export default function ApprovalsRoute() {
  return (
    <ApprovalListScreen
      onOpenItem={(toolCallId) => router.push(`/approval/${toolCallId}`)}
      onOpenHistory={() => router.push('/approval-history')}
    />
  );
}
