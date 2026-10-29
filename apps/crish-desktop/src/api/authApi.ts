/**
 * 云端用户账号 API（桌面端前端）
 *
 * 对接 Rust 侧 auth_commands.rs，经 Tauri invokeTyped 安全调用：
 * - 密码 / 邮件验证码登录，注册，找回 / 修改密码（先验证码、后设密码），注销账号
 * - 会话快照查询与 Token 静默续期
 * - 账号资料（昵称 / 简介 / 头像）与登录会话管理
 * - 账号内在线设备列表（中继在线状态）
 *
 * 失败统一抛 AuthApiError（携带 kind）：界面按 kind 走 i18n 文案，
 * 仅 kind=rejected 时 message 为账号中心返回的业务文案，可直接展示。
 */
import {
  invokeTyped,
  type InvokeError,
  type InvokeMissing,
  type InvokeTypedResult,
} from './tauriInvoke';
import { logInternalError } from './userFacingErrors';

/** 账号中心公开地址（头像等相对路径的解析基准）。 */
export const AUTH_BASE_URL = 'https://auth.flowbit.me';

export interface UserProfile {
  id: string;
  email: string;
  name?: string | null;
}

export interface SessionSnapshot {
  is_logged_in: boolean;
  user: UserProfile | null;
  access_token: string | null;
  expires_at_ms: number | null;
}

export interface CloudDeviceItem {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: number;
  trusted: boolean;
  metadata?: Record<string, unknown>;
}

export type EmailCodeScene = 'login' | 'register' | 'reset';

export interface EmailCodeTicket {
  ok: boolean;
  expiresIn: number;
  /** 发码冷却剩余秒数（新版账号中心返回；旧接口可能缺失） */
  resendAfter?: number;
  devCode?: string;
}

export interface AccountProfile {
  accountId: string;
  email?: string | null;
  displayName: string;
  avatarUrl?: string | null;
  avatarFileId?: string | null;
  bio: string;
  profileUpdatedAt?: number | null;
}

export interface AuthSessionInfo {
  id: string;
  deviceId: string;
  userAgent: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  current: boolean;
}

/**
 * 账号操作失败分类：
 * - unavailable：命令未注册 / 非 Tauri 环境 / 后端尚无对应接口
 * - rejected：账号中心业务拒绝（Rust InvalidInput，含登录态失效）
 * - network：网络不可达（Rust Io）
 * - failed：其它内部错误
 */
export type AuthFailureKind = 'unavailable' | 'rejected' | 'network' | 'failed';

export class AuthApiError extends Error {
  readonly kind: AuthFailureKind;

  constructor(kind: AuthFailureKind, message: string) {
    super(message);
    this.name = 'AuthApiError';
    this.kind = kind;
  }
}

/** Rust CoreError kind → 失败分类，并记录内部日志 */
function toAuthError(
  command: string,
  res: InvokeMissing | InvokeError
): AuthApiError {
  if (res.status === 'missing') {
    logInternalError(command, `${command} missing`);
    return new AuthApiError('unavailable', `${command} missing`);
  }
  logInternalError(command, `${command} ${res.kind}: ${res.message}`);
  if (res.kind === 'InvalidInput')
    return new AuthApiError('rejected', res.message);
  if (res.kind === 'Io') return new AuthApiError('network', res.message);
  return new AuthApiError('failed', res.message);
}

/** 成功取数据，失败抛 AuthApiError */
function unwrap<T>(command: string, res: InvokeTypedResult<T>): T {
  if (res.status === 'ok') return res.data;
  throw toAuthError(command, res);
}

export async function authLogin(
  email: string,
  password: string
): Promise<UserProfile> {
  return unwrap(
    'auth_login',
    await invokeTyped<UserProfile>('auth_login', { email, password })
  );
}

export async function authRequestEmailCode(
  scene: EmailCodeScene,
  email: string,
  password?: string
): Promise<EmailCodeTicket> {
  return unwrap(
    'auth_request_email_code',
    await invokeTyped<EmailCodeTicket>('auth_request_email_code', {
      scene,
      email,
      ...(password ? { password } : {}),
    })
  );
}

export async function authConfirmEmailCode(
  scene: EmailCodeScene,
  email: string,
  code: string
): Promise<UserProfile> {
  return unwrap(
    'auth_confirm_email_code',
    await invokeTyped<UserProfile>('auth_confirm_email_code', {
      scene,
      email,
      code,
    })
  );
}

export async function authGetProfile(): Promise<AccountProfile> {
  return unwrap(
    'auth_get_profile',
    await invokeTyped<AccountProfile>('auth_get_profile', {})
  );
}

export async function authUpdateProfile(input: {
  displayName?: string;
  bio?: string;
}): Promise<AccountProfile> {
  return unwrap(
    'auth_update_profile',
    await invokeTyped<AccountProfile>('auth_update_profile', {
      displayName: input.displayName,
      bio: input.bio,
    })
  );
}

export async function authUploadAvatar(
  dataUrl: string,
  fileName?: string
): Promise<AccountProfile> {
  return unwrap(
    'auth_upload_avatar',
    await invokeTyped<AccountProfile>('auth_upload_avatar', {
      dataUrl,
      fileName,
    })
  );
}

export async function authListSessions(): Promise<AuthSessionInfo[]> {
  return unwrap(
    'auth_list_sessions',
    await invokeTyped<AuthSessionInfo[]>('auth_list_sessions', {})
  );
}

export async function authRevokeSession(sessionId: string): Promise<boolean> {
  return unwrap(
    'auth_revoke_session',
    await invokeTyped<boolean>('auth_revoke_session', { sessionId })
  );
}

/** 注销账号：服务端校验确认邮箱后匿名化账号并吊销全部会话。 */
export async function authDeleteAccount(confirmEmail: string): Promise<void> {
  return unwrap(
    'auth_delete_account',
    await invokeTyped<void>('auth_delete_account', { confirmEmail })
  );
}

/** 先码后密码的场景：注册设置密码 / 找回或修改密码 */
export type PasswordCodeScene = Extract<EmailCodeScene, 'register' | 'reset'>;

/** 先码后密码 · 发送验证码（只带 email，不带密码）。 */
export async function authRequestPasswordCode(input: {
  scene: PasswordCodeScene;
  email: string;
}): Promise<EmailCodeTicket> {
  return unwrap(
    'auth_request_password_code',
    await invokeTyped<EmailCodeTicket>('auth_request_password_code', {
      scene: input.scene,
      email: input.email,
    })
  );
}

/** 先码后密码 · 凭验证码设置密码（成功后建立会话；已登录改密保留当前会话）。 */
export async function authSetPasswordWithCode(input: {
  scene: PasswordCodeScene;
  email: string;
  code: string;
  password: string;
}): Promise<UserProfile> {
  return unwrap(
    'auth_set_password_with_code',
    await invokeTyped<UserProfile>('auth_set_password_with_code', {
      scene: input.scene,
      email: input.email,
      code: input.code,
      password: input.password,
    })
  );
}

export async function authLogout(): Promise<boolean> {
  const res = await invokeTyped<void>('auth_logout', {});
  if (res.status === 'ok') return true;
  toAuthError('auth_logout', res);
  return false;
}

export async function authGetSession(): Promise<SessionSnapshot | null> {
  const res = await invokeTyped<SessionSnapshot>('auth_get_session', {});
  if (res.status === 'ok') return res.data;
  toAuthError('auth_get_session', res);
  return null;
}

export async function authRefreshToken(): Promise<boolean> {
  const res = await invokeTyped<boolean>('auth_refresh_token', {});
  if (res.status === 'ok') return res.data;
  toAuthError('auth_refresh_token', res);
  return false;
}

export async function authListDevices(): Promise<CloudDeviceItem[]> {
  const res = await invokeTyped<CloudDeviceItem[]>('auth_list_devices', {});
  if (res.status === 'ok') return res.data;
  toAuthError('auth_list_devices', res);
  return [];
}
