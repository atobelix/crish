import { router, useLocalSearchParams } from 'expo-router';
import LocalProviderEditView from '@/presentation/components/localChat/LocalProviderEditView';
import { useLocalProviderEditVm } from '@/adapters/viewmodels/useLocalProviderEditVm';
import { useLocalProvidersVm } from '@/adapters/viewmodels/useLocalProvidersVm';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalProviderEditRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const providerId =
    typeof params.id === 'string' && params.id !== '' ? params.id : null;
  const vm = useLocalProviderEditVm(providerId);
  const providersVm = useLocalProvidersVm();
  const goBack = useSafeBack();
  return (
    <LocalProviderEditView
      vm={vm}
      onBack={goBack}
      onSaved={() => router.back()}
      onDelete={providerId !== null ? providersVm.remove : null}
    />
  );
}
