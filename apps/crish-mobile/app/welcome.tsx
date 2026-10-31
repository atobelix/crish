// "/welcome"：账号 v3 欢迎页；认证判定走 authSelectors SSOT（实现波总方案 E1）。
import { Redirect, router } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { shouldWelcomeRedirect } from '@/domain/pure/authSelectors';
import { WelcomeScreen } from '@/presentation/account/welcomeScreen';

export default function WelcomeRoute() {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  if (shouldWelcomeRedirect(pairState, accountStatus)) {
    return <Redirect href="/" />;
  }
  return (
    <WelcomeScreen
      onContinueWithEmail={() => router.push('/account/login')}
      onScanToConnect={() => router.push('/pair/scan')}
    />
  );
}
