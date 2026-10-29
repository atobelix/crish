/**
 * 账号身份推导：头像地址解析、显示名回落顺序、首字母。
 */
import { describe, expect, it } from 'vitest';
import { AUTH_BASE_URL } from '../../api/authApi';
import {
  accountDisplayName,
  accountInitial,
  resolveAvatarUrl,
} from './accountIdentity';

describe('accountIdentity', () => {
  it('头像地址：空值为 null，绝对地址原样，相对路径拼账号中心地址', () => {
    expect(resolveAvatarUrl(null)).toBeNull();
    expect(resolveAvatarUrl('')).toBeNull();
    expect(resolveAvatarUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png'
    );
    expect(resolveAvatarUrl('/files/a.png')).toBe(
      `${AUTH_BASE_URL}/files/a.png`
    );
  });

  it('显示名：昵称优先，其次账号名，最后邮箱前缀', () => {
    const user = { id: 'u1', email: 'lin@example.com', name: 'Lin' };
    const profile = {
      accountId: 'u1',
      email: 'lin@example.com',
      displayName: '林',
      bio: '',
    };
    expect(accountDisplayName(user, profile)).toBe('林');
    expect(accountDisplayName(user, { ...profile, displayName: '' })).toBe(
      'Lin'
    );
    expect(accountDisplayName({ ...user, name: null }, null)).toBe('lin');
    expect(accountDisplayName(null, null)).toBe('');
  });

  it('首字母：去空白后取首字并大写', () => {
    expect(accountInitial('  lin')).toBe('L');
    expect(accountInitial('')).toBe('');
  });
});
