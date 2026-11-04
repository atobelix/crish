/**
 * 登录设备与互通设备数据拼装
 *
 * 职责：
 * 整合账号会话（auth_list_sessions）与在线中继设备（auth_list_devices），
 * 经由 deviceIdentity 模块对设备进行识别与智能命名决策（电脑显示计算机名/系统，手机显示系列，同系列重复时细化型号）。
 */
import type { AuthSessionInfo, CloudDeviceItem } from '../../api/authApi';
import {
  resolveDeviceDisplayNames,
  type DeviceCategory,
  type ParsedDeviceInfo,
} from './deviceIdentity';

export type AccountDeviceKind = DeviceCategory;

export interface AccountDeviceRow {
  sessionId: string;
  deviceId: string;
  /** 设备展示名（经智能解析与判重升级决策后） */
  name: string;
  kind: AccountDeviceKind;
  current: boolean;
  online: boolean;
  /** 最近活跃时间（毫秒） */
  lastActiveAt: number;
  /** 深度解析后的设备元数据 */
  parsed: ParsedDeviceInfo;
}

/** 后端时间戳单位不统一：小于 1e12 视为秒 */
export function toMillis(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

export function buildDeviceRows(
  sessions: readonly AuthSessionInfo[],
  devices: readonly CloudDeviceItem[] = []
): AccountDeviceRow[] {
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
        // 中继设备列表只含在线设备（不含本机），本机会话恒为在线
        online: session.current || device !== undefined,
        lastActiveAt: toMillis(device?.lastSeenAt ?? session.createdAt),
      };
    });

  // 2. 传入 deviceIdentity 进行全局判重与命名决策
  const resolved = resolveDeviceDisplayNames(rawRows);

  // 3. 映射为标准的 AccountDeviceRow
  const rows: AccountDeviceRow[] = resolved.map((item) => ({
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
