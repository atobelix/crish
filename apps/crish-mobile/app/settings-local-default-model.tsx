import { router } from 'expo-router';
import DefaultModelView from '@/presentation/components/localChat/views/DefaultModelView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalDefaultModelRoute() {
  const goBack = useSafeBack();
  return (
    <DefaultModelView
      onBack={goBack}
      onOpenProviders={() => router.push('/settings-local-providers')}
      onOpenOnDevice={() => router.push('/settings-local-ondevice')}
      onOpenOnDeviceDetail={(id) =>
        router.push({
          pathname: '/settings-local-ondevice-detail',
          params: { id },
        })
      }
    />
  );
}
