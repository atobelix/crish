// 云端账号 store 测试（R4 批次4 收编版）：client 注入 / 令牌不进状态面 /
// login 成功与失败路径 / fetchDevices 桌面判定 / ticket 诚实上抛 / logout 清理
import {
  cloudAuthStore,
  configureCloudAuthClient,
  getCloudRefreshToken,
  pickOnlineDesktop,
} from './cloudAuthStore';
import type {
  CloudAuthClient,
  ClientRelayTicket,
  MobileCloudDevice,
} from '@/network/cloudAuthClient';

function makeDevice(overrides: Partial<MobileCloudDevice>): MobileCloudDevice {
  return {
    id: 'dev-1',
    name: '我的电脑',
    platform: 'windows',
    lastSeenAt: 0,
    trusted: true,
    ...overrides,
  };
}

/** fake 客户端（jest.fn 面，按用例改写行为） */
function makeFakeClient(): CloudAuthClient & {
  login: jest.Mock;
  listDevices: jest.Mock;
  getClientRelayTicket: jest.Mock;
} {
  return {
    login: jest.fn(async () => ({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      user: { id: 'u-1', email: 'a@b.c', name: 'A' },
    })),
    listDevices: jest.fn(async () => [makeDevice({})]),
    getClientRelayTicket: jest.fn(async (): Promise<ClientRelayTicket> => ({
      ticket: 't-1',
      relayUrl: 'wss://relay.example.me:8765',
      exp: 1_800_000,
    })),
  } as never;
}

function resetStore(): void {
  cloudAuthStore.setState({
    isLoggedIn: false,
    user: null,
    devices: [],
    onlineDesktop: null,
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  resetStore();
  configureCloudAuthClient(null); // 复位缺省（真实客户端不会被触网：无 token 时全部短路）
});

describe('pickOnlineDesktop（桌面端判定）', () => {
  it('platform 命中 desktop/windows/macos/linux 优先；无命中取首台；空列表 null', () => {
    const windows = makeDevice({ id: 'w', platform: 'Windows' });
    const phone = makeDevice({ id: 'p', platform: 'android' });
    expect(pickOnlineDesktop([phone, windows])?.id).toBe('w');
    expect(pickOnlineDesktop([phone])?.id).toBe('p');
    expect(pickOnlineDesktop([])).toBeNull();
  });
});

describe('cloudAuthStore', () => {
  it('login 成功 → isLoggedIn + user 落状态；令牌明文不进状态面', async () => {
    const client = makeFakeClient();
    configureCloudAuthClient(client);
    await cloudAuthStore.getState().login('a@b.c', 'pw');
    const s = cloudAuthStore.getState();
    expect(s.isLoggedIn).toBe(true);
    expect(s.user?.id).toBe('u-1');
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    const snapshot = JSON.stringify(s);
    expect(snapshot).not.toContain('at-1');
    expect(snapshot).not.toContain('rt-1');
    expect(getCloudRefreshToken()).toBe('rt-1');
  });

  it('login 失败 → error 留痕 + 状态不置位 + 异常上抛', async () => {
    const client = makeFakeClient();
    client.login.mockRejectedValueOnce(new Error('登录失败 (401)'));
    configureCloudAuthClient(client);
    await expect(
      cloudAuthStore.getState().login('a@b.c', 'bad')
    ).rejects.toThrow('登录失败 (401)');
    const s = cloudAuthStore.getState();
    expect(s.isLoggedIn).toBe(false);
    expect(s.error).toContain('401');
    expect(s.loading).toBe(false);
    expect(getCloudRefreshToken()).toBeNull();
  });

  it('fetchDevices → devices + onlineDesktop 投影；未登录短路', async () => {
    const client = makeFakeClient();
    configureCloudAuthClient(client);
    await cloudAuthStore.getState().fetchDevices();
    expect(client.listDevices).not.toHaveBeenCalled(); // 未登录短路

    await cloudAuthStore.getState().login('a@b.c', 'pw');
    await cloudAuthStore.getState().fetchDevices();
    expect(client.listDevices).toHaveBeenCalledWith('at-1');
    expect(cloudAuthStore.getState().onlineDesktop?.id).toBe('dev-1');
  });

  it('fetchDevices 失败 → error 留痕（不静默），既有在线桌面保留', async () => {
    const client = makeFakeClient();
    configureCloudAuthClient(client);
    await cloudAuthStore.getState().login('a@b.c', 'pw');
    client.listDevices.mockRejectedValueOnce(
      new Error('获取设备列表失败 (500)')
    );
    await cloudAuthStore.getState().fetchDevices();
    expect(cloudAuthStore.getState().error).toContain('500');
  });

  it('requestTicketForDesktop：未登录/无桌面 → 可读错误；成功 → 票据透传（服务端 404 原样上抛由 client 保证）', async () => {
    const client = makeFakeClient();
    configureCloudAuthClient(client);
    await expect(
      cloudAuthStore.getState().requestTicketForDesktop()
    ).rejects.toThrow('未检测到可用的在线电脑');

    await cloudAuthStore.getState().login('a@b.c', 'pw');
    await cloudAuthStore.getState().fetchDevices();
    const ticket = await cloudAuthStore.getState().requestTicketForDesktop();
    expect(ticket).toEqual({
      ticket: 't-1',
      relayUrl: 'wss://relay.example.me:8765',
      exp: 1_800_000,
    });
    expect(client.getClientRelayTicket).toHaveBeenCalledWith('at-1', 'dev-1');
  });

  it('logout → 全量复位 + 令牌闭包清空', async () => {
    const client = makeFakeClient();
    configureCloudAuthClient(client);
    await cloudAuthStore.getState().login('a@b.c', 'pw');
    cloudAuthStore.getState().logout();
    const s = cloudAuthStore.getState();
    expect(s.isLoggedIn).toBe(false);
    expect(s.user).toBeNull();
    expect(s.devices).toEqual([]);
    expect(getCloudRefreshToken()).toBeNull();
  });
});
