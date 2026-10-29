// /approvals：多条待审批时的队列 sheet（formSheet，见根布局）。
import { router } from 'expo-router';
import ApprovalListScreen from '@/presentation/screens/approvalListScreen';

export default function ApprovalsRoute() {
  return (
    <ApprovalListScreen
      onOpenItem={(toolCallId) => router.push(`/approval/${toolCallId}`)}
    />
  );
}
