// 认证状态单一真理源（实现波总方案 E1）：
// 路由守卫与页面禁止各自拼接 pairState / accountStatus 组合条件——
// 所有「应用是否已认证」「首屏该落在哪」的判定统一消费本文件纯函数。
// 口径（V23 修正）：局域网配对（paired）与账号登录（loggedIn）双轨并存，
// 任一成立即视为已认证；user 字段仅用于账号页自身的细粒度守卫。
import type { AuthState } from '@/domain/store/authStore';
import type { AccountStatus } from '@/domain/types/account';

/** 应用是否已认证（配对或账号登录任一成立） */
export function isAppAuthenticated(
  pairState: AuthState['pairState'],
  accountStatus: AccountStatus
): boolean {
  return pairState === 'paired' || accountStatus === 'loggedIn';
}

/** 欢迎页是否应放行跳转首页（与 isAppAuthenticated 同口径的逆命题，显式命名提升可读性） */
export function shouldWelcomeRedirect(
  pairState: AuthState['pairState'],
  accountStatus: AccountStatus
): boolean {
  return isAppAuthenticated(pairState, accountStatus);
}

/** 受保护路由是否放行（Protected 守卫消费点） */
export function shouldAllowProtectedRoute(
  pairState: AuthState['pairState'],
  accountStatus: AccountStatus
): boolean {
  return isAppAuthenticated(pairState, accountStatus);
}
