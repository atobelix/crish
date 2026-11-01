import { SettingsNotificationView } from '@/presentation/components/settings/SettingsNotificationView';
import { useSettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsNotificationRoute() {
  const vm = useSettingsVm();
  const goBack = useSafeBack();
  return <SettingsNotificationView vm={vm} onBack={goBack} />;
}
