/**
 * 账号身份展示的共用推导（设置「账户」概览与侧栏左下角头像共用）：头像地址、显示名、首字母。
 */
import {
  AUTH_BASE_URL,
  type AccountProfile,
  type UserProfile,
} from '../../api/authApi';

/** 头像地址：账号中心可能返回相对路径 */
export function resolveAvatarUrl(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  return /^(https?:|data:)/.test(url) ? url : `${AUTH_BASE_URL}${url}`;
}

/** 显示名：资料昵称 → 账号名 → 邮箱前缀 */
export function accountDisplayName(
  user: UserProfile | null,
  profile: AccountProfile | null
): string {
  const email = profile?.email || user?.email || '';
  return profile?.displayName || user?.name || email.split('@')[0] || '';
}

/** 头像首字母（无图时的占位） */
export function accountInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}
