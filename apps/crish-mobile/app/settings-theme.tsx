import { SettingsThemeView } from '@/presentation/components/settings/SettingsThemeView';
import { useSettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsThemeRoute() {
  const vm = useSettingsVm();
  const goBack = useSafeBack();
  return <SettingsThemeView vm={vm} onBack={goBack} />;
}
