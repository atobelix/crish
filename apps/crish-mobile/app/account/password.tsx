// "/account/password"：账号 v3 密码登录。
import { router, useLocalSearchParams } from 'expo-router';
import { AccountPasswordScreen } from '@/presentation/account/accountPasswordScreen';
import { finishAccountFlow, paramOf } from '../_components/accountNavigation';
import { useSafeBack } from '../_components/useSafeBack';

export default function AccountPasswordRoute() {
  const goBack = useSafeBack();
  const params = useLocalSearchParams<{ email?: string }>();
  return (
    <AccountPasswordScreen
      initialEmail={paramOf(params.email)}
      onBack={goBack}
      onSuccess={() => finishAccountFlow('home')}
      onForgot={() =>
        router.push({ pathname: '/account/code', params: { next: 'home' } })
      }
    />
  );
}
