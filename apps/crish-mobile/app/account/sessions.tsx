// "/account/sessions"：账号 v3 登录设备。
import { AccountSessionsScreen } from '@/presentation/account/accountSessionsScreen';
import { RequireAccount } from '../_components/RequireAccount';
import { useSafeBack } from '../_components/useSafeBack';

export default function AccountSessionsRoute() {
  const goBack = useSafeBack();
  return (
    <RequireAccount>
      <AccountSessionsScreen onBack={goBack} />
    </RequireAccount>
  );
}
