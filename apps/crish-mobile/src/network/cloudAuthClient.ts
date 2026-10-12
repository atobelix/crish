/**
 * 云端账号服务与中继票据客户端（移动端）（audit-repair-202609 · T14 对齐）
 *
 * 服务端契约（2026-09-06 经 Tailscale SSH 核对 flowbit-auth 生产部署 dist
 * 代码后钉死，修改前必须重新核对，禁止凭记忆或猜测）：
 * - `POST /api/auth/email/login/password`
 *   → 200 `{ accessToken, refreshToken, user: { id, accountId, nickname, email, ... } }`
 * - `GET /api/devices`（Bearer）→ 200 `{ items: [...] }`
 *   （历史版本误用 `/api/auth/devices` —— 生产实测 404，已修正）
 * - `GET /api/auth/me`（Bearer）→ 200 `{ user: {...} }`
 * - `POST /api/relay/ticket/client` —— **服务端尚未实现**（生产实测 404）。
 *   错误如实上抛；禁止伪造 relayUrl / lastSeenAt / 默认用户 ID 等兜底假数据。
 *
 * Base URL 可经构造参数覆盖；缺省生产地址。
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
  /** 服务端缺省时为 0（未知），UI 须显示「未知」而非伪造当前时间 */
  lastSeenAt: number;
  trusted: boolean;
}

export interface ClientRelayTicket {
  ticket: string;
  relayUrl: string;
  exp: number;
}

/** 从服务端 user 对象解析档案；`id` 与 `email` 缺失 = 契约破坏，直接报错 */
function parseProfile(
  user: unknown,
  _fallbackEmail: string
): MobileUserProfile {
  const u = (user ?? {}) as Record<string, unknown>;
  const id = typeof u.id === 'string' && u.id ? u.id : undefined;
  const email = typeof u.email === 'string' && u.email ? u.email : undefined;
  if (!id) {
    throw new Error('登录响应缺少 user.id（契约破坏）');
  }
  if (!email) {
    throw new Error('登录响应缺少 user.email（契约破坏）');
  }
  const name =
    typeof u.nickname === 'string' && u.nickname
      ? u.nickname
      : typeof u.name === 'string'
        ? u.name
        : undefined;
  return { id, email, name };
}

export class CloudAuthClient {
  constructor(private readonly baseUrl = DEFAULT_AUTH_URL) {}

  /** 账号密码登录（refreshToken / user.id 缺失一律报错，禁止回退伪造） */
  async login(
    email: string,
    pass: string
  ): Promise<{
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
      throw new Error(
        `登录失败 (${res.status}): ${text || '用户名或密码错误'}`
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    const accessToken =
      typeof data.accessToken === 'string' && data.accessToken
        ? data.accessToken
        : undefined;
    const refreshToken =
      typeof data.refreshToken === 'string' && data.refreshToken
        ? data.refreshToken
        : undefined;
    if (!accessToken) {
      throw new Error('登录响应缺少 accessToken（契约破坏）');
    }
    if (!refreshToken) {
      throw new Error('登录响应缺少 refreshToken（契约破坏）');
    }
    const user = parseProfile(data.user, email);

    return { accessToken, refreshToken, user };
  }

  /** 获取名下已绑定的设备列表（`GET /api/devices` → `{ items }`，服务端已核对） */
  async listDevices(accessToken: string): Promise<MobileCloudDevice[]> {
    const res = await fetch(`${this.baseUrl}/api/devices`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      // 401 = 登录态失效，其余为网络/服务端错误——原样上抛，不静默吞掉
      throw new Error(`获取设备列表失败 (${res.status})`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const list = Array.isArray(data.items) ? data.items : [];
    return list
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
      .filter((d) => typeof d.id === 'string' && d.id)
      .map((d) => ({
        id: d.id as string,
        name:
          typeof d.name === 'string' && d.name
            ? d.name
            : typeof d.label === 'string' && d.label
              ? d.label
              : '电脑',
        platform:
          typeof d.platform === 'string' && d.platform ? d.platform : 'desktop',
        // 缺失 = 未知（0），绝不伪造 Date.now()
        lastSeenAt:
          typeof d.lastSeenAt === 'number'
            ? d.lastSeenAt
            : typeof d.last_seen_at === 'number'
              ? d.last_seen_at
              : 0,
        trusted: Boolean(d.trusted),
      }));
  }

  /**
   * 申请访问指定桌面端 Client 票据。
   * **诚实边界**：生产 auth 服务尚未实现该路由（404），错误如实上抛。
   */
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

    const data = (await res.json()) as Record<string, unknown>;
    const ticket =
      typeof data.ticket === 'string' && data.ticket ? data.ticket : undefined;
    const relayUrl =
      typeof data.relayUrl === 'string' && data.relayUrl
        ? data.relayUrl
        : undefined;
    if (!ticket || !relayUrl) {
      throw new Error('中继票据响应缺少 ticket/relayUrl（契约破坏）');
    }
    return {
      ticket,
      relayUrl,
      exp: typeof data.exp === 'number' ? data.exp : 0,
    };
  }
}
