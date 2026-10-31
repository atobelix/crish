// "/account/code"：账号 v3 验证码页；next 决定完成后的落点。
import { router, useLocalSearchParams } from 'expo-router';
import { AccountCodeScreen } from '@/presentation/account/accountCodeScreen';
import {
  finishAccountFlow,
  paramOf,
  parseAccountFlowNext,
} from '@/presentation/navigation/accountNavigation';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function AccountCodeRoute() {
  const goBack = useSafeBack();
  const params = useLocalSearchParams<{ next?: string }>();
  const next = parseAccountFlowNext(paramOf(params.next));
  return (
    <AccountCodeScreen
      onBack={goBack}
      onSuccess={() => finishAccountFlow(next)}
      onSetPassword={(mode) =>
        router.push({
          pathname: '/account/set-password',
          params: { mode },
        })
      }
    />
  );
}
