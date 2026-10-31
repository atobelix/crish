// "/account/sessions"：账号 v3 登录设备。
import { AccountSessionsScreen } from '@/presentation/account/accountSessionsScreen';
import { RequireAccount } from '@/presentation/components/auth/RequireAccount';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function AccountSessionsRoute() {
  const goBack = useSafeBack();
  return (
    <RequireAccount>
      <AccountSessionsScreen onBack={goBack} />
    </RequireAccount>
  );
}
