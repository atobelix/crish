import { SettingsFontView } from '@/presentation/components/settings/SettingsFontView';
import { useSettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsFontRoute() {
  const vm = useSettingsVm();
  const goBack = useSafeBack();
  return <SettingsFontView vm={vm} onBack={goBack} />;
}
