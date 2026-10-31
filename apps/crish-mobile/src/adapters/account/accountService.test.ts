// 账号编排测试：登录流程、401 静默续期、登出清理、设备/资料刷新、票据申请。
//
// accountService 是账号体系的编排中枢（旧覆盖率 0%），其 401 续期与
// 「刷新失败即登出」逻辑直接决定用户会不会被静默踢出登录态。
import { accountStore } from '@/domain/store/accountStore';
import { AccountApiError } from './accountApi';

// jest.mock 工厂会被提升到文件顶部，不能引用外部 const（TDZ）。这里在工厂内
// 建 mock 并以 `mock` 前缀命名导出，供测试体通过 import 取用。
jest.mock('./accountApi', () => {
  const actual = jest.requireActual('./accountApi');
  return {
    AccountApiError: actual.AccountApiError,
    loginAccount: jest.fn(),
    refreshAccount: jest.fn(),
    fetchAccountMe: jest.fn(),
    fetchRelayDevices: jest.fn(),
    fetchClientTicket: jest.fn(),
    fetchAccountProfile: jest.fn(),
    updateAccountProfile: jest.fn(),
    uploadAccountAvatar: jest.fn(),
    fetchAccountSessions: jest.fn(),
    revokeAccountSession: jest.fn(),
    logoutAccountSession: jest.fn(),
    requestEmailCode: jest.fn(),
    continueEmail: jest.fn(),
    confirmEmailContinue: jest.fn(),
    verifyEmailCode: jest.fn(),
    requestPasswordChangeCode: jest.fn(),
    changeAccountPassword: jest.fn(),
    setAccountPassword: jest.fn(),
    deleteAccountRemote: jest.fn(),
  };
});

import * as accountApiMock from './accountApi';

const mockApi = accountApiMock as unknown as {
  loginAccount: jest.Mock;
  refreshAccount: jest.Mock;
  fetchAccountMe: jest.Mock;
  fetchRelayDevices: jest.Mock;
  fetchClientTicket: jest.Mock;
  fetchAccountProfile: jest.Mock;
  updateAccountProfile: jest.Mock;
  uploadAccountAvatar: jest.Mock;
  fetchAccountSessions: jest.Mock;
  revokeAccountSession: jest.Mock;
  logoutAccountSession: jest.Mock;
  requestEmailCode: jest.Mock;
  continueEmail: jest.Mock;
  confirmEmailContinue: jest.Mock;
  verifyEmailCode: jest.Mock;
  requestPasswordChangeCode: jest.Mock;
  changeAccountPassword: jest.Mock;
  setAccountPassword: jest.Mock;
  deleteAccountRemote: jest.Mock;
};

// 同样受提升限制：工厂内建 mock，测试体经 import 取引用。
jest.mock('@/db/secureStore', () => {
  const actual = jest.requireActual('@/db/secureStore');
  return {
    ...actual,
    loadAccountSession: jest.fn(),
    saveAccountSession: jest.fn(),
    clearAccountSession: jest.fn(),
    expoSecureStoreDriver: () => ({
      getItem: jest.fn(async () => null),
      setItem: jest.fn(async () => {}),
      deleteItem: jest.fn(async () => {}),
    }),
  };
});

import * as secureStoreMock from '@/db/secureStore';

const mockSecure = secureStoreMock as unknown as {
  loadAccountSession: jest.Mock;
  saveAccountSession: jest.Mock;
  clearAccountSession: jest.Mock;
};

jest.mock('@/pairing/pairProtocol', () => ({
  generateDeviceId: () => 'dev-generated',
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { deviceName: '测试机' },
}));

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import {
  confirmAccountEmailContinue,
  deleteAccountByConfirmEmail,
  loginAccountWithPassword,
  logoutAccount,
  refreshAccountDevices,
  refreshAccountProfile,
  saveAccountProfile,
  requestClientTicket,
  selectAccountTarget,
  getAccountUser,
} from './accountService';

const profile = {
  accountId: 'u-1',
  email: 'a@b.c',
  displayName: '小明',
  bio: null,
  avatarUrl: null,
};

const user = { id: 'u-1', email: 'a@b.c', name: '小明' };

beforeEach(() => {
  jest.clearAllMocks();
  accountStore.getState().reset();
  accountStore.setState({ hydrated: false });
  mockSecure.loadAccountSession.mockResolvedValue(null);
  mockSecure.saveAccountSession.mockResolvedValue(undefined);
  mockSecure.clearAccountSession.mockResolvedValue(undefined);
  mockApi.fetchAccountProfile.mockResolvedValue(profile);
  mockApi.fetchRelayDevices.mockResolvedValue([]);
});

describe('loginAccountWithPassword', () => {
  it('成功时写入 store 与 secure-store，并拉取资料/设备', async () => {
    mockApi.loginAccount.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      user,
    });
    mockApi.fetchRelayDevices.mockResolvedValue([
      {
        id: 'd-1',
        name: '桌面',
        platform: 'desktop',
        lastSeenAt: 1,
        online: true,
      },
    ]);

    const ok = await loginAccountWithPassword('a@b.c', 'pw');

    expect(ok).toEqual({ ok: true });
    expect(accountStore.getState().status).toBe('loggedIn');
    expect(accountStore.getState().accessToken).toBe('at');
    expect(accountStore.getState().user).toEqual(user);
    expect(accountStore.getState().devices).toHaveLength(1);
    expect(mockSecure.saveAccountSession).toHaveBeenCalled();
    // 登录成功持久化用户快照（冷启动本地秒开，实现波总方案 A1）
    expect(mockSecure.saveAccountSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userJson: JSON.stringify(user) })
    );
  });

  it('登录失败时置 error 态并返回结构化结果（凭据错误不抛错）', async () => {
    mockApi.loginAccount.mockRejectedValue(
      new AccountApiError(401, 'invalid_credentials', '凭据错误')
    );

    const ok = await loginAccountWithPassword('a@b.c', 'bad');

    expect(ok).toEqual({
      ok: false,
      kind: 'credentials',
      message: '邮箱或密码不正确',
    });
    expect(accountStore.getState().status).toBe('error');
    expect(accountStore.getState().error).toBe('邮箱或密码不正确');
  });

  it('登录响应无 user 时回补 fetchAccountMe', async () => {
    mockApi.loginAccount.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      user: null,
    });
    mockApi.fetchAccountMe.mockResolvedValue(user);

    await loginAccountWithPassword('a@b.c', 'pw');

    expect(mockApi.fetchAccountMe).toHaveBeenCalledWith('at');
    expect(accountStore.getState().user).toEqual(user);
  });

  it('设备发现失败不阻断登录（best effort）', async () => {
    mockApi.loginAccount.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      user,
    });
    mockApi.fetchRelayDevices.mockRejectedValue(new Error('network down'));

    const ok = await loginAccountWithPassword('a@b.c', 'pw');

    expect(ok).toEqual({ ok: true });
    expect(accountStore.getState().status).toBe('loggedIn');
    expect(accountStore.getState().devices).toEqual([]);
  });
});

describe('logoutAccount', () => {
  it('尽力吊销服务端会话后清空本地凭据与 store', async () => {
    mockSecure.loadAccountSession.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      deviceId: 'd-1',
      userId: 'u-1',
      email: 'a@b.c',
    });
    mockApi.logoutAccountSession.mockResolvedValue(undefined);

    await logoutAccount();

    expect(mockApi.logoutAccountSession).toHaveBeenCalledWith('rt');
    expect(mockSecure.clearAccountSession).toHaveBeenCalled();
    expect(accountStore.getState().status).toBe('loggedOut');
  });

  it('服务端吊销失败仍允许本地退出', async () => {
    mockSecure.loadAccountSession.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      deviceId: 'd-1',
      userId: null,
      email: null,
    });
    mockApi.logoutAccountSession.mockRejectedValue(new Error('offline'));

    await logoutAccount();

    expect(accountStore.getState().status).toBe('loggedOut');
  });

  it('无会话时直接退出（不调吊销）', async () => {
    mockSecure.loadAccountSession.mockResolvedValue(null);

    await logoutAccount();

    expect(mockApi.logoutAccountSession).not.toHaveBeenCalled();
    expect(accountStore.getState().status).toBe('loggedOut');
  });
});

describe('refreshAccountDevices', () => {
  it('有 token 时直接拉取并写入', async () => {
    accountStore.getState().setAccessToken('at');
    mockApi.fetchRelayDevices.mockResolvedValue([
      {
        id: 'd-1',
        name: 'x',
        platform: 'desktop',
        lastSeenAt: 1,
        online: true,
      },
    ]);

    await refreshAccountDevices();

    expect(mockApi.fetchRelayDevices).toHaveBeenCalledWith('at');
    expect(accountStore.getState().devices).toHaveLength(1);
  });

  it('无 token 时先续期再拉取', async () => {
    mockSecure.loadAccountSession.mockResolvedValue({
      accessToken: null,
      refreshToken: 'rt-old',
      deviceId: 'd-1',
      userId: 'u-1',
      email: 'a@b.c',
    });
    mockApi.refreshAccount.mockResolvedValue({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      user,
    });
    mockApi.fetchRelayDevices.mockResolvedValue([]);

    await refreshAccountDevices();

    expect(mockApi.refreshAccount).toHaveBeenCalledWith('rt-old');
    expect(mockApi.fetchRelayDevices).toHaveBeenCalledWith('at-new');
  });

  it('续期遇 401 时清空会话并记录错误', async () => {
    accountStore.getState().setAccessToken('expired');
    mockApi.fetchRelayDevices.mockRejectedValue(
      new AccountApiError(401, 'unauthorized', 'expired')
    );
    mockSecure.loadAccountSession.mockResolvedValue({
      accessToken: 'expired',
      refreshToken: 'rt',
      deviceId: 'd-1',
      userId: null,
      email: null,
    });
    mockApi.refreshAccount.mockRejectedValue(
      new AccountApiError(401, 'unauthorized', 'refresh expired')
    );

    await refreshAccountDevices();

    expect(mockSecure.clearAccountSession).toHaveBeenCalled();
    expect(accountStore.getState().error).toBeTruthy();
  });

  it('无会话且无 token 时抛 unauthorized 并记录', async () => {
    mockSecure.loadAccountSession.mockResolvedValue(null);

    await refreshAccountDevices();

    expect(accountStore.getState().error).toContain('登录已失效');
  });
});

describe('refreshAccountProfile', () => {
  it('成功写入资料', async () => {
    accountStore.getState().setAccessToken('at');

    await refreshAccountProfile();

    expect(accountStore.getState().profile).toEqual(profile);
  });

  it('失败静默（不写 error，不抛错）', async () => {
    accountStore.getState().setAccessToken('at');
    mockApi.fetchAccountProfile.mockRejectedValue(new Error('boom'));

    await expect(refreshAccountProfile()).resolves.toBeUndefined();
    expect(accountStore.getState().error).toBeNull();
  });
});

describe('saveAccountProfile', () => {
  it('保存后同步 profile 与 user', async () => {
    accountStore.getState().setAccessToken('at');
    mockApi.updateAccountProfile.mockResolvedValue(profile);

    const result = await saveAccountProfile({ displayName: '小明' });

    expect(result).toEqual(profile);
    expect(accountStore.getState().user).toMatchObject({ id: 'u-1' });
  });

  it('错误上抛给调用方（资料页展示）', async () => {
    accountStore.getState().setAccessToken('at');
    mockApi.updateAccountProfile.mockRejectedValue(
      new AccountApiError(400, 'invalid', '昵称过长')
    );

    await expect(
      saveAccountProfile({ displayName: 'x' })
    ).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('requestClientTicket', () => {
  it('用账号设备 id 与目标设备申请票据', async () => {
    accountStore.getState().setAccessToken('at');
    mockApi.fetchClientTicket.mockResolvedValue({
      ticket: 'tk',
      relayUrl: 'wss://r',
      exp: 1,
    });

    const ticket = await requestClientTicket('target-1');

    expect(ticket.ticket).toBe('tk');
    expect(mockApi.fetchClientTicket).toHaveBeenCalledWith(
      'at',
      'dev-generated',
      '测试机',
      'target-1'
    );
  });
});

describe('统一邮箱入口 / 注销', () => {
  it('验证码确认：老用户直接建立会话并持久化', async () => {
    mockApi.confirmEmailContinue.mockResolvedValue({
      kind: 'signed_in',
      session: { accessToken: 'at', refreshToken: 'rt', user },
    });

    await expect(
      confirmAccountEmailContinue('a@b.c', '123456')
    ).resolves.toMatchObject({ kind: 'signed_in' });

    expect(mockApi.confirmEmailContinue).toHaveBeenCalledWith(
      'a@b.c',
      '123456',
      'dev-generated',
      '测试机'
    );
    expect(accountStore.getState().status).toBe('loggedIn');
    expect(mockSecure.saveAccountSession).toHaveBeenCalled();
  });

  it('验证码确认：新用户只返回 setupToken，不建立会话', async () => {
    mockApi.confirmEmailContinue.mockResolvedValue({
      kind: 'password_required',
      setupToken: 'st-1',
    });

    await expect(
      confirmAccountEmailContinue('a@b.c', '123456')
    ).resolves.toEqual({ kind: 'password_required', setupToken: 'st-1' });
    expect(accountStore.getState().status).not.toBe('loggedIn');
    expect(mockSecure.saveAccountSession).not.toHaveBeenCalled();
  });

  it('注销：带 token 提交确认邮箱并清空本地会话', async () => {
    accountStore.getState().setAccessToken('at');
    mockApi.deleteAccountRemote.mockResolvedValue(undefined);

    await deleteAccountByConfirmEmail('a@b.c');

    expect(mockApi.deleteAccountRemote).toHaveBeenCalledWith('at', 'a@b.c');
    expect(mockSecure.clearAccountSession).toHaveBeenCalled();
    expect(accountStore.getState().status).toBe('loggedOut');
  });
});

describe('selectAccountTarget / getAccountUser', () => {
  it('选择目标设备写入 store', () => {
    selectAccountTarget('d-9');
    expect(accountStore.getState().targetDeviceId).toBe('d-9');
  });

  it('可清空目标设备', () => {
    selectAccountTarget('d-9');
    selectAccountTarget(null);
    expect(accountStore.getState().targetDeviceId).toBeNull();
  });

  it('getAccountUser 反映当前 store', () => {
    accountStore.getState().setUser(user);
    expect(getAccountUser()).toEqual(user);
  });
});
