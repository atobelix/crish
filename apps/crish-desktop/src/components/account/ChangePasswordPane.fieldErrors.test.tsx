// @vitest-environment jsdom
/**
 * ChangePasswordPane 字段级错误（F7 样板）回归测试。旧口径是「表单级单槽 +
 * 任意字段任意击键即清」，新口径钉住四条性质：
 * - 服务端业务拒绝归因到验证码字段（本地唯一不可验证的输入），文案用服务端原文；
 * - 字段错误只随该字段被修正而变化：在另一字段输入不清除；
 * - 网络类环境失败进表单级错误行，不标红任何字段；
 * - 提交时本地校验不过不发请求，错误落字段且焦点定位首个错误字段。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ChangePasswordPane } from './ChangePasswordPane';
import {
  AuthApiError,
  authRequestPasswordCode,
  authSetPasswordWithCode,
} from '../../api/authApi';
import { useAccountUiStore } from '../../store/accountUiStore';

vi.mock('../../api/authApi', () => {
  class AuthApiError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  }
  return {
    AuthApiError,
    authRequestPasswordCode: vi.fn(),
    authSetPasswordWithCode: vi.fn(),
  };
});

vi.mock('../../store/storeAccess', () => ({
  useAuthField: (selector: (state: unknown) => unknown) =>
    selector({
      user: { email: 'user@example.com' },
      profile: { email: 'user@example.com' },
      completeLogin: vi.fn(async () => undefined),
    }),
}));

beforeEach(() => {
  vi.mocked(authRequestPasswordCode).mockReset();
  vi.mocked(authSetPasswordWithCode).mockReset();
  vi.mocked(authRequestPasswordCode).mockResolvedValue(undefined);
  useAccountUiStore.setState({ view: 'changePassword', loginOpen: false });
});

afterEach(() => {
  cleanup();
});

/**
 * 等进页自动发码落定：发码成功会 setCode('') 复位验证码，
 * 不等它落定就填码，填入值会被迟到的发码续体冲掉（原回归测试同口径）。
 */
const settleAutoSend = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });

function fillValid() {
  const codeInput = screen.getByLabelText('6 位验证码') as HTMLInputElement;
  const pwInput = screen.getByLabelText('新密码') as HTMLInputElement;
  fireEvent.change(codeInput, { target: { value: '123456' } });
  fireEvent.change(pwInput, { target: { value: 'newpass123' } });
  return { codeInput, pwInput };
}

describe('ChangePasswordPane 字段级错误（F7）', () => {
  it('保存被服务端拒绝：错误挂验证码字段下，改密码不清除、改验证码才清除', async () => {
    vi.mocked(authSetPasswordWithCode).mockRejectedValue(
      new AuthApiError('rejected', '验证码错误或已过期')
    );
    render(<ChangePasswordPane />);
    await settleAutoSend();
    const { codeInput, pwInput } = fillValid();

    const saveBtn = screen.getByRole('button', { name: '保存' });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    fireEvent.click(saveBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('验证码错误或已过期');
    expect(codeInput).toHaveAttribute('aria-invalid', 'true');
    expect(pwInput).not.toHaveAttribute('aria-invalid', 'true');

    // 在密码字段继续输入：验证码字段的错误保留（旧口径任意击键即清）
    fireEvent.change(pwInput, { target: { value: 'newpass456' } });
    expect(screen.getByRole('alert')).toHaveTextContent('验证码错误或已过期');

    // 改动验证码本身：旧裁决作废，错误清除
    fireEvent.change(codeInput, { target: { value: '654321' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(codeInput).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('密码失焦落字段错误并按当前值重评：修正即清，且不波及验证码字段', async () => {
    render(<ChangePasswordPane />);
    const codeInput = screen.getByLabelText('6 位验证码') as HTMLInputElement;
    const pwInput = screen.getByLabelText('新密码') as HTMLInputElement;

    fireEvent.change(pwInput, { target: { value: 'abc' } });
    fireEvent.focusOut(pwInput);
    expect(await screen.findByRole('alert')).toHaveTextContent('密码至少 8 位');
    expect(pwInput).toHaveAttribute('aria-invalid', 'true');

    // 在验证码字段输入：密码字段的错误保留
    fireEvent.change(codeInput, { target: { value: '1' } });
    expect(screen.getByRole('alert')).toHaveTextContent('密码至少 8 位');

    // 密码改到合规：错误随修正清除
    fireEvent.change(pwInput, { target: { value: 'newpass123' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(pwInput).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('网络类失败进表单级错误行，不标红任何字段', async () => {
    vi.mocked(authSetPasswordWithCode).mockRejectedValue(
      new AuthApiError('network', '')
    );
    render(<ChangePasswordPane />);
    await settleAutoSend();
    const { codeInput, pwInput } = fillValid();

    const saveBtn = screen.getByRole('button', { name: '保存' });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    fireEvent.click(saveBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('网络连接失败，请检查网络后重试');
    expect(codeInput).not.toHaveAttribute('aria-invalid', 'true');
    expect(pwInput).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('提交时本地校验不过：不发请求、错误落验证码字段、焦点定位到该字段', async () => {
    render(<ChangePasswordPane />);
    await settleAutoSend();
    const codeInput = screen.getByLabelText('6 位验证码') as HTMLInputElement;
    const pwInput = screen.getByLabelText('新密码') as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '123' } });
    fireEvent.change(pwInput, { target: { value: 'newpass123' } });

    fireEvent.submit(codeInput.closest('form')!);

    expect(authSetPasswordWithCode).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '请输入 6 位验证码'
    );
    // 提交后重查节点再断言（避免引用到重渲染前的旧节点）
    const codeInputAfter = screen.getByLabelText(
      '6 位验证码'
    ) as HTMLInputElement;
    expect(codeInputAfter).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(codeInputAfter);
  });
});
