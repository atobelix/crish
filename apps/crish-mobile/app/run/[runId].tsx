import { router, useLocalSearchParams } from 'expo-router';
import RunDetailScreen from '@/presentation/screens/runDetailScreen';
import { Protected } from '@/presentation/components/auth/Protected';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function RunDetailRoute() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const id = runId ?? '';
  const goBack = useSafeBack();
  return (
    <Protected>
      <RunDetailScreen
        runId={id}
        onBack={goBack}
        onOpenTerminal={() => router.push(`/terminal/${id}`)}
      />
    </Protected>
  );
}
