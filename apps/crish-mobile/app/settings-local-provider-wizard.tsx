import { router, useLocalSearchParams } from 'expo-router';
import ProviderWizardView from '@/presentation/components/localChat/views/ProviderWizardView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalProviderWizardRoute() {
  const params = useLocalSearchParams<{
    preset?: string;
    presetKey?: string;
    targetProviderId?: string;
  }>();

  const goBack = useSafeBack();

  const preset =
    typeof params.preset === 'string' && params.preset !== ''
      ? params.preset
      : typeof params.presetKey === 'string' && params.presetKey !== ''
        ? params.presetKey
        : undefined;

  const targetProviderId =
    typeof params.targetProviderId === 'string' &&
    params.targetProviderId !== ''
      ? params.targetProviderId
      : undefined;

  return (
    <ProviderWizardView
      initialPresetKey={preset}
      targetProviderId={targetProviderId}
      onBack={goBack}
      onCancel={goBack}
      onSaved={() => router.back()}
    />
  );
}
