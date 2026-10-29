// "/account/login"：账号 v3 邮箱入口（登录或注册，旧 /account/email 已并入此路径）。
import { router } from 'expo-router';
import { AccountEmailScreen } from '@/presentation/account/accountEmailScreen';
import { useSafeBack } from '../_components/useSafeBack';

export default function AccountLoginRoute() {
  const goBack = useSafeBack();
  return (
    <AccountEmailScreen
      onBack={goBack}
      onCodeSent={() =>
        router.push({ pathname: '/account/code', params: { next: 'home' } })
      }
      onUsePassword={(email) =>
        router.push({ pathname: '/account/password', params: { email } })
      }
    />
  );
}
