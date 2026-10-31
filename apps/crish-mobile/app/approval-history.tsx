import ApprovalHistoryScreen from '@/presentation/screens/approvalHistoryScreen';
import { Protected } from '@/presentation/components/auth/Protected';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function ApprovalHistoryRoute() {
  const goBack = useSafeBack();
  return (
    <Protected>
      <ApprovalHistoryScreen onBack={goBack} />
    </Protected>
  );
}
