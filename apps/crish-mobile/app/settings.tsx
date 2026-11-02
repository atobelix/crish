import { router } from 'expo-router';
import { SettingsScreenView } from '@/presentation/components/settings';
import { useSettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function SettingsScreen() {
  const vm = useSettingsVm();
  const goBack = useSafeBack();
  const onConfirmRemove = () => {
    void vm.removeLocal().then(() => {
      router.replace('/welcome');
    });
  };
  return (
    <SettingsScreenView
      vm={vm}
      onBack={goBack}
      onOpenAccount={() => router.push('/account')}
      onOpenSessions={() => router.push('/account/sessions')}
      onOpenTheme={() => router.push('/settings-theme')}
      onOpenFont={() => router.push('/settings-font')}
      onOpenNotification={() => router.push('/settings-notification')}
      onOpenScan={() => router.push('/pair/scan')}
      onOpenLocalChat={() => router.push('/local-chat')}
      onOpenLocalProviders={() => router.push('/settings-local-providers')}
      onConfirmRemove={onConfirmRemove}
    />
  );
}
