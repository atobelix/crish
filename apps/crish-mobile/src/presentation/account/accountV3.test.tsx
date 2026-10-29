// 账号 v3 页面：欢迎 / 邮箱 / 验证码 / 密码 / 设置密码 / 账号 / 登录设备 / 注销。
// 流程已切换为「先验证码、后设密码」：邮箱统一入口 → 验证码 → 新用户设密。
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import {
  confirmAccountEmailContinue,
  deleteAccountByConfirmEmail,
  listAccountSessions,
  loginAccountWithPassword,
  logoutAccount,
  requestAccountEmailCode,
  requestAccountPasswordChangeCode,
  revokeAccountSessionById,
  setAccountPasswordWithToken,
  continueAccountEmail,
  verifyAccountResetCode,
} from '@/adapters/account/accountService';
import {
  clearAccountFlowDraft,
  confirmAccountCode,
  continueWithEmail,
  startPasswordReset,
} from '@/adapters/account/accountFlow';
import { accountStore } from '@/domain/store/accountStore';
import type { AccountSessionInfo } from '@/domain/types/account';
import { WelcomeScreen } from './welcomeScreen';
import { AccountEmailScreen } from './accountEmailScreen';
import { AccountCodeScreen, formatCountdown } from './accountCodeScreen';
import { AccountPasswordScreen } from './accountPasswordScreen';
import { AccountSetPasswordScreen } from './accountSetPasswordScreen';
import { AccountHomeScreen, displayNameOf } from './accountHomeScreen';
import {
  AccountSessionsScreen,
  deviceLabelOf,
  orderSessions,
} from './accountSessionsScreen';
import { AccountDeleteScreen } from './accountDeleteScreen';
import { initialOf } from './ui';

jest.mock('@/adapters/account/accountService', () => ({
  continueAccountEmail: jest.fn(),
  confirmAccountEmailContinue: jest.fn(),
  requestAccountEmailCode: jest.fn(),
  verifyAccountResetCode: jest.fn(),
  requestAccountPasswordChangeCode: jest.fn(),
  confirmAccountPasswordChange: jest.fn(),
  setAccountPasswordWithToken: jest.fn(),
  loginAccountWithPassword: jest.fn(),
  logoutAccount: jest.fn(),
  listAccountSessions: jest.fn(),
  revokeAccountSessionById: jest.fn(),
  deleteAccountByConfirmEmail: jest.fn(),
}));

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

function renderScreen(element: ReactElement) {
  return render(element, { wrapper: Providers });
}

function isDisabled(node: { props: Record<string, unknown> }): boolean {
  const state = node.props.accessibilityState as
    { disabled?: boolean } | undefined;
  return state?.disabled === true;
}

function session(overrides: Partial<AccountSessionInfo>): AccountSessionInfo {
  return {
    id: 'x',
    deviceId: 'd',
    userAgent: 'iPhone',
    ip: '1.1.1.1',
    createdAt: 1,
    expiresAt: 2,
    revoked: false,
    current: false,
    ...overrides,
  };
}

const noop = () => undefined;

/** 建立 login 草稿（验证码页需要） */
async function seedLoginDraft(): Promise<void> {
  jest.mocked(continueAccountEmail).mockResolvedValue({
    ok: true,
    expiresIn: 600,
    isNewUser: false,
    hasPassword: true,
  });
  await continueWithEmail('a@b.co');
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAccountFlowDraft();
  accountStore.getState().reset();
});

describe('纯函数', () => {
  it('formatCountdown', () => {
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(61.2)).toBe('1:02');
    expect(formatCountdown(-3)).toBe('0:00');
  });

  it('displayNameOf / initialOf', () => {
    expect(displayNameOf(' 小明 ', null, 'a@b.co')).toBe('小明');
    expect(displayNameOf('', 'Ming', 'a@b.co')).toBe('Ming');
    expect(displayNameOf(null, null, 'ming@b.co')).toBe('ming');
    expect(initialOf('ming')).toBe('M');
    expect(initialOf('  ')).toBe('?');
  });

  it('orderSessions：去掉已吊销，本机置顶，其余按时间倒序', () => {
    const ordered = orderSessions([
      session({ id: 'old', createdAt: 1 }),
      session({ id: 'gone', revoked: true }),
      session({ id: 'new', createdAt: 9 }),
      session({ id: 'me', current: true, createdAt: 5 }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['me', 'new', 'old']);
    expect(deviceLabelOf(session({ userAgent: ' ' }))).toBe('未知设备');
  });
});

describe('WelcomeScreen', () => {
  it('两个入口分别回调', async () => {
    const onEmail = jest.fn();
    const onScan = jest.fn();
    const view = await renderScreen(
      <WelcomeScreen onContinueWithEmail={onEmail} onScanToConnect={onScan} />
    );
    expect(view.getByText('Crish')).toBeTruthy();
    await fireEvent.press(view.getByTestId('welcome-email'));
    await fireEvent.press(view.getByTestId('welcome-scan'));
    expect(onEmail).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});

describe('AccountEmailScreen', () => {
  it('邮箱无效时「继续」禁用；发码后进入验证码页', async () => {
    jest.mocked(continueAccountEmail).mockResolvedValue({
      ok: true,
      expiresIn: 600,
      isNewUser: false,
      hasPassword: true,
    });
    const onCodeSent = jest.fn();
    const view = await renderScreen(
      <AccountEmailScreen
        onBack={noop}
        onCodeSent={onCodeSent}
        onUsePassword={noop}
      />
    );
    expect(isDisabled(view.getByTestId('account-email-continue'))).toBe(true);
    await fireEvent.changeText(
      view.getByTestId('account-email-input'),
      ' A@B.co '
    );
    expect(isDisabled(view.getByTestId('account-email-continue'))).toBe(false);
    await fireEvent.press(view.getByTestId('account-email-continue'));
    await waitFor(() => expect(onCodeSent).toHaveBeenCalled());
    expect(continueAccountEmail).toHaveBeenCalledWith('a@b.co');
  });

  it('发码失败展示服务端文案', async () => {
    jest
      .mocked(continueAccountEmail)
      .mockRejectedValue(new Error('发码太频繁'));
    const view = await renderScreen(
      <AccountEmailScreen
        onBack={noop}
        onCodeSent={noop}
        onUsePassword={noop}
      />
    );
    await fireEvent.changeText(
      view.getByTestId('account-email-input'),
      'a@b.co'
    );
    await fireEvent.press(view.getByTestId('account-email-continue'));
    await waitFor(() => expect(view.getByText('发码太频繁')).toBeTruthy());
  });
});

describe('AccountCodeScreen', () => {
  it('老用户输满 6 位直接登录；失败显示错误', async () => {
    await seedLoginDraft();
    jest
      .mocked(confirmAccountEmailContinue)
      .mockRejectedValueOnce(new Error('验证码不正确'));
    const onSuccess = jest.fn();
    const view = await renderScreen(
      <AccountCodeScreen
        onBack={noop}
        onSuccess={onSuccess}
        onSetPassword={noop}
      />
    );
    expect(view.getByText('已发送至 a@b.co')).toBeTruthy();
    expect(view.getByText(/重新发送 · \d:\d\d/)).toBeTruthy();

    await fireEvent.changeText(view.getByTestId('code-cells-input'), '12345');
    expect(confirmAccountEmailContinue).not.toHaveBeenCalled();
    await fireEvent.changeText(view.getByTestId('code-cells-input'), '123456');
    await waitFor(() =>
      expect(view.getByTestId('account-code-error')).toBeTruthy()
    );
    expect(confirmAccountEmailContinue).toHaveBeenCalledWith(
      'a@b.co',
      '123456'
    );

    jest.mocked(confirmAccountEmailContinue).mockResolvedValueOnce({
      kind: 'signed_in',
      session: { accessToken: 'at', refreshToken: 'rt', user: null },
    });
    await fireEvent.changeText(view.getByTestId('code-cells-input'), '654321');
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('新用户进入设置密码', async () => {
    await seedLoginDraft();
    jest.mocked(confirmAccountEmailContinue).mockResolvedValue({
      kind: 'password_required',
      setupToken: 'st-1',
    });
    const onSetPassword = jest.fn();
    const view = await renderScreen(
      <AccountCodeScreen
        onBack={noop}
        onSuccess={noop}
        onSetPassword={onSetPassword}
      />
    );
    await fireEvent.changeText(view.getByTestId('code-cells-input'), '123456');
    await waitFor(() => expect(onSetPassword).toHaveBeenCalledWith('register'));
    expect(accountStore.getState().status).not.toBe('loggedIn');
  });

  it('重置验证码进入设置密码（reset）', async () => {
    jest.mocked(requestAccountEmailCode).mockResolvedValue({
      ok: true,
      expiresIn: 600,
    });
    await startPasswordReset('a@b.co');
    jest.mocked(verifyAccountResetCode).mockResolvedValue('st-2');
    const onSetPassword = jest.fn();
    const view = await renderScreen(
      <AccountCodeScreen
        onBack={noop}
        onSuccess={noop}
        onSetPassword={onSetPassword}
      />
    );
    await fireEvent.changeText(view.getByTestId('code-cells-input'), '654321');
    await waitFor(() => expect(onSetPassword).toHaveBeenCalledWith('reset'));
  });

  it('没有草稿时提示返回', async () => {
    const view = await renderScreen(
      <AccountCodeScreen onBack={noop} onSuccess={noop} onSetPassword={noop} />
    );
    expect(view.getByText('请返回重新输入邮箱')).toBeTruthy();
  });
});

describe('AccountPasswordScreen', () => {
  it('登录失败：显示「邮箱或密码不正确」', async () => {
    jest.mocked(loginAccountWithPassword).mockResolvedValue(false);
    const view = await renderScreen(
      <AccountPasswordScreen
        initialEmail="a@b.co"
        onBack={noop}
        onSuccess={noop}
        onForgot={noop}
      />
    );
    expect(isDisabled(view.getByTestId('account-password-submit'))).toBe(true);
    await fireEvent.changeText(
      view.getByTestId('account-password-input'),
      'pw'
    );
    await fireEvent.press(view.getByTestId('account-password-submit'));
    await waitFor(() =>
      expect(view.getByText('邮箱或密码不正确')).toBeTruthy()
    );
    expect(loginAccountWithPassword).toHaveBeenCalledWith('a@b.co', 'pw');
  });

  it('忘记密码：先发重置验证码，再进入验证码页', async () => {
    jest.mocked(requestAccountEmailCode).mockResolvedValue({
      ok: true,
      expiresIn: 600,
    });
    const onForgot = jest.fn();
    const view = await renderScreen(
      <AccountPasswordScreen
        initialEmail="a@b.co"
        onBack={noop}
        onSuccess={noop}
        onForgot={onForgot}
      />
    );
    await fireEvent.press(view.getByTestId('account-password-forgot'));
    await waitFor(() => expect(onForgot).toHaveBeenCalledWith('a@b.co'));
    expect(requestAccountEmailCode).toHaveBeenCalledWith('reset', 'a@b.co');
  });
});

describe('AccountSetPasswordScreen', () => {
  it.each([
    ['register', '设置密码'],
    ['reset', '重置密码'],
    ['change', '修改密码'],
  ] as const)('%s 标题为 %s', async (mode, title) => {
    const view = await renderScreen(
      <AccountSetPasswordScreen
        mode={mode}
        initialEmail="a@b.co"
        onBack={noop}
        onDone={noop}
        onCodeSent={noop}
      />
    );
    expect(view.getByText(title)).toBeTruthy();
  });

  it('注册（先码后密）：凭 setupToken 设置密码', async () => {
    jest.mocked(continueAccountEmail).mockResolvedValue({
      ok: true,
      expiresIn: 600,
      isNewUser: true,
      hasPassword: false,
    });
    await continueWithEmail('a@b.co');
    jest.mocked(confirmAccountEmailContinue).mockResolvedValue({
      kind: 'password_required',
      setupToken: 'st-1',
    });
    await confirmAccountCode('123456');
    jest.mocked(setAccountPasswordWithToken).mockResolvedValue(true);

    const onDone = jest.fn();
    const view = await renderScreen(
      <AccountSetPasswordScreen
        mode="register"
        onBack={noop}
        onDone={onDone}
        onCodeSent={noop}
      />
    );
    expect(view.getByText('a@b.co')).toBeTruthy();
    await fireEvent.changeText(
      view.getByTestId('set-password-input'),
      '1234567'
    );
    expect(isDisabled(view.getByTestId('set-password-submit'))).toBe(true);
    await fireEvent.changeText(
      view.getByTestId('set-password-input'),
      'a-strong-password'
    );
    expect(view.getByTestId('set-password-strength')).toBeTruthy();
    expect(isDisabled(view.getByTestId('set-password-submit'))).toBe(false);
    await fireEvent.press(view.getByTestId('set-password-submit'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setAccountPasswordWithToken).toHaveBeenCalledWith(
      'st-1',
      'a-strong-password'
    );
  });

  it('修改密码：收下新密码后请求改密验证码', async () => {
    jest.mocked(requestAccountPasswordChangeCode).mockResolvedValue({
      ok: true,
      expiresIn: 600,
    });
    const onCodeSent = jest.fn();
    const view = await renderScreen(
      <AccountSetPasswordScreen
        mode="change"
        initialEmail="a@b.co"
        onBack={noop}
        onDone={noop}
        onCodeSent={onCodeSent}
      />
    );
    await fireEvent.changeText(
      view.getByTestId('set-password-input'),
      'a-strong-password'
    );
    await fireEvent.press(view.getByTestId('set-password-submit'));
    await waitFor(() => expect(onCodeSent).toHaveBeenCalled());
    expect(requestAccountPasswordChangeCode).toHaveBeenCalled();
  });

  it('弱口令（连续 / 重复）不可提交', async () => {
    const view = await renderScreen(
      <AccountSetPasswordScreen
        mode="register"
        initialEmail="a@b.co"
        onBack={noop}
        onDone={noop}
        onCodeSent={noop}
      />
    );
    await fireEvent.changeText(
      view.getByTestId('set-password-input'),
      '12345678'
    );
    expect(isDisabled(view.getByTestId('set-password-submit'))).toBe(true);
    expect(view.getByText(/密码过于简单/)).toBeTruthy();
  });
});

describe('AccountHomeScreen', () => {
  it('展示账号信息与设备数；退出登录需在 sheet 内确认', async () => {
    accountStore.getState().setUser({ id: 'u', email: 'a@b.co', name: '小明' });
    jest
      .mocked(listAccountSessions)
      .mockResolvedValue([session({ id: '1' }), session({ id: '2' })]);
    jest.mocked(logoutAccount).mockResolvedValue();
    const onSignedOut = jest.fn();
    const view = await renderScreen(
      <AccountHomeScreen
        onBack={noop}
        onOpenProfile={noop}
        onOpenSessions={noop}
        onChangePassword={noop}
        onOpenDelete={noop}
        onSignedOut={onSignedOut}
      />
    );
    expect(view.getByTestId('account-name')).toHaveTextContent('小明');
    expect(view.getByText('a@b.co')).toBeTruthy();
    await waitFor(() => expect(view.getByText('2')).toBeTruthy());

    await fireEvent.press(view.getByTestId('account-sign-out'));
    expect(view.getByText('退出登录？')).toBeTruthy();
    expect(logoutAccount).not.toHaveBeenCalled();
    await fireEvent.press(view.getByTestId('sign-out-confirm'));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
    expect(logoutAccount).toHaveBeenCalledTimes(1);
  });
});

describe('AccountSessionsScreen', () => {
  it('本机置顶带标签；其它设备需两次点击才吊销', async () => {
    jest
      .mocked(listAccountSessions)
      .mockResolvedValue([
        session({ id: 'other', userAgent: 'Pixel' }),
        session({ id: 'me', current: true, userAgent: 'iPhone' }),
      ]);
    jest.mocked(revokeAccountSessionById).mockResolvedValue();
    const view = await renderScreen(<AccountSessionsScreen onBack={noop} />);
    await waitFor(() => expect(view.getByText('本机')).toBeTruthy());
    expect(view.queryByTestId('account-session-revoke-me')).toBeNull();

    await fireEvent.press(view.getByTestId('account-session-revoke-other'));
    expect(revokeAccountSessionById).not.toHaveBeenCalled();
    expect(view.getByText('确认')).toBeTruthy();
    await fireEvent.press(view.getByTestId('account-session-revoke-other'));
    await waitFor(() =>
      expect(revokeAccountSessionById).toHaveBeenCalledWith('other')
    );
  });
});

describe('AccountDeleteScreen', () => {
  it('邮箱一致才可提交；成功后回调', async () => {
    jest.mocked(deleteAccountByConfirmEmail).mockResolvedValue();
    const onDeleted = jest.fn();
    const view = await renderScreen(
      <AccountDeleteScreen email="a@b.co" onBack={noop} onDeleted={onDeleted} />
    );
    expect(isDisabled(view.getByTestId('account-delete-submit'))).toBe(true);
    await fireEvent.changeText(
      view.getByTestId('account-delete-input'),
      'A@B.co'
    );
    expect(isDisabled(view.getByTestId('account-delete-submit'))).toBe(false);
    await act(async () => {
      await fireEvent.press(view.getByTestId('account-delete-submit'));
    });
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(deleteAccountByConfirmEmail).toHaveBeenCalledWith('A@B.co');
  });
});
