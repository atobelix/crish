// @vitest-environment jsdom
/**
 * ChangePasswordPane 回归测试（收口 Phase 2）：
 * 进页自动聚焦失效的根因是「自动发码的 busy 把验证码框 disabled」——浏览器
 * 禁用已聚焦的 input 会把焦点丢回 body，进页聚焦因此被发码时序绑架（发码
 * 慢则焦点迟到、探针下恒为 BODY，表现为时灵时不灵）。修复口径：发码不禁用
 * 验证码框、只有保存这种互斥提交才禁用。本测试钉住该性质：
 * - 发码全程验证码框不得 disabled，焦点进页即落入并保持；
 * - 保存期间验证码框禁用，保存成功回账号概览。
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
  authRequestPasswordCode,
  authSetPasswordWithCode,
} from '../../api/authApi';
import { useAccountUiStore } from '../../store/accountUiStore';

vi.mock('../../api/authApi', () => ({
  authRequestPasswordCode: vi.fn(),
  authSetPasswordWithCode: vi.fn(),
}));

vi.mock('../../store/storeAccess', () => ({
  useAuthField: (selector: (state: unknown) => unknown) =>
    selector({
      user: { email: 'user@example.com' },
      profile: { email: 'user@example.com' },
      completeLogin: vi.fn(async () => undefined),
    }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushFrames = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });

beforeEach(() => {
  vi.mocked(authRequestPasswordCode).mockReset();
  vi.mocked(authSetPasswordWithCode).mockReset();
  useAccountUiStore.setState({ view: 'changePassword', loginOpen: false });
});

afterEach(() => {
  cleanup();
});

describe('ChangePasswordPane 进页聚焦与发码/保存禁用口径', () => {
  it('自动发码进行中验证码框不禁用，焦点进页即落入并保持', async () => {
    const send = deferred<void>();
    vi.mocked(authRequestPasswordCode).mockReturnValue(send.promise);
    render(<ChangePasswordPane />);

    const input = screen.getByLabelText('6 位验证码') as HTMLInputElement;
    // 发码请求尚未返回：旧实现此处 disabled=true，浏览器会把焦点丢回 body
    expect(input.disabled).toBe(false);

    await flushFrames();
    expect(document.activeElement).toBe(input);

    // 发码完成（含倒计时启动与重渲染）后焦点仍在、仍可输入
    await act(async () => {
      send.resolve(undefined);
    });
    await flushFrames();
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('保存期间验证码框禁用，保存成功回到账号概览', async () => {
    vi.mocked(authRequestPasswordCode).mockResolvedValue(undefined);
    const saveReq = deferred<unknown>();
    vi.mocked(authSetPasswordWithCode).mockReturnValue(
      saveReq.promise as never
    );
    render(<ChangePasswordPane />);

    const input = screen.getByLabelText('6 位验证码') as HTMLInputElement;
    await flushFrames();
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('新密码'), {
      target: { value: 'newpass123' },
    });

    const saveBtn = screen.getByRole('button', { name: '保存' });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    fireEvent.click(saveBtn);

    // 保存请求未返回：验证码框禁用（互斥提交）
    await waitFor(() => expect(input.disabled).toBe(true));

    await act(async () => {
      saveReq.resolve({});
    });
    await waitFor(() =>
      expect(useAccountUiStore.getState().view).toBe('overview')
    );
  });
});
