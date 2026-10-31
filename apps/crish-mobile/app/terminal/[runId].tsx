import { useLocalSearchParams } from 'expo-router';
import TerminalScreen from '@/presentation/screens/terminalScreen';
import { Protected } from '@/presentation/components/auth/Protected';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function TerminalRoute() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const goBack = useSafeBack();
  return (
    <Protected>
      <TerminalScreen runId={runId ?? ''} onBack={goBack} />
    </Protected>
  );
}
