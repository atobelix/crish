import { useLocalSearchParams } from 'expo-router';
import ApprovalDetailScreen from '@/presentation/screens/approvalDetailScreen';
import { Protected } from '@/presentation/components/auth/Protected';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function ApprovalDetailRoute() {
  const { toolCallId } = useLocalSearchParams<{ toolCallId: string }>();
  const goBack = useSafeBack();
  return (
    <Protected>
      <ApprovalDetailScreen toolCallId={toolCallId ?? ''} onBack={goBack} />
    </Protected>
  );
}
