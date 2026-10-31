// 账号 v3 流程编排：统一邮箱入口 / 先验证码后设密 / 改密 / 重发。
import {
  confirmAccountEmailContinue,
  confirmAccountPasswordChange,
  continueAccountEmail,
  requestAccountEmailCode,
  requestAccountPasswordChangeCode,
  setAccountPasswordWithToken,
  verifyAccountResetCode,
} from '@/adapters/account/accountService';
import {
  RESEND_COOLDOWN_SECONDS,
  clearAccountFlowDraft,
  completeAccountPassword,
  confirmAccountCode,
  continueWithEmail,
  getAccountFlowDraft,
  isValidEmail,
  resendAccountCode,
  startPasswordChange,
  startPasswordReset,
} from './accountFlow';

jest.mock('@/adapters/account/accountService', () => ({
  continueAccountEmail: jest.fn(),
  confirmAccountEmailContinue: jest.fn(),
  requestAccountEmailCode: jest.fn(),
  verifyAccountResetCode: jest.fn(),
  requestAccountPasswordChangeCode: jest.fn(),
  confirmAccountPasswordChange: jest.fn(),
  setAccountPasswordWithToken: jest.fn(),
}));

const continueMock = jest.mocked(continueAccountEmail);
const confirmContinueMock = jest.mocked(confirmAccountEmailContinue);
const requestMock = jest.mocked(requestAccountEmailCode);
const verifyResetMock = jest.mocked(verifyAccountResetCode);
const changeCodeMock = jest.mocked(requestAccountPasswordChangeCode);
const changeMock = jest.mocked(confirmAccountPasswordChange);
const setPasswordMock = jest.mocked(setAccountPasswordWithToken);

const NOW = 1_800_000_000_000;

beforeEach(() => {
  clearAccountFlowDraft();
  jest.clearAllMocks();
});

describe('isValidEmail', () => {
  it.each([
    ['a@b.co', true],
    [' a@b.co ', true],
    ['a@b', false],
    ['', false],
    ['a b@c.d', false],
  ])('%s → %s', (input, expected) => {
    expect(isValidEmail(input)).toBe(expected);
  });
});

describe('continueWithEmail', () => {
  it('发码成功建立 login 草稿（邮箱规范化）', async () => {
    continueMock.mockResolvedValue({
      ok: true,
      expiresIn: 600,
      isNewUser: true,
      hasPassword: false,
      devCode: '123456',
    });
    await expect(continueWithEmail(' A@B.co ', NOW)).resolves.toEqual({
      kind: 'sent',
    });
    expect(continueMock).toHaveBeenCalledWith('a@b.co');
    expect(getAccountFlowDraft()).toEqual({
      email: 'a@b.co',
      purpose: 'login',
      password: null,
      setupToken: null,
      resendAt: NOW + RESEND_COOLDOWN_SECONDS * 1000,
      devCode: '123456',
    });
  });

  it('其它错误透出服务端文案', async () => {
    continueMock.mockRejectedValue(new Error('网络不可用'));
    await expect(continueWithEmail('a@b.co')).resolves.toEqual({
      kind: 'error',
      message: '网络不可用',
    });
    expect(getAccountFlowDraft()).toBeNull();
  });
});

describe('验证码确认', () => {
  it('老用户确认后直接登录并清空草稿', async () => {
    continueMock.mockResolvedValue({
      ok: true,
      expiresIn: 600,
      isNewUser: false,
      hasPassword: true,
    });
    await continueWithEmail('a@b.co', NOW);
    confirmContinueMock.mockResolvedValue({
      kind: 'signed_in',
      session: { accessToken: 'at', refreshToken: 'rt', user: null },
    });

    await expect(confirmAccountCode('123456')).resolves.toEqual({
      kind: 'signed_in',
    });
    expect(confirmContinueMock).toHaveBeenCalledWith('a@b.co', '123456');
    expect(getAccountFlowDraft()).toBeNull();
  });

  it('新用户返回 setupToken 并进入设置密码', async () => {
    continueMock.mockResolvedValue({
      ok: true,
      expiresIn: 600,
      isNewUser: true,
      hasPassword: false,
    });
    await continueWithEmail('a@b.co', NOW);
    confirmContinueMock.mockResolvedValue({
      kind: 'password_required',
      setupToken: 'st-1',
    });

    await expect(confirmAccountCode('123456')).resolves.toEqual({
      kind: 'set_password',
      mode: 'register',
    });
    expect(getAccountFlowDraft()?.setupToken).toBe('st-1');
  });

  it('重置验证码换取 setupToken 后进入设置密码', async () => {
    requestMock.mockResolvedValue({ ok: true, expiresIn: 600 });
    await startPasswordReset(' A@B.co ', NOW);
    expect(requestMock).toHaveBeenCalledWith('reset', 'a@b.co');
    verifyResetMock.mockResolvedValue('st-2');

    await expect(confirmAccountCode('654321')).resolves.toEqual({
      kind: 'set_password',
      mode: 'reset',
    });
    expect(verifyResetMock).toHaveBeenCalledWith('a@b.co', '654321');
    expect(getAccountFlowDraft()?.setupToken).toBe('st-2');
  });

  it('修改密码：带草稿新密码提交确认', async () => {
    changeCodeMock.mockResolvedValue({ ok: true, expiresIn: 600 });
    await startPasswordChange('a@b.co', 'new-password-1', NOW);
    changeMock.mockResolvedValue(undefined);

    await expect(confirmAccountCode('111111')).resolves.toEqual({
      kind: 'changed',
    });
    expect(changeMock).toHaveBeenCalledWith('111111', 'new-password-1');
    expect(getAccountFlowDraft()).toBeNull();
  });

  it('失败返回可展示文案并保留草稿', async () => {
    requestMock.mockResolvedValue({ ok: true, expiresIn: 600 });
    await startPasswordReset('a@b.co', NOW);
    verifyResetMock.mockRejectedValue(new Error('验证码过期'));

    await expect(confirmAccountCode('000000')).resolves.toEqual({
      kind: 'failed',
      message: '验证码过期',
    });
    expect(getAccountFlowDraft()?.purpose).toBe('reset');
  });

  it('没有草稿时确认失败', async () => {
    await expect(confirmAccountCode('123456')).resolves.toMatchObject({
      kind: 'failed',
    });
    expect(confirmContinueMock).not.toHaveBeenCalled();
  });
});

describe('重发与设密', () => {
  it('重发按用途调用对应接口并刷新倒计时', async () => {
    requestMock.mockResolvedValue({ ok: true, expiresIn: 600 });
    await startPasswordReset('a@b.co', NOW);
    requestMock.mockResolvedValue({ ok: true, expiresIn: 600 });

    await resendAccountCode(NOW + 61_000);

    expect(requestMock).toHaveBeenLastCalledWith('reset', 'a@b.co');
    expect(getAccountFlowDraft()?.resendAt).toBe(
      NOW + 61_000 + RESEND_COOLDOWN_SECONDS * 1000
    );
  });

  it('没有草稿时重发不调用服务', async () => {
    await expect(resendAccountCode()).resolves.toEqual({
      kind: 'error',
      message: '请返回重新输入邮箱',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('凭 setupToken 设置密码成功后清空草稿', async () => {
    continueMock.mockResolvedValue({
      ok: true,
      expiresIn: 600,
      isNewUser: true,
      hasPassword: false,
    });
    await continueWithEmail('a@b.co', NOW);
    confirmContinueMock.mockResolvedValue({
      kind: 'password_required',
      setupToken: 'st-1',
    });
    await confirmAccountCode('123456');
    setPasswordMock.mockResolvedValue({ ok: true });

    await expect(completeAccountPassword('new-password-1')).resolves.toEqual({
      ok: true,
    });
    expect(setPasswordMock).toHaveBeenCalledWith('st-1', 'new-password-1');
    expect(getAccountFlowDraft()).toBeNull();
  });
});
