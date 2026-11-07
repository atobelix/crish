import { useLocalSearchParams } from 'expo-router';
import { ON_DEVICE_PROVIDER_ID } from '@/adapters/onDevice/onDeviceProviderSync';
import OnDeviceModelsView from '@/presentation/components/localChat/views/OnDeviceModelsView';
import ProviderDiagnosticsView from '@/presentation/components/localChat/views/ProviderDiagnosticsView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalProviderDiagnosticsRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const providerId = typeof params.id === 'string' ? params.id : '';
  const goBack = useSafeBack();

  // 本机模型没有网络端点，不提供连接诊断：与详情路由同口径，
  // id=ondevice 落到这里改道模型管理面，诊断入口不出现在本机模型上。
  if (providerId === ON_DEVICE_PROVIDER_ID) {
    return <OnDeviceModelsView onBack={goBack} />;
  }

  return <ProviderDiagnosticsView providerId={providerId} onBack={goBack} />;
}
