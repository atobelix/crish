// 账号 v3 流程的公共跳转：登录成功收起整条账号栈回到首页；修改密码完成回到账号页。
import { router } from 'expo-router';

/** 验证码页完成后的落点 */
export type AccountFlowNext = 'home' | 'account';

export function parseAccountFlowNext(value: unknown): AccountFlowNext {
  return value === 'account' ? 'account' : 'home';
}

export function finishAccountFlow(next: AccountFlowNext): void {
  if (next === 'account') {
    router.dismissTo('/account');
    return;
  }
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
}

/** 路由参数取单值 */
export function paramOf(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
