/**
 * 登录设备列表的纯数据拼装：账号会话（auth_list_sessions）× 中继在线设备（auth_list_devices）。
 * 后端会话只带 deviceId / userAgent，没有设备名与平台字段，这里按 deviceId 关联在线设备补齐，
 * 关联不到时从 userAgent 粗略推断。
 */
import type { AuthSessionInfo, CloudDeviceItem } from '../../api/authApi';

export type AccountDeviceKind = 'desktop' | 'laptop' | 'phone';

export interface AccountDeviceRow {
  sessionId: string;
  /** 设备名；空串表示无法推断，由界面显示「未知设备」 */
  name: string;
  kind: AccountDeviceKind;
  current: boolean;
  online: boolean;
  /** 最近活跃时间（毫秒） */
  lastActiveAt: number;
}

/** 后端时间戳单位不统一：小于 1e12 视为秒 */
export function toMillis(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

const PHONE_PATTERN = /iphone|ipad|android|ios|mobile/i;
const LAPTOP_PATTERN = /mac|darwin|laptop/i;

function detectKind(hint: string): AccountDeviceKind {
  if (PHONE_PATTERN.test(hint)) return 'phone';
  if (LAPTOP_PATTERN.test(hint)) return 'laptop';
  return 'desktop';
}

const UA_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/iphone/i, 'iPhone'],
  [/ipad/i, 'iPad'],
  [/android/i, 'Android'],
  [/windows/i, 'Windows'],
  [/mac/i, 'macOS'],
  [/linux/i, 'Linux'],
];

function nameFromUserAgent(userAgent: string): string {
  const hit = UA_NAMES.find(([pattern]) => pattern.test(userAgent));
  return hit ? hit[1] : '';
}

export function buildDeviceRows(
  sessions: readonly AuthSessionInfo[],
  devices: readonly CloudDeviceItem[]
): AccountDeviceRow[] {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const rows = sessions
    .filter((session) => !session.revoked)
    .map((session): AccountDeviceRow => {
      const device = deviceById.get(session.deviceId);
      const hint = device
        ? `${device.platform} ${device.name}`
        : session.userAgent;
      return {
        sessionId: session.id,
        name: device?.name || nameFromUserAgent(session.userAgent),
        kind: detectKind(hint),
        current: session.current,
        // 中继设备列表只含在线设备（且不含本机），本机会话恒为在线
        online: session.current || device !== undefined,
        lastActiveAt: toMillis(device?.lastSeenAt ?? session.createdAt),
      };
    });
  return rows.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
}
