import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from '../authStore';
import * as authApi from '../../api/authApi';

vi.mock('../../api/authApi');

describe('authStore 全局账号状态管理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      isLoggedIn: false,
      user: null,
      profile: null,
      devices: [],
      sessions: [],
      loading: false,
      initialized: false,
      error: null,
    });
  });

  it('initSession 当 session 有效时恢复登录态并拉取设备列表', async () => {
    vi.mocked(authApi.authGetSession).mockResolvedValueOnce({
      is_logged_in: true,
      user: { id: 'u1', email: 'test@example.com', name: 'Test User' },
      access_token: 'tok-123',
      expires_at_ms: Date.now() + 900000,
    });

    vi.mocked(authApi.authListDevices).mockResolvedValueOnce([
      {
        id: 'dev-1',
        name: 'My Phone',
        platform: 'iOS',
        lastSeenAt: Date.now(),
        trusted: true,
      },
    ]);

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useAuthStore.getState().user?.email).toBe('test@example.com');
    expect(useAuthStore.getState().initialized).toBe(true);

    // 等待 loadDevices 完成
    await Promise.resolve();
    expect(useAuthStore.getState().devices).toHaveLength(1);
    expect(useAuthStore.getState().devices[0].name).toBe('My Phone');
  });

  it('login 成功后更新登录态并拉取设备', async () => {
    vi.mocked(authApi.authLogin).mockResolvedValueOnce({
      id: 'u1',
      email: 'login@flowbit.me',
      name: 'Flowbit Dev',
    });
    vi.mocked(authApi.authListDevices).mockResolvedValueOnce([]);

    await useAuthStore.getState().login('login@flowbit.me', 'password123');

    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useAuthStore.getState().user?.email).toBe('login@flowbit.me');
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('login 失败时记录错误并保持未登录状态', async () => {
    vi.mocked(authApi.authLogin).mockRejectedValueOnce(new Error('密码错误'));

    await expect(
      useAuthStore.getState().login('login@flowbit.me', 'wrong-pass')
    ).rejects.toThrow('密码错误');

    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().error).toBe('密码错误');
  });

  it('logout 清空登录态和设备列表', async () => {
    useAuthStore.setState({
      isLoggedIn: true,
      user: { id: 'u1', email: 'test@example.com' },
      devices: [
        {
          id: 'd1',
          name: 'Phone',
          platform: 'Android',
          lastSeenAt: 123,
          trusted: true,
        },
      ],
    });

    vi.mocked(authApi.authLogout).mockResolvedValueOnce(true);

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().devices).toHaveLength(0);
  });

  it('completeLogin 建立登录态并拉取资料与在线设备', async () => {
    vi.mocked(authApi.authGetProfile).mockResolvedValueOnce({
      accountId: 'u1',
      email: 'test@example.com',
      displayName: 'Test User',
      bio: '',
      avatarUrl: null,
      avatarFileId: null,
      profileUpdatedAt: null,
    });
    vi.mocked(authApi.authListDevices).mockResolvedValueOnce([]);

    await useAuthStore
      .getState()
      .completeLogin({ id: 'u1', email: 'test@example.com', name: 'Test' });

    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useAuthStore.getState().profile?.displayName).toBe('Test User');
  });

  it('saveProfile 更新资料与当前用户名', async () => {
    useAuthStore.setState({
      isLoggedIn: true,
      user: { id: 'u1', email: 'test@example.com' },
    });
    vi.mocked(authApi.authUpdateProfile).mockResolvedValueOnce({
      accountId: 'u1',
      email: 'test@example.com',
      displayName: '新昵称',
      bio: '简介',
      avatarUrl: null,
      avatarFileId: null,
      profileUpdatedAt: 1,
    });

    await useAuthStore
      .getState()
      .saveProfile({ displayName: '新昵称', bio: '简介' });

    expect(useAuthStore.getState().profile?.displayName).toBe('新昵称');
    expect(useAuthStore.getState().user?.name).toBe('新昵称');
  });

  it('loadDevices 使用中继在线设备面返回的数据', async () => {
    useAuthStore.setState({ isLoggedIn: true });
    vi.mocked(authApi.authListDevices).mockResolvedValueOnce([
      {
        id: 'd1',
        name: 'My Phone',
        platform: 'mobile',
        lastSeenAt: Date.now(),
        trusted: true,
      },
    ]);

    await useAuthStore.getState().loadDevices();

    expect(useAuthStore.getState().devices).toHaveLength(1);
    expect(useAuthStore.getState().devices[0].platform).toBe('mobile');
  });

  it('revokeOtherSessions 只退出非本机会话并刷新列表', async () => {
    const base = {
      deviceId: 'dev',
      userAgent: 'ua',
      ip: '127.0.0.1',
      createdAt: 1,
      expiresAt: 2,
      revoked: false,
    };
    useAuthStore.setState({
      isLoggedIn: true,
      sessions: [
        { ...base, id: 's-self', current: true },
        { ...base, id: 's-other', current: false },
        { ...base, id: 's-old', current: false, revoked: true },
      ],
    });
    vi.mocked(authApi.authRevokeSession).mockResolvedValue(true);
    vi.mocked(authApi.authListSessions).mockResolvedValueOnce([
      { ...base, id: 's-self', current: true },
    ]);

    const ok = await useAuthStore.getState().revokeOtherSessions();

    expect(ok).toBe(true);
    expect(authApi.authRevokeSession).toHaveBeenCalledTimes(1);
    expect(authApi.authRevokeSession).toHaveBeenCalledWith('s-other');
    expect(useAuthStore.getState().sessions).toHaveLength(1);
  });

  it('deleteAccount 后端未就绪时抛错且保持登录态', async () => {
    useAuthStore.setState({
      isLoggedIn: true,
      user: { id: 'u1', email: 'test@example.com' },
    });
    vi.mocked(authApi.authDeleteAccount).mockRejectedValueOnce(
      new Error('unavailable')
    );

    await expect(useAuthStore.getState().deleteAccount()).rejects.toThrow(
      'unavailable'
    );
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });

  it('deleteAccount 成功后回到未登录态', async () => {
    useAuthStore.setState({
      isLoggedIn: true,
      user: { id: 'u1', email: 'test@example.com' },
    });
    vi.mocked(authApi.authDeleteAccount).mockResolvedValueOnce(undefined);

    await useAuthStore.getState().deleteAccount();

    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });
});
