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
      onOpenAccount={() => router.push('/account/login')}
      onOpenProfile={() => router.push('/account')}
      onConfirmRemove={onConfirmRemove}
    />
  );
}
