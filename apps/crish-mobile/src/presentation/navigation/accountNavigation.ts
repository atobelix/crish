// 账号 v3 流程的公共跳转（实现波总方案 E2 / N04 §3.4.4）：
// 登录成功收起整条账号栈回到首页；修改密码完成回到账号页。
// 导航动作单次原子分发：废除 dismissAll()+replace 同 tick 连击
// （原生栈 dismiss 动画未完成即收到 replace，产生转场撕裂与状态分发告警）。
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
  // 栈内可整体收起（账号流程为 push 序列）→ 单次 dismiss 到根；
  // 否则（冷启动深链等无栈场景）单次 replace，不做二次分发。
  if (router.canDismiss()) {
    router.dismissTo('/');
    return;
  }
  router.replace('/');
}

/** 路由参数取单值 */
export function paramOf(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
