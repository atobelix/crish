import { router } from 'expo-router';
import LocalProvidersView from '@/presentation/components/localChat/LocalProvidersView';
import { useLocalProvidersVm } from '@/adapters/viewmodels/useLocalProvidersVm';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalProvidersRoute() {
  const vm = useLocalProvidersVm();
  const goBack = useSafeBack();
  return (
    <LocalProvidersView
      vm={vm}
      onBack={goBack}
      onAdd={() => router.push('/settings-local-provider-edit')}
      onEdit={(id) =>
        router.push({
          pathname: '/settings-local-provider-edit',
          params: { id },
        })
      }
    />
  );
}
