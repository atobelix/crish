// "/welcome"：账号 v3 欢迎页；已配对或已登录直接进首页。
import { Redirect, router } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { WelcomeScreen } from '@/presentation/account/welcomeScreen';

export default function WelcomeRoute() {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  if (pairState === 'paired' || accountStatus === 'loggedIn') {
    return <Redirect href="/" />;
  }
  return (
    <WelcomeScreen
      onContinueWithEmail={() => router.push('/account/login')}
      onScanToConnect={() => router.push('/pair/scan')}
    />
  );
}
