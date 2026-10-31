// "/account/profile"：账号 v3 个人资料。
import { AccountProfileScreen } from '@/presentation/account/accountProfileScreen';
import { RequireAccount } from '@/presentation/components/auth/RequireAccount';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function AccountProfileRoute() {
  const goBack = useSafeBack();
  return (
    <RequireAccount>
      <AccountProfileScreen onBack={goBack} />
    </RequireAccount>
  );
}
