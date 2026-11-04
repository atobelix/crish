// "/account/set-password"：账号 v3 设置 / 重置密码（验证码通过后凭 setupToken 设密）。
// 修改密码走单页式 /account/change-password，不再经本页。
import { useLocalSearchParams } from 'expo-router';
import {
  AccountSetPasswordScreen,
  isSetPasswordMode,
} from '@/presentation/account/accountSetPasswordScreen';
import {
  finishAccountFlow,
  paramOf,
} from '@/presentation/navigation/accountNavigation';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
import { RequireGuest } from '@/presentation/components/auth/RequireGuest';

export default function AccountSetPasswordRoute() {
  const goBack = useSafeBack();
  const params = useLocalSearchParams<{ mode?: string; email?: string }>();
  const rawMode = paramOf(params.mode);
  const mode = isSetPasswordMode(rawMode) ? rawMode : 'reset';
  return (
    <RequireGuest>
      <AccountSetPasswordScreen
        mode={mode}
        initialEmail={paramOf(params.email)}
        onBack={goBack}
        onDone={() => finishAccountFlow('home')}
      />
    </RequireGuest>
  );
}
