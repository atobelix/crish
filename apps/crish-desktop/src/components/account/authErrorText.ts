/**
 * 账号操作失败 → 面向用户的文案。
 * 账号中心的业务拒绝（rejected）直接展示服务端文案；登录态失效、网络、未开放、其它失败走 i18n。
 */
import { AuthApiError } from '../../api/authApi';
import type { TranslateFunction } from '../../i18n';

/** Rust 侧登录态失效的固定文案（auth_commands.rs 逐字契约） */
const SESSION_EXPIRED_PATTERN = /^(unauthorized:|Not logged in)/;

export function authErrorText(error: unknown, t: TranslateFunction): string {
  if (!(error instanceof AuthApiError))
    return t('settings.account.error.failed');
  switch (error.kind) {
    case 'rejected':
      if (SESSION_EXPIRED_PATTERN.test(error.message)) {
        return t('settings.account.error.sessionExpired');
      }
      return error.message || t('settings.account.error.failed');
    case 'network':
      return t('settings.account.error.network');
    case 'unavailable':
      return t('settings.account.error.unavailable');
    default:
      return t('settings.account.error.failed');
  }
}
