// "/account/set-password"：账号 v3 设置 / 重置 / 修改密码（先设密码，再发验证码）。
import { router, useLocalSearchParams } from 'expo-router';
import {
  AccountSetPasswordScreen,
  isSetPasswordMode,
} from '@/presentation/account/accountSetPasswordScreen';
import { finishAccountFlow, paramOf } from '../_components/accountNavigation';
import { useSafeBack } from '../_components/useSafeBack';

export default function AccountSetPasswordRoute() {
  const goBack = useSafeBack();
  const params = useLocalSearchParams<{ mode?: string; email?: string }>();
  const rawMode = paramOf(params.mode);
  const mode = isSetPasswordMode(rawMode) ? rawMode : 'reset';
  return (
    <AccountSetPasswordScreen
      mode={mode}
      initialEmail={paramOf(params.email)}
      onBack={goBack}
      onCodeSent={() =>
        router.push({
          pathname: '/account/code',
          params: { next: mode === 'change' ? 'account' : 'home' },
        })
      }
      onDone={() => finishAccountFlow('home')}
    />
  );
}
