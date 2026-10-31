// /approvals：多条待审批时的队列 sheet（formSheet，见根布局）。
// 补挂 Protected（实现波总方案 V20）：深链直达时与子页面守卫口径一致。
import { router } from 'expo-router';
import ApprovalListScreen from '@/presentation/screens/approvalListScreen';
import { Protected } from '@/presentation/components/auth/Protected';

export default function ApprovalsRoute() {
  return (
    <Protected>
      <ApprovalListScreen
        onOpenItem={(toolCallId) => router.push(`/approval/${toolCallId}`)}
      />
    </Protected>
  );
}
