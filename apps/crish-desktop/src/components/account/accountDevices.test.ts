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

describe('buildDeviceRows 登录设备拼装', () => {
  it('过滤已吊销会话，本机置顶，在线优先', () => {
    const rows = buildDeviceRows(
      [
        session({
          id: 'old',
          deviceId: 'mac',
          userAgent: 'Macintosh',
          createdAt: 1_600_000_000,
        }),
        session({ id: 'gone', revoked: true }),
        session({ id: 'phone', deviceId: 'p1' }),
        session({
          id: 'self',
          deviceId: 'self',
          userAgent: 'Windows NT 10.0',
          current: true,
        }),
      ],
      [device({ id: 'p1', name: 'iPhone 15 Pro', platform: 'ios' })]
    );

    expect(rows.map((row) => row.sessionId)).toEqual(['self', 'phone', 'old']);
    expect(rows[0]).toMatchObject({
      name: 'Windows',
      kind: 'desktop',
      online: true,
    });
    expect(rows[1]).toMatchObject({
      name: 'iPhone 15 Pro',
      kind: 'phone',
      online: true,
    });
    expect(rows[2]).toMatchObject({
      name: 'macOS',
      kind: 'laptop',
      online: false,
    });
    expect(rows[2].lastActiveAt).toBe(1_600_000_000_000);
  });

  it('无法推断设备名时返回空串', () => {
    const rows = buildDeviceRows([session({ userAgent: 'curl/8' })], []);
    expect(rows[0].name).toBe('');
  });

  it('toMillis 兼容秒与毫秒', () => {
    expect(toMillis(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMillis(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});
