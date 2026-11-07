import { router, useLocalSearchParams } from 'expo-router';
import ModelSpecView from '@/presentation/components/localChat/views/ModelSpecView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalModelSpecRoute() {
  const params = useLocalSearchParams<{
    providerId?: string;
    modelId?: string;
  }>();

  const providerId =
    typeof params.providerId === 'string' ? params.providerId : '';
  const modelId = typeof params.modelId === 'string' ? params.modelId : '';
  const goBack = useSafeBack();

  return (
    <ModelSpecView
      providerId={providerId}
      modelId={modelId}
      onBack={goBack}
      onSaved={() => router.back()}
      onDeleted={() => router.back()}
    />
  );
}
