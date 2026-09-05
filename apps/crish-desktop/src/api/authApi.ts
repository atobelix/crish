/**
 * 云端用户账号与多端中继桥接 API（桌面端前端）
 *
 * 对接 Rust 侧 auth_commands.rs，经 Tauri invokeTyped 安全调用：
 * - 账号密码登录与登出
 * - 会话快照查询与 Token 静默续期
 * - 在线/信任设备列表获取与远程踢出
 * - Host 驻留中继票据申请
 */
import { invokeTyped } from './tauriInvoke';
import { logInternalError } from './userFacingErrors';

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

export interface RelayTicketResponse {
  ticket: string;
  relayUrl: string;
  exp: number;
}

export async function authLogin(email: string, password: string): Promise<UserProfile> {
  const res = await invokeTyped<UserProfile>('auth_login', { email, password });
  if (res.status === 'ok') return res.data;
  logInternalError('authLogin', `auth_login ${res.status === 'missing' ? 'missing' : res.message}`);
  throw new Error(res.status === 'missing' ? '账号功能未就绪' : res.message);
}

export async function authLogout(): Promise<boolean> {
  const res = await invokeTyped<void>('auth_logout', {});
  if (res.status === 'ok') return true;
  logInternalError('authLogout', `auth_logout ${res.status === 'missing' ? 'missing' : res.message}`);
  return false;
}

export async function authGetSession(): Promise<SessionSnapshot | null> {
  const res = await invokeTyped<SessionSnapshot>('auth_get_session', {});
  if (res.status === 'ok') return res.data;
  logInternalError('authGetSession', `auth_get_session ${res.status === 'missing' ? 'missing' : res.message}`);
  return null;
}

export async function authRefreshToken(): Promise<boolean> {
  const res = await invokeTyped<boolean>('auth_refresh_token', {});
  if (res.status === 'ok') return res.data;
  logInternalError('authRefreshToken', `auth_refresh_token ${res.status === 'missing' ? 'missing' : res.message}`);
  return false;
}

export async function authListDevices(): Promise<CloudDeviceItem[]> {
  const res = await invokeTyped<CloudDeviceItem[]>('auth_list_devices', {});
  if (res.status === 'ok') return res.data;
  logInternalError('authListDevices', `auth_list_devices ${res.status === 'missing' ? 'missing' : res.message}`);
  return [];
}

export async function authRevokeDevice(deviceId: string): Promise<boolean> {
  const res = await invokeTyped<void>('auth_revoke_device', { deviceId });
  if (res.status === 'ok') return true;
  logInternalError('authRevokeDevice', `auth_revoke_device ${res.status === 'missing' ? 'missing' : res.message}`);
  return false;
}

export async function authGetRelayTicket(deviceId: string): Promise<RelayTicketResponse | null> {
  const res = await invokeTyped<RelayTicketResponse>('auth_get_relay_ticket', { deviceId });
  if (res.status === 'ok') return res.data;
  logInternalError('authGetRelayTicket', `auth_get_relay_ticket ${res.status === 'missing' ? 'missing' : res.message}`);
  return null;
}
