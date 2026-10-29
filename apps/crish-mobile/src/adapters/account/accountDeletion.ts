// 注销账号：服务端校验确认邮箱后匿名化账号并吊销全部会话。
// 409 业务拒绝（法务保全 / 仍有余额或付费套餐）映射为可直接展示的中文文案。
import { AccountApiError } from './accountApi';
import { deleteAccountByConfirmEmail } from './accountService';

export type AccountDeletionResult =
  | { ok: true }
  | { ok: false; reason: 'failed' | 'unsupported'; message: string };

export const ACCOUNT_DELETION_SUPPORTED = true;

export async function deleteAccount(
  confirmEmail: string
): Promise<AccountDeletionResult> {
  try {
    await deleteAccountByConfirmEmail(confirmEmail);
    return { ok: true };
  } catch (error) {
    if (error instanceof AccountApiError) {
      if (error.code === 'legal_hold') {
        return {
          ok: false,
          reason: 'failed',
          message: '账号处于法务保全状态，暂时无法注销',
        };
      }
      if (error.code === 'account_has_balance') {
        return {
          ok: false,
          reason: 'failed',
          message: '账号仍有余额或付费套餐，暂时无法注销',
        };
      }
      if (error.code === 'email_mismatch') {
        return {
          ok: false,
          reason: 'failed',
          message: '确认邮箱与账号邮箱不一致',
        };
      }
      return { ok: false, reason: 'failed', message: error.message };
    }
    return { ok: false, reason: 'failed', message: '注销失败，请稍后重试' };
  }
}
