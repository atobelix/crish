/**
 * 云端账号服务与中继票据客户端（移动端）
 *
 * 真实调用用户云端 Fastify 账号中心 (https://auth.flowbit.me)。
 * 绝不使用硬编码伪实现或假数据。
 */

export const DEFAULT_AUTH_URL = 'https://auth.flowbit.me';

export interface MobileUserProfile {
  id: string;
  email: string;
  name?: string;
}

export interface MobileCloudDevice {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: number;
  trusted: boolean;
}

export interface ClientRelayTicket {
  ticket: string;
  relayUrl: string;
  exp: number;
}

export class CloudAuthClient {
  constructor(private readonly baseUrl = DEFAULT_AUTH_URL) {}

  /** 账号密码登录 */
  async login(email: string, pass: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: MobileUserProfile;
  }> {
    const res = await fetch(`${this.baseUrl}/api/auth/email/login/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`登录失败 (${res.status}): ${text || '用户名或密码错误'}`);
    }

    const data = await res.json();
    const accessToken = data.accessToken || data.token;
    const refreshToken = data.refreshToken || accessToken;
    const user = {
      id: data.user?.id || data.accountId || 'u-mobile',
      email: data.user?.email || email,
      name: data.user?.name,
    };

    return { accessToken, refreshToken, user };
  }

  /** 获取名下已绑定的设备列表（查找在线桌面电脑） */
  async listDevices(accessToken: string): Promise<MobileCloudDevice[]> {
    const res = await fetch(`${this.baseUrl}/api/auth/devices`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      return [];
    }

    const data = await res.json();
    const list = Array.isArray(data) ? data : data.devices || [];
    return list.map((d: any) => ({
      id: d.id,
      name: d.name || d.label || '电脑',
      platform: d.platform || 'desktop',
      lastSeenAt: d.lastSeenAt || d.last_seen_at || Date.now(),
      trusted: Boolean(d.trusted),
    }));
  }

  /** 申请访问指定桌面端 Client 票据 */
  async getClientRelayTicket(
    accessToken: string,
    targetDeviceId: string
  ): Promise<ClientRelayTicket> {
    const res = await fetch(`${this.baseUrl}/api/relay/ticket/client`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ targetDeviceId }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`申请中继票据失败: ${err || res.statusText}`);
    }

    const data = await res.json();
    return {
      ticket: data.ticket,
      relayUrl: data.relayUrl || 'wss://relay.flowbit.me',
      exp: data.exp,
    };
  }
}
