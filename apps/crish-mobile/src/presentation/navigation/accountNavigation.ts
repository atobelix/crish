// 账号 v3 流程的公共跳转（实现波总方案 E2 / N04 §3.4.4 / 方案 01）：
// 登录成功彻底清空认证栈回到首页；修改密码完成回到账号页。
import { router } from 'expo-router';

/** 验证码页完成后的落点 */
export type AccountFlowNext = 'home' | 'account';

export function parseAccountFlowNext(value: unknown): AccountFlowNext {
  return value === 'account' ? 'account' : 'home';
}

/**
 * 账号流程收口跳转（登录成功 / 设密成功）：
 * 彻底清除认证栈，保证主页面成为唯一根节点，栈底绝对不可回退到登录界面。
 */
export function finishAccountFlow(next: AccountFlowNext): void {
  if (next === 'account') {
    if (router.canGoBack()) {
      router.dismissTo('/account');
      return;
    }
    router.replace('/account');
    return;
  }

  // 登录成功回到首页必须彻底清空栈内的 /welcome, /account/login, /account/password
  // Expo Router 中，先执行 dismissAll 收起全部浮层与子栈
  if (router.canDismiss()) {
    try {
      router.dismissAll();
    } catch {
      // 容错：个别非模态原生栈 dismissAll 异常时静默忽略
    }
  }

  // 无论历史如何，以 replace 形式强制把根指向 '/'，阻断任何回退路径
  router.replace('/');
}

/** 路由参数取单值 */
export function paramOf(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
