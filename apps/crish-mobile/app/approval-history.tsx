import ApprovalHistoryScreen from '@/presentation/screens/approvalHistoryScreen';
import { Protected } from './_components/Protected';
import { useSafeBack } from './_components/useSafeBack';

export default function ApprovalHistoryRoute() {
  const goBack = useSafeBack();
  return (
    <Protected>
      <ApprovalHistoryScreen onBack={goBack} />
    </Protected>
  );
}
