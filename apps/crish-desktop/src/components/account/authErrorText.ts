/**
 * 账号操作失败 → 面向用户的文案。
 * 账号中心的业务拒绝（rejected）直接展示服务端文案；登录态失效、网络、未开放、其它失败走 i18n。
 */
import { AuthApiError } from '../../api/authApi';
import type { TranslateFunction } from '../../i18n';

/** Rust 侧登录态失效的固定文案（auth_commands.rs 逐字契约） */
const SESSION_EXPIRED_PATTERN = /^(unauthorized:|Not logged in)/;

/**
 * 是否为「服务端业务拒绝且非登录失效」：这类失败源于用户刚提交的内容本身，
 * 表单可把文案归因到字段（见 ChangePasswordPane 的字段级错误归因）；
 * 网络/未开放/登录失效等环境性失败不归因字段，走表单级提示。
 */
export function isRejectedAuthError(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    error.kind === 'rejected' &&
    !SESSION_EXPIRED_PATTERN.test(error.message)
  );
}

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
