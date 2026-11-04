// 账号安全三件（2026-11-02）：
// - 换绑邮箱：账号服务无换绑能力（全仓审计无端点 / 无场次）→ 界面与入口照建，
//   发码与确认一律如实呈现「暂不支持」，且绝不调用任何账号服务函数（不假发码、
//   不假成功）；邮箱格式错误仍走字段级口径。
// - 修改密码单页：验证码 + 新密码 + 确认新密码同页；发码 / 确认直连
//   accountService 既有改密接口；本地校验与服务端拒绝按字段归因（F7 式）。
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import {
  confirmAccountPasswordChange,
  requestAccountPasswordChangeCode,
} from '@/adapters/account/accountService';
import { AccountApiError } from '@/adapters/account/accountApi';
import { accountStore } from '@/domain/store/accountStore';
import { ToastProvider } from '@/presentation/ui';
import {
  AccountChangeEmailScreen,
  CHANGE_EMAIL_UNSUPPORTED_MESSAGE,
} from './accountChangeEmailScreen';
import { AccountChangePasswordScreen } from './accountChangePasswordScreen';

jest.mock('@/adapters/account/accountService', () => ({
  requestAccountPasswordChangeCode: jest.fn(),
  confirmAccountPasswordChange: jest.fn(),
}));

const requestCodeMock = jest.mocked(requestAccountPasswordChangeCode);
const confirmMock = jest.mocked(confirmAccountPasswordChange);

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
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

const noop = () => undefined;

beforeEach(() => {
  jest.clearAllMocks();
  accountStore.getState().reset();
  accountStore.getState().setUser({ id: 'u', email: 'a@b.co', name: '小明' });
});

describe('AccountChangeEmailScreen（后端无换绑能力 → 诚实状态）', () => {
  it('当前邮箱只读展示；新邮箱 / 验证码 / 确认换绑齐全', async () => {
    const view = await renderScreen(<AccountChangeEmailScreen onBack={noop} />);
    const current = view.getByTestId('change-email-current');
    expect(current.props.value).toBe('a@b.co');
    expect(current.props.editable).toBe(false);
    expect(view.getByTestId('change-email-new')).toBeTruthy();
    expect(view.getByTestId('change-email-code')).toBeTruthy();
    expect(view.getByTestId('change-email-code-request')).toBeTruthy();
    expect(view.getByTestId('change-email-submit')).toBeTruthy();
    expect(view.queryByTestId('change-email-notice')).toBeNull();
  });

  it('点「获取验证码」如实提示暂不支持，且不调用任何账号服务', async () => {
    const view = await renderScreen(<AccountChangeEmailScreen onBack={noop} />);
    await fireEvent.press(view.getByTestId('change-email-code-request'));
    expect(view.getByTestId('change-email-notice')).toBeTruthy();
    expect(view.getByText(CHANGE_EMAIL_UNSUPPORTED_MESSAGE)).toBeTruthy();
    expect(requestCodeMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('填了有效新邮箱点「确认换绑」同样如实提示，绝不假成功', async () => {
    const onBack = jest.fn();
    const view = await renderScreen(
      <AccountChangeEmailScreen onBack={onBack} />
    );
    await fireEvent.changeText(
      view.getByTestId('change-email-new'),
      'new@b.co'
    );
    await fireEvent.changeText(view.getByTestId('change-email-code'), '123456');
    await fireEvent.press(view.getByTestId('change-email-submit'));
    expect(view.getByTestId('change-email-notice')).toBeTruthy();
    expect(requestCodeMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('新邮箱格式无效 → 字段级错误贴新邮箱字段，不出诚实提示', async () => {
    const view = await renderScreen(<AccountChangeEmailScreen onBack={noop} />);
    await fireEvent.changeText(
      view.getByTestId('change-email-new'),
      'not-an-email'
    );
    await fireEvent.press(view.getByTestId('change-email-submit'));
    expect(view.getByTestId('change-email-new-error')).toBeTruthy();
    expect(view.getByText('请输入有效邮箱')).toBeTruthy();
    expect(view.queryByTestId('change-email-notice')).toBeNull();
  });
});

describe('AccountChangePasswordScreen（单页式改密）', () => {
  const fillValid = async (view: Awaited<ReturnType<typeof renderScreen>>) => {
    await fireEvent.changeText(
      view.getByTestId('change-password-code'),
      '123456'
    );
    await fireEvent.changeText(
      view.getByTestId('change-password-new'),
      'a-strong-password'
    );
    await fireEvent.changeText(
      view.getByTestId('change-password-confirm'),
      'a-strong-password'
    );
  };

  it('验证码 + 新密码 + 确认新密码 + 主钮同页齐全', async () => {
    const view = await renderScreen(
      <AccountChangePasswordScreen onBack={noop} onDone={noop} />
    );
    expect(view.getByText('修改密码')).toBeTruthy();
    expect(view.getByTestId('change-password-code')).toBeTruthy();
    expect(view.getByTestId('change-password-code-request')).toBeTruthy();
    expect(view.getByTestId('change-password-new')).toBeTruthy();
    expect(view.getByTestId('change-password-confirm')).toBeTruthy();
    expect(view.getByTestId('change-password-submit')).toBeTruthy();
    // 字段未齐时主钮禁用
    expect(isDisabled(view.getByTestId('change-password-submit'))).toBe(true);
  });

  it('获取验证码调用既有改密发码接口并进入倒计时', async () => {
    requestCodeMock.mockResolvedValue({
      ok: true,
      expiresIn: 600,
      resendAfter: 60,
    });
    const view = await renderScreen(
      <AccountChangePasswordScreen onBack={noop} onDone={noop} />
    );
    await fireEvent.press(view.getByTestId('change-password-code-request'));
    await waitFor(() => expect(requestCodeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByText('60s')).toBeTruthy());
    expect(isDisabled(view.getByTestId('change-password-code-request'))).toBe(
      true
    );
  });

  it('同页提交：确认接口收到（验证码，新密码），成功回调 onDone', async () => {
    confirmMock.mockResolvedValue(undefined);
    const onDone = jest.fn();
    const view = await renderScreen(
      <AccountChangePasswordScreen onBack={noop} onDone={onDone} />
    );
    await fillValid(view);
    expect(isDisabled(view.getByTestId('change-password-submit'))).toBe(false);
    await fireEvent.press(view.getByTestId('change-password-submit'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(confirmMock).toHaveBeenCalledWith('123456', 'a-strong-password');
  });

  it('确认密码不一致 → 错误贴确认字段，不调确认接口', async () => {
    const view = await renderScreen(
      <AccountChangePasswordScreen onBack={noop} onDone={noop} />
    );
    await fireEvent.changeText(
      view.getByTestId('change-password-code'),
      '123456'
    );
    await fireEvent.changeText(
      view.getByTestId('change-password-new'),
      'a-strong-password'
    );
    await fireEvent.changeText(
      view.getByTestId('change-password-confirm'),
      'another-strong-1'
    );
    await fireEvent.press(view.getByTestId('change-password-submit'));
    expect(view.getByTestId('change-password-confirm-error')).toBeTruthy();
    expect(view.getByText('两次输入的密码不一致')).toBeTruthy();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('弱密码 → 强度行红字说明且提交被策略拦下', async () => {
    const view = await renderScreen(
      <AccountChangePasswordScreen onBack={noop} onDone={noop} />
    );
    await fireEvent.changeText(
      view.getByTestId('change-password-code'),
      '123456'
    );
    await fireEvent.changeText(
      view.getByTestId('change-password-new'),
      '12345678'
    );
    expect(view.getByText(/密码过于简单/)).toBeTruthy();
    await fireEvent.changeText(
      view.getByTestId('change-password-confirm'),
      '12345678'
    );
    await fireEvent.press(view.getByTestId('change-password-submit'));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('服务端拒绝验证码 → 错误归因到验证码字段', async () => {
    confirmMock.mockRejectedValue(
      new AccountApiError(400, 'invalid_code', '验证码不正确或已过期')
    );
    const view = await renderScreen(
      <AccountChangePasswordScreen onBack={noop} onDone={noop} />
    );
    await fillValid(view);
    await fireEvent.press(view.getByTestId('change-password-submit'));
    await waitFor(() =>
      expect(view.getByTestId('change-password-code-error')).toBeTruthy()
    );
    expect(view.getByText('验证码不正确或已过期')).toBeTruthy();
  });

  it('服务端拒绝密码 → 错误归因到新密码字段', async () => {
    confirmMock.mockRejectedValue(
      new AccountApiError(
        400,
        'password_policy_violation',
        '密码不符合安全要求'
      )
    );
    const view = await renderScreen(
      <AccountChangePasswordScreen onBack={noop} onDone={noop} />
    );
    await fillValid(view);
    await fireEvent.press(view.getByTestId('change-password-submit'));
    await waitFor(() =>
      expect(view.getByTestId('change-password-new-error')).toBeTruthy()
    );
    expect(view.getByText('密码不符合安全要求')).toBeTruthy();
  });
});
