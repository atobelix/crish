// 换绑邮箱子页（RequireAccount 守卫内）：界面按原型建成；账号服务暂无
// 换绑能力，页面内如实提示（见 accountChangeEmailScreen 文件头审计结论）。
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
import { AccountChangeEmailScreen } from '@/presentation/account/accountChangeEmailScreen';
import { RequireAccount } from '@/presentation/components/auth/RequireAccount';

export default function AccountChangeEmailRoute() {
  const goBack = useSafeBack();
  return (
    <RequireAccount>
      <AccountChangeEmailScreen onBack={goBack} />
    </RequireAccount>
  );
}
