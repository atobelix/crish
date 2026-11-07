import { router } from 'expo-router';
import OnDeviceStorageView from '@/presentation/components/localChat/views/OnDeviceStorageView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
export default function SettingsLocalOnDeviceStorageRoute() {
  const goBack = useSafeBack();
  return (
    <OnDeviceStorageView
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
