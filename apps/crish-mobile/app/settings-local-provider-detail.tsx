import { router, useLocalSearchParams } from 'expo-router';
import { ON_DEVICE_PROVIDER_ID } from '@/adapters/onDevice/onDeviceProviderSync';
import OnDeviceModelsView from '@/presentation/components/localChat/views/OnDeviceModelsView';
import ProviderDetailView from '@/presentation/components/localChat/views/ProviderDetailView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsLocalProviderDetailRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const providerId = typeof params.id === 'string' ? params.id : '';
  const goBack = useSafeBack();

  // 端侧内置条目没有可编辑的端点/密钥字段，不进直连供应商详情表单
  // （O4）：任何路径带 id=ondevice 落到这里都改道模型管理面。
  if (providerId === ON_DEVICE_PROVIDER_ID) {
    return <OnDeviceModelsView onBack={goBack} />;
  }

  return (
    <ProviderDetailView
      providerId={providerId}
      onBack={goBack}
      onNavigateWizard={(id) =>
        router.push({
          pathname: '/settings-local-provider-wizard',
          params: { targetProviderId: id },
        })
      }
      onSelectModel={(modelId) =>
        router.push({
          pathname: '/settings-local-model-spec',
          params: { providerId, modelId },
        })
      }
      onDeleted={() => router.back()}
    />
  );
}
