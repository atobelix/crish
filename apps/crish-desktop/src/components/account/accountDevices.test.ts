import { describe, expect, it } from 'vitest';
import type { AuthSessionInfo, CloudDeviceItem } from '../../api/authApi';
import { buildDeviceRows, toMillis } from './accountDevices';

const session = (patch: Partial<AuthSessionInfo>): AuthSessionInfo => ({
  id: 's',
  deviceId: 'd',
  userAgent: '',
  ip: '127.0.0.1',
  createdAt: 1_700_000_000,
  expiresAt: 1_800_000_000,
  revoked: false,
  current: false,
  ...patch,
});

const device = (patch: Partial<CloudDeviceItem>): CloudDeviceItem => ({
  id: 'd',
  name: 'Device',
  platform: 'windows',
  lastSeenAt: 1_760_000_000_000,
  trusted: true,
  ...patch,
});

describe('buildDeviceRows 登录设备拼装与识别决策', () => {
  it('过滤已吊销会话，本机置顶，在线优先', () => {
    const rows = buildDeviceRows(
      [
        session({
          id: 'old',
          deviceId: 'mac',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          createdAt: 1_600_000_000,
        }),
        session({ id: 'gone', revoked: true }),
        session({ id: 'phone', deviceId: 'p1' }),
        session({
          id: 'self',
          deviceId: 'self',
          userAgent:
            'Crish/1.0 (Windows NT 10.0; Win64; x64) Desktop/DESKTOP-MYPC',
          deviceName: 'DESKTOP-MYPC · Windows 11',
          current: true,
        }),
      ],
      [device({ id: 'p1', name: 'iPhone 15 Pro', platform: 'ios' })]
    );

    expect(rows.map((row) => row.sessionId)).toEqual(['self', 'phone', 'old']);
    expect(rows[0].current).toBe(true);
    expect(rows[0].online).toBe(true);
    expect(rows[0].name).toContain('DESKTOP-MYPC');
    expect(rows[1].online).toBe(true);
    expect(rows[2].online).toBe(false);
  });

  it('单部手机显示系列，同系列多部手机时升级显示具体型号', () => {
    const rows = buildDeviceRows(
      [
        session({
          id: 'p1',
          deviceId: 'p1',
          deviceName: 'iPhone 15 Pro',
          userAgent: 'iPhone16,1',
        }),
        session({
          id: 'p2',
          deviceId: 'p2',
          deviceName: 'iPhone 13',
          userAgent: 'iPhone14,5',
        }),
      ],
      []
    );

    // 重复系列升级为具体型号
    expect(rows[0].name).toBe('iPhone 15 Pro');
    expect(rows[1].name).toBe('iPhone 13');
  });

  it('toMillis 兼容秒与毫秒', () => {
    expect(toMillis(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMillis(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});
