import { router } from 'expo-router';
import ProvidersListView from '@/presentation/components/localChat/views/ProvidersListView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalProvidersRoute() {
  const goBack = useSafeBack();

  return (
    <ProvidersListView
      onBack={goBack}
      onAddProvider={() => router.push('/settings-local-provider-wizard')}
      onSelectPreset={(presetKey) =>
        router.push({
          pathname: '/settings-local-provider-wizard',
          params: { preset: presetKey },
        })
      }
      onSelectProvider={(id) =>
        router.push({
          pathname: '/settings-local-provider-detail',
          params: { id },
        })
      }
      onSelectOnDevice={() => router.push('/settings-local-ondevice')}
    />
  );
}
