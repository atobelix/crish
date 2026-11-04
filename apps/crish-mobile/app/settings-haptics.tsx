import { SettingsHapticsView } from '@/presentation/components/settings/SettingsHapticsView';
import { useSettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsHapticsRoute() {
  const vm = useSettingsVm();
  const goBack = useSafeBack();
  return <SettingsHapticsView vm={vm} onBack={goBack} />;
}
