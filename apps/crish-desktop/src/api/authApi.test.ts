/**
 * authApi 账号命令映射：
 * - 先码后密码（发码 / 凭码设密）与注销的 invoke 参数透传；
 * - 成功返回映射与失败分类（rejected / unavailable）。
 */
import { describe, expect, it } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../test-setup';
import {
  AuthApiError,
  authDeleteAccount,
  authRequestPasswordCode,
  authSetPasswordWithCode,
} from './authApi';

describe('authApi 账号命令', () => {
  it('发码：透传 scene / email 并返回票据', async () => {
    let received: unknown = null;
    mockTauriCommand('auth_request_password_code', (args) => {
      received = args;
      return { ok: true, expiresIn: 600, resendAfter: 60 };
    });

    const ticket = await authRequestPasswordCode({
      scene: 'register',
      email: 'a@b.co',
    });

    expect(received).toEqual({ scene: 'register', email: 'a@b.co' });
    expect(ticket).toMatchObject({ ok: true, expiresIn: 600, resendAfter: 60 });
  });

  it('设密：透传 scene / email / code / password 并返回用户', async () => {
    let received: unknown = null;
    mockTauriCommand('auth_set_password_with_code', (args) => {
      received = args;
      return { id: 'acc-1', email: 'a@b.co' };
    });

    const user = await authSetPasswordWithCode({
      scene: 'reset',
      email: 'a@b.co',
      code: '123456',
      password: 'a-strong-password',
    });

    expect(received).toEqual({
      scene: 'reset',
      email: 'a@b.co',
      code: '123456',
      password: 'a-strong-password',
    });
    expect(user).toEqual({ id: 'acc-1', email: 'a@b.co' });
  });

  it('注销：透传 confirmEmail', async () => {
    let received: unknown = null;
    mockTauriCommand('auth_delete_account', (args) => {
      received = args;
      return null;
    });

    await authDeleteAccount('a@b.co');

    expect(received).toEqual({ confirmEmail: 'a@b.co' });
  });

  it('业务拒绝映射为 rejected 并保留服务端文案', async () => {
    mockTauriError('auth_request_password_code', {
      kind: 'InvalidInput',
      detail: 'send_cooldown',
    });

    await expect(
      authRequestPasswordCode({ scene: 'register', email: 'a@b.co' })
    ).rejects.toMatchObject({
      name: 'AuthApiError',
      kind: 'rejected',
      message: 'send_cooldown',
    } satisfies Partial<AuthApiError>);
  });

  it('命令缺失映射为 unavailable', async () => {
    await expect(authDeleteAccount('a@b.co')).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});
