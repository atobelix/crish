import OnDeviceModelsView from '@/presentation/components/localChat/views/OnDeviceModelsView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalOnDeviceRoute() {
  const goBack = useSafeBack();

  return <OnDeviceModelsView onBack={goBack} />;
}
