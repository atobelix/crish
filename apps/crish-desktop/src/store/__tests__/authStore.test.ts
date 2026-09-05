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
      devices: [],
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
      devices: [{ id: 'd1', name: 'Phone', platform: 'Android', lastSeenAt: 123, trusted: true }],
    });

    vi.mocked(authApi.authLogout).mockResolvedValueOnce(true);

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().devices).toHaveLength(0);
  });

  it('revokeDevice 成功后从设备列表中剔除', async () => {
    useAuthStore.setState({
      isLoggedIn: true,
      devices: [
        { id: 'd1', name: 'Device 1', platform: 'iOS', lastSeenAt: 123, trusted: true },
        { id: 'd2', name: 'Device 2', platform: 'Android', lastSeenAt: 456, trusted: true },
      ],
    });

    vi.mocked(authApi.authRevokeDevice).mockResolvedValueOnce(true);

    const ok = await useAuthStore.getState().revokeDevice('d1');
    expect(ok).toBe(true);
    expect(useAuthStore.getState().devices).toHaveLength(1);
    expect(useAuthStore.getState().devices[0].id).toBe('d2');
  });
});
