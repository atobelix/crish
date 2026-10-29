// 云端账号领域类型（UI / 账号服务 / 远程运行时共用；不感知 HTTP）。

export interface AccountUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AccountProfile {
  accountId: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  avatarFileId: string | null;
  bio: string;
  profileUpdatedAt: number | null;
}

export type EmailCodeScene = 'login' | 'register' | 'reset';

export interface AccountSessionInfo {
  id: string;
  deviceId: string;
  userAgent: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  current: boolean;
}

export interface AccountDevice {
  id: string;
  name: string;
  platform: string;
  /** 中继在线快照时刻（ms；仅在线设备会被发现） */
  lastSeenAt: number;
  /** 中继房间在线标记，UI 只读 */
  online: boolean;
}

export type AccountStatus =
  'unknown' | 'loggedOut' | 'loggingIn' | 'loggedIn' | 'error';

export interface AccountState {
  hydrated: boolean;
  status: AccountStatus;
  user: AccountUser | null;
  profile: AccountProfile | null;
  /** 仅内存保存，不持久化 access token；refresh token 在 SecureStore */
  accessToken: string | null;
  devices: AccountDevice[];
  targetDeviceId: string | null;
  error: string | null;
}
