/**
 * 设置页「AI 辅助创建」→ 主对话输入框种子文案。
 * sessionStorage 短键 + 自定义事件，避免改 store 形态。
 */

const KEY = 'crish_composer_seed_v1';
export const COMPOSER_SEED_EVENT = 'crish-composer-seed';

export function setComposerSeed(text: string): void {
  const t = (text || '').trim();
  if (!t) return;
  try {
    sessionStorage.setItem(KEY, t);
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(
      new CustomEvent(COMPOSER_SEED_EVENT, { detail: { text: t } }),
    );
  } catch {
    /* ignore */
  }
}

/** 读取并清除；无种子返回 null */
export function takeComposerSeed(): string | null {
  try {
    const t = sessionStorage.getItem(KEY);
    if (!t) return null;
    sessionStorage.removeItem(KEY);
    return t.trim() || null;
  } catch {
    return null;
  }
}
