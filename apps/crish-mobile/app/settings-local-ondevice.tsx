import { router } from 'expo-router';
import OnDeviceModelsView from '@/presentation/components/localChat/views/OnDeviceModelsView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
export default function SettingsLocalOnDeviceRoute() {
  const goBack = useSafeBack();
  return (
    <OnDeviceModelsView
      onBack={goBack}
      onOpenInstalled={() => router.push('/settings-local-ondevice-installed')}
      onOpenLibrary={() => router.push('/settings-local-ondevice-library')}
      onOpenDownloads={() => router.push('/settings-local-ondevice-downloads')}
      onOpenStorage={() => router.push('/settings-local-ondevice-storage')}
    />
  );
}
