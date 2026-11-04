import { SettingsVoiceView } from '@/presentation/components/settings/SettingsVoiceView';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsVoiceRoute() {
  const goBack = useSafeBack();
  return <SettingsVoiceView onBack={goBack} />;
}
