// 登录设备行拼装（与桌面端 apps/crish-desktop/src/components/account/
// accountDevices.ts 的 buildDeviceRows 同构，2026-11-03）：
// 整合账号会话（/api/auth/sessions）与中继在线设备目录（GET /v1/devices，
// 仅在线桌面），经 deviceIdentity 解析命名——电脑显示「计算机名 · 系统」，
// 手机显示系列（同系列多型号并存时升级为具体型号）；在线 = 本机会话或
// 设备在在线目录中；排序 = 本机置顶 → 在线优先 → 最近活跃倒序。
// 与桌面的唯一数据面差异：移动端在线目录只含中继桌面（fetchAccountDevices
// 按 platform==='desktop' 过滤），故非桌面会话除本机外一律按离线呈现——
// 桌面 auth_list_devices 同为中继设备目录，口径实际一致。
import type { AccountDevice, AccountSessionInfo } from '@/domain/types/account';
import {
  resolveDeviceDisplayNames,
  type DeviceCategory,
  type ParsedDeviceInfo,
} from './deviceIdentity';

export type SessionDeviceKind = DeviceCategory;

export interface SessionDeviceRow {
  sessionId: string;
  deviceId: string;
  /** 设备展示名（经智能解析与判重升级决策后） */
  name: string;
  kind: SessionDeviceKind;
  current: boolean;
  online: boolean;
  /** 最近活跃时间（毫秒） */
  lastActiveAt: number;
  /** 深度解析后的设备元数据 */
  parsed: ParsedDeviceInfo;
}

/** 后端时间戳单位不统一：小于 1e12 视为秒（与桌面 toMillis 同口径） */
export function toMillis(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

export function buildSessionDeviceRows(
  sessions: readonly AccountSessionInfo[],
  devices: readonly AccountDevice[] = []
): SessionDeviceRow[] {
  const deviceById = new Map(devices.map((device) => [device.id, device]));

  // 1. 过滤有效会话并构建中间对象
  const rawRows = sessions
    .filter((session) => !session.revoked)
    .map((session) => {
      const device = deviceById.get(session.deviceId);
      const name = session.deviceName || device?.name || '';
      return {
        sessionId: session.id,
        deviceId: session.deviceId,
        name,
        userAgent: session.userAgent,
        platform: device?.platform,
        current: session.current,
        // 在线目录只含在线设备（不含本机），本机会话恒为在线
        online: session.current || device !== undefined,
        lastActiveAt: toMillis(device?.lastSeenAt ?? session.createdAt),
      };
    });

  // 2. 传入 deviceIdentity 进行全局判重与命名决策
  const resolved = resolveDeviceDisplayNames(rawRows);

  // 3. 映射为标准行
  const rows: SessionDeviceRow[] = resolved.map((item) => ({
    sessionId: item.sessionId,
    deviceId: item.deviceId,
    name: item.parsed.displayName,
    kind: item.parsed.category,
    current: item.current,
    online: item.online,
    lastActiveAt: item.lastActiveAt,
    parsed: item.parsed,
  }));

  // 4. 排序：本机置顶，在线优先，随后按活跃时间倒序
  return rows.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
}
