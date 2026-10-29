import { describe, expect, it } from 'vitest';
import { shouldAutoPromptLogin } from './useLoginPromptOnFirstLaunch';

describe('首次启动登录引导', () => {
  it('仅在已初始化、未登录且未提示过时弹出', () => {
    expect(
      shouldAutoPromptLogin({
        enabled: false,
        initialized: true,
        isLoggedIn: false,
        dismissed: false,
      })
    ).toBe(false);
    expect(
      shouldAutoPromptLogin({
        enabled: true,
        initialized: false,
        isLoggedIn: false,
        dismissed: false,
      })
    ).toBe(false);
    expect(
      shouldAutoPromptLogin({
        enabled: true,
        initialized: true,
        isLoggedIn: true,
        dismissed: false,
      })
    ).toBe(false);
    expect(
      shouldAutoPromptLogin({
        enabled: true,
        initialized: true,
        isLoggedIn: false,
        dismissed: true,
      })
    ).toBe(false);
    expect(
      shouldAutoPromptLogin({
        enabled: true,
        initialized: true,
        isLoggedIn: false,
        dismissed: false,
      })
    ).toBe(true);
  });
});
