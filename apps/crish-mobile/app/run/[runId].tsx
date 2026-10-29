import { router, useLocalSearchParams } from 'expo-router';
import RunDetailScreen from '@/presentation/screens/runDetailScreen';
import { Protected } from '../_components/Protected';
import { useSafeBack } from '../_components/useSafeBack';

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
