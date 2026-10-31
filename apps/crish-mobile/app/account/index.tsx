// "/account"：账号 v3 账号页。
import { router } from 'expo-router';
import { AccountHomeScreen } from '@/presentation/account/accountHomeScreen';
import { RequireAccount } from '@/presentation/components/auth/RequireAccount';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function AccountHomeRoute() {
  const goBack = useSafeBack();
  return (
    <RequireAccount>
      <AccountHomeScreen
        onBack={goBack}
        onOpenProfile={() => router.push('/account/profile')}
        onOpenSessions={() => router.push('/account/sessions')}
        onChangePassword={(email) =>
          router.push({
            pathname: '/account/set-password',
            params: { mode: 'change', email },
          })
        }
        onOpenDelete={() => router.push('/account/delete')}
        onSignedOut={() => router.replace('/welcome')}
      />
    </RequireAccount>
  );
}
