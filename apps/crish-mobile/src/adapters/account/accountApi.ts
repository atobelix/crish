// 云端账号与远程中继 HTTP 客户端（移动端）。
// 只使用原生 fetch；token 只放 Authorization 头，不进 URL。

import type {
  AccountDevice,
  AccountProfile,
  AccountSessionInfo,
  AccountUser,
  EmailCodeScene,
} from '@/domain/types/account';

const AUTH_BASE_URL =
  process.env.EXPO_PUBLIC_AUTH_BASE_URL?.replace(/\/+$/, '') ||
  'https://auth.flowbit.me';
const RELAY_BASE_URL =
  process.env.EXPO_PUBLIC_RELAY_BASE_URL?.replace(/\/+$/, '') ||
  'https://proxy.flowbit.me:8443';

const REQUEST_TIMEOUT_MS = 12_000;

export class AccountApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 限流类错误（429）服务端建议的等待秒数 */
  readonly retryAfter?: number;
  constructor(
    status: number,
    code: string,
    message: string,
    retryAfter?: number
  ) {
    super(message);
    this.name = 'AccountApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface AccountTokenPair {
  accessToken: string;
  refreshToken: string;
  user: AccountUser | null;
}

export interface ClientTicket {
  ticket: string;
  relayUrl: string;
  exp: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
  baseUrl?: string;
}

async function requestJson<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${options.baseUrl ?? AUTH_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const record =
        body && typeof body === 'object'
          ? (body as Record<string, unknown>)
          : {};
      // 账号中心错误体 `{ statusCode, code, error, message }`：`code` 才可分支，
      // `error` 只是 HTTP 原因短语；旧接口缺 code 时退回 error。
      const code =
        typeof record['code'] === 'string'
          ? record['code']
          : typeof record['error'] === 'string'
            ? record['error']
            : `http_${response.status}`;
      const message =
        typeof record['message'] === 'string' && record['message'].trim() !== ''
          ? record['message']
          : code;
      const retryAfter =
        typeof record['retryAfter'] === 'number'
          ? record['retryAfter']
          : undefined;
      throw new AccountApiError(response.status, code, message, retryAfter);
    }
    return body as T;
  } catch (error) {
    if (error instanceof AccountApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AccountApiError(0, 'timeout', '网络超时，请稍后重试');
    }
    throw new AccountApiError(
      0,
      'network',
      error instanceof Error ? error.message : '网络请求失败'
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseUser(value: unknown): AccountUser | null {
  if (!value || typeof value !== 'object') return null;
  const user = value as Record<string, unknown>;
  const source =
    user['user'] && typeof user['user'] === 'object'
      ? (user['user'] as Record<string, unknown>)
      : user;
  const id =
    typeof source['id'] === 'string'
      ? source['id']
      : typeof source['accountId'] === 'string'
        ? source['accountId']
        : null;
  const email = typeof source['email'] === 'string' ? source['email'] : null;
  if (!id || !email) return null;
  const name =
    typeof source['nickname'] === 'string'
      ? source['nickname']
      : typeof source['name'] === 'string'
        ? source['name']
        : null;
  return { id, email, name };
}

/**
 * 解析 token 对。
 *
 * `fallbackRefreshToken`：刷新场景下服务端可能只轮换 accessToken，不返回新的
 * refreshToken——此时沿用调用方持有的旧值。登录场景不传，缺 refreshToken 即
 * 判定为异常响应。
 */
function parseTokenPair(
  value: unknown,
  fallbackRefreshToken?: string
): AccountTokenPair {
  if (!value || typeof value !== 'object') {
    throw new AccountApiError(0, 'bad_response', '登录响应格式异常');
  }
  const record = value as Record<string, unknown>;
  const accessToken =
    typeof record['accessToken'] === 'string' ? record['accessToken'] : null;
  const rawRefreshToken =
    typeof record['refreshToken'] === 'string' ? record['refreshToken'] : '';
  const refreshToken =
    rawRefreshToken !== '' ? rawRefreshToken : fallbackRefreshToken;
  if (!accessToken || !refreshToken) {
    throw new AccountApiError(0, 'bad_response', '登录凭据缺失');
  }
  return {
    accessToken,
    refreshToken,
    user: parseUser(record),
  };
}

export async function loginAccount(
  email: string,
  password: string,
  deviceId: string,
  deviceName?: string
): Promise<AccountTokenPair> {
  const body = await requestJson<unknown>('/api/auth/email/login/password', {
    method: 'POST',
    body: {
      email: email.trim(),
      password,
      deviceId,
      ...(deviceName ? { deviceName } : {}),
    },
  });
  return parseTokenPair(body);
}

export async function refreshAccount(
  refreshToken: string
): Promise<AccountTokenPair> {
  const body = await requestJson<unknown>('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });
  // 服务端可能只轮换 accessToken：未返回新 refreshToken 时沿用旧值。
  return parseTokenPair(body, refreshToken);
}

export async function logoutAccountSession(
  refreshToken: string
): Promise<void> {
  await requestJson<unknown>('/api/auth/logout', {
    method: 'POST',
    body: { refreshToken },
  });
}

export async function fetchAccountMe(token: string): Promise<AccountUser> {
  const body = await requestJson<unknown>('/api/auth/me', { token });
  const user = parseUser(body);
  if (!user) {
    throw new AccountApiError(0, 'bad_response', '账号资料缺失');
  }
  return user;
}

/** 中继在线 host 设备发现（`GET /v1/devices`；只返回当前在线桌面）。 */
export async function fetchRelayDevices(
  token: string
): Promise<AccountDevice[]> {
  const body = await requestJson<unknown>('/v1/devices', {
    token,
    baseUrl: RELAY_BASE_URL,
  });
  const items =
    body &&
    typeof body === 'object' &&
    Array.isArray((body as Record<string, unknown>)['items'])
      ? ((body as Record<string, unknown>)['items'] as unknown[])
      : [];
  const now = Date.now();
  return items.flatMap((item): AccountDevice[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : null;
    if (!id) return [];
    if (record['platform'] !== 'desktop') return [];
    const lastSeenAt =
      typeof record['lastSeenAt'] === 'number' ? record['lastSeenAt'] : now;
    return [
      {
        id,
        name:
          typeof record['name'] === 'string' && record['name'].trim() !== ''
            ? record['name']
            : id,
        platform:
          typeof record['platform'] === 'string'
            ? record['platform']
            : 'desktop',
        lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : now,
        online: record['online'] !== false,
      },
    ];
  });
}

export interface EmailCodeTicket {
  ok: boolean;
  expiresIn: number;
  resendAfter?: number;
  devCode?: string;
}

/** 统一邮箱入口：服务端决定走登录码还是注册码。 */
export interface ContinueEmailTicket {
  ok: boolean;
  expiresIn: number;
  resendAfter?: number;
  isNewUser: boolean;
  hasPassword: boolean;
  devCode?: string;
}

export type EmailContinueOutcome =
  | { kind: 'signed_in'; session: AccountTokenPair }
  | { kind: 'password_required'; setupToken: string };

export async function continueEmail(
  email: string
): Promise<ContinueEmailTicket> {
  const body = await requestJson<unknown>('/api/auth/email/continue', {
    method: 'POST',
    body: { email: email.trim() },
  });
  if (!body || typeof body !== 'object') {
    throw new AccountApiError(0, 'bad_response', '验证码响应格式异常');
  }
  const record = body as Record<string, unknown>;
  return {
    ok: record['ok'] === true,
    expiresIn:
      typeof record['expiresIn'] === 'number' ? record['expiresIn'] : 0,
    ...(typeof record['resendAfter'] === 'number'
      ? { resendAfter: record['resendAfter'] }
      : {}),
    isNewUser: record['isNewUser'] === true,
    hasPassword: record['hasPassword'] !== false,
    ...(typeof record['devCode'] === 'string'
      ? { devCode: record['devCode'] }
      : {}),
  };
}

/** 统一邮箱入口 · 确认验证码：已有账号直接登录，新账号返回 setupToken。 */
export async function confirmEmailContinue(
  email: string,
  code: string,
  deviceId: string,
  deviceName?: string
): Promise<EmailContinueOutcome> {
  const body = await requestJson<unknown>('/api/auth/email/continue/confirm', {
    method: 'POST',
    body: {
      email: email.trim(),
      code: code.trim(),
      deviceId,
      ...(deviceName ? { deviceName } : {}),
    },
  });
  if (!body || typeof body !== 'object') {
    throw new AccountApiError(0, 'bad_response', '登录响应格式异常');
  }
  const record = body as Record<string, unknown>;
  if (record['status'] === 'password_required') {
    const setupToken =
      typeof record['setupToken'] === 'string' ? record['setupToken'] : null;
    if (!setupToken) {
      throw new AccountApiError(0, 'bad_response', '设置凭据缺失');
    }
    return { kind: 'password_required', setupToken };
  }
  return { kind: 'signed_in', session: parseTokenPair(body) };
}

/** 校验验证码换取 setupToken（注册 / 重置场景）。 */
export async function verifyEmailCode(
  email: string,
  code: string,
  scene: 'register' | 'reset_password'
): Promise<string> {
  const body = await requestJson<unknown>('/api/auth/email/code/verify', {
    method: 'POST',
    body: { email: email.trim(), code: code.trim(), scene },
  });
  const setupToken =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>)['setupToken']
      : null;
  if (typeof setupToken !== 'string' || setupToken === '') {
    throw new AccountApiError(0, 'bad_response', '设置凭据缺失');
  }
  return setupToken;
}

/** 凭 setupToken 设置密码并建立会话（注册 / 重置）。 */
export async function setAccountPassword(
  setupToken: string,
  password: string,
  deviceId: string,
  deviceName?: string
): Promise<AccountTokenPair> {
  const body = await requestJson<unknown>('/api/auth/email/password/set', {
    method: 'POST',
    body: {
      setupToken,
      password,
      deviceId,
      ...(deviceName ? { deviceName } : {}),
    },
  });
  return parseTokenPair(body);
}

/** 已登录修改密码 · 发送验证码。 */
export async function requestPasswordChangeCode(
  token: string
): Promise<EmailCodeTicket> {
  const body = await requestJson<unknown>('/api/auth/password/change/request', {
    method: 'POST',
    token,
    body: {},
  });
  if (!body || typeof body !== 'object') {
    throw new AccountApiError(0, 'bad_response', '验证码响应格式异常');
  }
  const record = body as Record<string, unknown>;
  return {
    ok: record['ok'] === true,
    expiresIn:
      typeof record['expiresIn'] === 'number' ? record['expiresIn'] : 0,
    ...(typeof record['resendAfter'] === 'number'
      ? { resendAfter: record['resendAfter'] }
      : {}),
    ...(typeof record['devCode'] === 'string'
      ? { devCode: record['devCode'] }
      : {}),
  };
}

/** 已登录修改密码 · 凭验证码提交新密码（撤销其他会话，保留当前会话）。 */
export async function changeAccountPassword(
  token: string,
  code: string,
  newPassword: string
): Promise<void> {
  await requestJson<unknown>('/api/auth/password/change/confirm', {
    method: 'POST',
    token,
    body: { code: code.trim(), newPassword, revokeOtherSessions: true },
  });
}

/** 注销账号（服务端校验确认邮箱；成功后账号匿名化并吊销全部会话）。 */
export async function deleteAccountRemote(
  token: string,
  confirmEmail: string
): Promise<void> {
  await requestJson<unknown>('/api/auth/account/delete', {
    method: 'POST',
    token,
    body: { confirmEmail: confirmEmail.trim() },
  });
}

const CODE_REQUEST_PATHS: Record<EmailCodeScene, string> = {
  login: '/api/auth/email/login/code/request',
  register: '/api/auth/email/register/request',
  reset: '/api/auth/email/password/reset/request',
};

export async function requestEmailCode(
  scene: EmailCodeScene,
  email: string,
  password?: string
): Promise<EmailCodeTicket> {
  const body = await requestJson<unknown>(CODE_REQUEST_PATHS[scene], {
    method: 'POST',
    body: { email: email.trim(), ...(password ? { password } : {}) },
  });
  if (!body || typeof body !== 'object') {
    throw new AccountApiError(0, 'bad_response', '验证码响应格式异常');
  }
  const record = body as Record<string, unknown>;
  return {
    ok: record['ok'] === true,
    expiresIn:
      typeof record['expiresIn'] === 'number' ? record['expiresIn'] : 0,
    ...(typeof record['resendAfter'] === 'number'
      ? { resendAfter: record['resendAfter'] }
      : {}),
    ...(typeof record['devCode'] === 'string'
      ? { devCode: record['devCode'] }
      : {}),
  };
}

function parseProfile(value: unknown): AccountProfile {
  if (!value || typeof value !== 'object') {
    throw new AccountApiError(0, 'bad_response', '账号资料格式异常');
  }
  const record = value as Record<string, unknown>;
  const accountId =
    typeof record['accountId'] === 'string' ? record['accountId'] : null;
  if (!accountId) {
    throw new AccountApiError(0, 'bad_response', '账号资料缺失');
  }
  return {
    accountId,
    email: typeof record['email'] === 'string' ? record['email'] : null,
    displayName:
      typeof record['displayName'] === 'string' ? record['displayName'] : '',
    avatarUrl:
      typeof record['avatarUrl'] === 'string' ? record['avatarUrl'] : null,
    avatarFileId:
      typeof record['avatarFileId'] === 'string'
        ? record['avatarFileId']
        : null,
    bio: typeof record['bio'] === 'string' ? record['bio'] : '',
    profileUpdatedAt:
      typeof record['profileUpdatedAt'] === 'number'
        ? record['profileUpdatedAt']
        : null,
  };
}

export async function fetchAccountProfile(
  token: string
): Promise<AccountProfile> {
  return parseProfile(
    await requestJson<unknown>('/api/auth/profile', { token })
  );
}

export async function updateAccountProfile(
  token: string,
  input: { displayName?: string; bio?: string }
): Promise<AccountProfile> {
  return parseProfile(
    await requestJson<unknown>('/api/auth/profile', {
      method: 'PATCH',
      token,
      body: input,
    })
  );
}

export async function uploadAccountAvatar(
  token: string,
  dataUrl: string,
  fileName?: string
): Promise<AccountProfile> {
  return parseProfile(
    await requestJson<unknown>('/api/auth/profile/avatar', {
      method: 'POST',
      token,
      body: { dataUrl, fileName },
    })
  );
}

export async function fetchAccountSessions(
  token: string
): Promise<AccountSessionInfo[]> {
  const body = await requestJson<unknown>('/api/auth/sessions', { token });
  const items =
    body &&
    typeof body === 'object' &&
    Array.isArray((body as Record<string, unknown>)['sessions'])
      ? ((body as Record<string, unknown>)['sessions'] as unknown[])
      : [];
  return items.flatMap((item): AccountSessionInfo[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : null;
    if (!id) return [];
    return [
      {
        id,
        deviceId:
          typeof record['deviceId'] === 'string' ? record['deviceId'] : '',
        userAgent:
          typeof record['userAgent'] === 'string' ? record['userAgent'] : '',
        ip: typeof record['ip'] === 'string' ? record['ip'] : '',
        createdAt:
          typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
        expiresAt:
          typeof record['expiresAt'] === 'number' ? record['expiresAt'] : 0,
        revoked: record['revoked'] === true,
        current: record['current'] === true,
      },
    ];
  });
}

export async function revokeAccountSession(
  token: string,
  sessionId: string
): Promise<void> {
  await requestJson<unknown>(
    `/api/auth/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', token }
  );
}

/** 账号头像 URL（后端返回相对路径）。 */
export function resolveAvatarUrl(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  return url.startsWith('http') ? url : `${AUTH_BASE_URL}${url}`;
}

export async function fetchClientTicket(
  token: string,
  deviceId: string,
  deviceName: string,
  targetDeviceId: string
): Promise<ClientTicket> {
  const body = await requestJson<unknown>('/v1/ticket/client', {
    method: 'POST',
    token,
    baseUrl: RELAY_BASE_URL,
    body: { deviceId, deviceName, targetDeviceId },
  });
  if (!body || typeof body !== 'object') {
    throw new AccountApiError(0, 'bad_response', '中继票据格式异常');
  }
  const record = body as Record<string, unknown>;
  const ticket = typeof record['ticket'] === 'string' ? record['ticket'] : null;
  const relayUrl =
    typeof record['relayUrl'] === 'string' ? record['relayUrl'] : null;
  const exp = typeof record['exp'] === 'number' ? record['exp'] : 0;
  if (!ticket || !relayUrl) {
    throw new AccountApiError(0, 'bad_response', '中继票据缺失');
  }
  return { ticket, relayUrl, exp };
}

export { AUTH_BASE_URL, RELAY_BASE_URL };
