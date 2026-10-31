// "/account/delete"：账号 v3 注销账号（服务端接口未开放，见 accountDeletion）。
import { router } from 'expo-router';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { AccountDeleteScreen } from '@/presentation/account/accountDeleteScreen';
import { RequireAccount } from '@/presentation/components/auth/RequireAccount';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function AccountDeleteRoute() {
  const goBack = useSafeBack();
  const email = useAccountStore((s) => s.profile?.email ?? s.user?.email ?? '');
  return (
    <RequireAccount>
      <AccountDeleteScreen
        email={email}
        onBack={goBack}
        onDeleted={() => router.replace('/welcome')}
      />
    </RequireAccount>
  );
}
