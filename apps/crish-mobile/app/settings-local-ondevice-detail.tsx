import { useLocalSearchParams } from 'expo-router';
import OnDeviceDetailView from '@/presentation/components/localChat/views/OnDeviceDetailView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
export default function SettingsLocalOnDeviceDetailRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const modelId = typeof params.id === 'string' ? params.id : '';
  const goBack = useSafeBack();
  return <OnDeviceDetailView modelId={modelId} onBack={goBack} />;
}
