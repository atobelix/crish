// "/account/profile"：账号 v3 个人资料。
import { AccountProfileScreen } from '@/presentation/account/accountProfileScreen';
import { RequireAccount } from '../_components/RequireAccount';
import { useSafeBack } from '../_components/useSafeBack';

export default function AccountProfileRoute() {
  const goBack = useSafeBack();
  return (
    <RequireAccount>
      <AccountProfileScreen onBack={goBack} />
    </RequireAccount>
  );
}
