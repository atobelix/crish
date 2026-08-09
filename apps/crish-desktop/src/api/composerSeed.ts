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
    /* swallow-ok: 隐私模式下 sessionStorage 不可用，种子仅本次内存 */
  }
  try {
    window.dispatchEvent(
      new CustomEvent(COMPOSER_SEED_EVENT, { detail: { text: t } }),
    );
  } catch {
    /* swallow-ok: 种子事件分发失败不影响已写入的种子文本 */
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
