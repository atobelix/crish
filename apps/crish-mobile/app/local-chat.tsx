import { router } from 'expo-router';
import LocalChatView from '@/presentation/components/localChat/LocalChatView';
import { useLocalChatVm } from '@/adapters/viewmodels/useLocalChatVm';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function LocalChatRoute() {
  const vm = useLocalChatVm();
  const goBack = useSafeBack();
  return (
    <LocalChatView
      vm={vm}
      onBack={goBack}
      onOpenProviders={() => router.push('/settings-local-providers')}
    />
  );
}
