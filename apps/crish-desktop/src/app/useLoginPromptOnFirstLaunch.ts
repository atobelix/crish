/**
 * 首次启动登录引导：本地从未登录且没有已保存会话时，自动打开设置「账户」并弹出登录弹窗。
 * 只提示一次（localStorage 标记）；用户关掉后不再自动弹。
 * 不恢复 App.tsx 全局挂载 AccountCenterDialog 的旧做法：借 settings overlay 挂载
 * AccountAuthCard，再经 accountUiStore.openLogin 打开其承载的登录弹窗。
 */
import { useEffect } from 'react';
import { useAccountUiStore } from '../store/accountUiStore';
import { openSettings } from '../store/settingsUiStore';
import { useAuthField } from '../store/storeAccess';

export const LOGIN_PROMPT_SHOWN_KEY = 'crish_login_prompt_shown_v1';

export function shouldAutoPromptLogin(input: {
  enabled: boolean;
  initialized: boolean;
  isLoggedIn: boolean;
  dismissed: boolean;
}): boolean {
  return (
    input.enabled && input.initialized && !input.isLoggedIn && !input.dismissed
  );
}

function hasPrompted(): boolean {
  try {
    return localStorage.getItem(LOGIN_PROMPT_SHOWN_KEY) === '1';
  } catch {
    // 存储不可用时宁可不弹，避免每次启动重复打扰
    return true;
  }
}

function markPrompted(): void {
  try {
    localStorage.setItem(LOGIN_PROMPT_SHOWN_KEY, '1');
  } catch {
    // swallow-ok: 标记写失败只会导致下次再弹一次，不影响主流程
  }
}

export function useLoginPromptOnFirstLaunch(enabled: boolean): void {
  const initialized = useAuthField((state) => state.initialized);
  const isLoggedIn = useAuthField((state) => state.isLoggedIn);
  const initSession = useAuthField((state) => state.initSession);

  // 提前初始化会话快照，判断是否存在已保存的登录态
  useEffect(() => {
    if (!enabled || initialized) return;
    void initSession();
  }, [enabled, initialized, initSession]);

  useEffect(() => {
    if (
      !shouldAutoPromptLogin({
        enabled,
        initialized,
        isLoggedIn,
        dismissed: hasPrompted(),
      })
    ) {
      return;
    }
    markPrompted();
    openSettings('profile');
    useAccountUiStore.getState().openLogin();
  }, [enabled, initialized, isLoggedIn]);
}
