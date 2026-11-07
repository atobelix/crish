import { router } from 'expo-router';
import OnDeviceDownloadsView from '@/presentation/components/localChat/views/OnDeviceDownloadsView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
export default function SettingsLocalOnDeviceDownloadsRoute() {
  const goBack = useSafeBack();
  return (
    <OnDeviceDownloadsView
      onBack={goBack}
      onOpenDetail={(id) =>
        router.push({
          pathname: '/settings-local-ondevice-detail',
          params: { id },
        })
      }
    />
  );
}
