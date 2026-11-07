import { router } from 'expo-router';
import OnDeviceInstalledView from '@/presentation/components/localChat/views/OnDeviceInstalledView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
export default function SettingsLocalOnDeviceInstalledRoute() {
  const goBack = useSafeBack();
  return (
    <OnDeviceInstalledView
      onBack={goBack}
      onOpenDetail={(id) =>
        router.push({
          pathname: '/settings-local-ondevice-detail',
          params: { id },
        })
      }
      onOpenLibrary={() => router.push('/settings-local-ondevice-library')}
    />
  );
}
