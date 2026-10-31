// 账号 v3 流程编排（先验证码、后设密码）。
//
// 服务端统一入口：
// - 邮箱 → `POST /email/continue`（已注册发登录码，未注册发注册码）；
// - 验证码 → `POST /email/continue/confirm`：老用户直接登录；新用户返回 setupToken；
// - 注册 / 重置 → `POST /email/code/verify` 换 setupToken → `POST /email/password/set`；
// - 已登录改密 → `POST /password/change/request|confirm`。
//
// 新密码与 setupToken 只放内存草稿，不落盘、不进路由参数。
import {
  confirmAccountEmailContinue,
  confirmAccountPasswordChange,
  continueAccountEmail,
  requestAccountEmailCode,
  requestAccountPasswordChangeCode,
  setAccountPasswordWithToken,
  verifyAccountResetCode,
} from '@/adapters/account/accountService';
import { AccountApiError } from '@/adapters/account/accountApi';
import type { LoginResult } from '@/adapters/account/accountService';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
/** 重新发送冷却（秒） */
export const RESEND_COOLDOWN_SECONDS = 60;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 流程用途：login 覆盖「登录或注册」，reset 是未登录找回，change 是已登录改密。 */
export type AccountFlowPurpose = 'login' | 'reset' | 'change';

export interface AccountFlowDraft {
  email: string;
  purpose: AccountFlowPurpose;
  /** change 场景的新密码（只在内存里，提交验证码时使用） */
  password: string | null;
  /** 验证码校验后的一次性 setup token（register / reset 设密使用） */
  setupToken: string | null;
  /** 可再次发送的时间戳（ms） */
  resendAt: number;
  /** 开发环境服务端回传的验证码，仅用于联调提示 */
  devCode: string | null;
}

let draft: AccountFlowDraft | null = null;

export function getAccountFlowDraft(): AccountFlowDraft | null {
  return draft;
}

export function clearAccountFlowDraft(): void {
  draft = null;
}

export type CodeRequestResult =
  { kind: 'sent' } | { kind: 'error'; message: string; retryAfter?: number };

export type ConfirmCodeResult =
  | { kind: 'signed_in' }
  | { kind: 'set_password'; mode: 'register' | 'reset' }
  | { kind: 'changed' }
  | { kind: 'failed'; message: string; retryAfter?: number };

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function retryAfterOf(error: unknown): number | undefined {
  return error instanceof AccountApiError ? error.retryAfter : undefined;
}

function errorResult(error: unknown, fallback: string): CodeRequestResult {
  return {
    kind: 'error',
    message: messageOf(error, fallback),
    ...(retryAfterOf(error) !== undefined
      ? { retryAfter: retryAfterOf(error) }
      : {}),
  };
}

function setDraft(next: AccountFlowDraft): void {
  draft = next;
}

function draftAfterSend(
  email: string,
  purpose: AccountFlowPurpose,
  now: number,
  devCode: string | null,
  extra?: { password?: string | null; setupToken?: string | null }
): AccountFlowDraft {
  return {
    email,
    purpose,
    password: extra?.password ?? null,
    setupToken: extra?.setupToken ?? null,
    resendAt: now + RESEND_COOLDOWN_SECONDS * 1000,
    devCode,
  };
}

/** 「使用邮箱继续」：服务端决定登录码 / 注册码，成功后进入验证码页。 */
export async function continueWithEmail(
  rawEmail: string,
  now: number = Date.now()
): Promise<CodeRequestResult> {
  const email = normalizeEmail(rawEmail);
  try {
    const ticket = await continueAccountEmail(email);
    setDraft(draftAfterSend(email, 'login', now, ticket.devCode ?? null));
    return { kind: 'sent' };
  } catch (error) {
    return errorResult(error, '验证码发送失败');
  }
}

/** 找回密码：先发重置验证码，再输码换 setupToken，最后设新密码。 */
export async function startPasswordReset(
  rawEmail: string,
  now: number = Date.now()
): Promise<CodeRequestResult> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return { kind: 'error', message: '请输入有效邮箱' };
  }
  try {
    const ticket = await requestAccountEmailCode('reset', email);
    setDraft(draftAfterSend(email, 'reset', now, ticket.devCode ?? null));
    return { kind: 'sent' };
  } catch (error) {
    return errorResult(error, '验证码发送失败');
  }
}

/** 已登录修改密码：先收下新密码草稿并向绑定邮箱发验证码。 */
export async function startPasswordChange(
  email: string,
  password: string,
  now: number = Date.now()
): Promise<CodeRequestResult> {
  try {
    const ticket = await requestAccountPasswordChangeCode();
    setDraft(
      draftAfterSend(
        normalizeEmail(email),
        'change',
        now,
        ticket.devCode ?? null,
        {
          password,
        }
      )
    );
    return { kind: 'sent' };
  } catch (error) {
    return errorResult(error, '验证码发送失败');
  }
}

/** 重新发送当前草稿场景的验证码。 */
export async function resendAccountCode(
  now: number = Date.now()
): Promise<CodeRequestResult> {
  if (!draft) return { kind: 'error', message: '请返回重新输入邮箱' };
  const current = draft;
  try {
    let devCode: string | null = null;
    if (current.purpose === 'login') {
      const ticket = await continueAccountEmail(current.email);
      devCode = ticket.devCode ?? null;
    } else if (current.purpose === 'reset') {
      const ticket = await requestAccountEmailCode('reset', current.email);
      devCode = ticket.devCode ?? null;
    } else {
      const ticket = await requestAccountPasswordChangeCode();
      devCode = ticket.devCode ?? null;
    }
    draft = {
      ...current,
      resendAt: now + RESEND_COOLDOWN_SECONDS * 1000,
      devCode,
    };
    return { kind: 'sent' };
  } catch (error) {
    return errorResult(error, '验证码发送失败');
  }
}

/**
 * 校验验证码：
 * - login：老用户直接登录；新用户携带 setupToken 进入「设置密码」；
 * - reset：换 setupToken 进入「设置密码」；
 * - change：带草稿里的新密码提交改密。
 */
export async function confirmAccountCode(
  code: string
): Promise<ConfirmCodeResult> {
  if (!draft) return { kind: 'failed', message: '请返回重新输入邮箱' };
  const current = draft;
  try {
    if (current.purpose === 'login') {
      const outcome = await confirmAccountEmailContinue(current.email, code);
      if (outcome.kind === 'signed_in') {
        clearAccountFlowDraft();
        return { kind: 'signed_in' };
      }
      draft = { ...current, setupToken: outcome.setupToken };
      return { kind: 'set_password', mode: 'register' };
    }
    if (current.purpose === 'reset') {
      const setupToken = await verifyAccountResetCode(current.email, code);
      draft = { ...current, setupToken };
      return { kind: 'set_password', mode: 'reset' };
    }
    if (!current.password) {
      return { kind: 'failed', message: '请返回重新设置新密码' };
    }
    await confirmAccountPasswordChange(code, current.password);
    clearAccountFlowDraft();
    return { kind: 'changed' };
  } catch (error) {
    const message =
      error instanceof AccountApiError &&
      error.code === 'code_attempts_exceeded'
        ? '验证码错误次数过多，请重新发送'
        : messageOf(error, '验证码不正确');
    const retryAfter = retryAfterOf(error);
    return {
      kind: 'failed',
      message,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }
}

/** 设置密码页提交：凭 setupToken 完成注册 / 重置并建立会话（结构化结果）。 */
export async function completeAccountPassword(
  password: string
): Promise<LoginResult> {
  if (!draft?.setupToken) {
    return { ok: false, kind: 'network', message: '会话已失效，请返回重试' };
  }
  const result = await setAccountPasswordWithToken(draft.setupToken, password);
  if (result.ok) clearAccountFlowDraft();
  return result;
}
