// 修改密码子页（RequireAccount 守卫内）：单页式改密（验证码 + 新密码 +
// 确认同页），成功后回账号页。
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
import { finishAccountFlow } from '@/presentation/navigation/accountNavigation';
import { AccountChangePasswordScreen } from '@/presentation/account/accountChangePasswordScreen';
import { RequireAccount } from '@/presentation/components/auth/RequireAccount';

export default function AccountChangePasswordRoute() {
  const goBack = useSafeBack();
  return (
    <RequireAccount>
      <AccountChangePasswordScreen
        onBack={goBack}
        onDone={() => finishAccountFlow('account')}
      />
    </RequireAccount>
  );
}
