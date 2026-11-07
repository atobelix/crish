import { router } from 'expo-router';
import OnDeviceLibraryView from '@/presentation/components/localChat/views/OnDeviceLibraryView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
export default function SettingsLocalOnDeviceLibraryRoute() {
  const goBack = useSafeBack();
  return (
    <OnDeviceLibraryView
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
