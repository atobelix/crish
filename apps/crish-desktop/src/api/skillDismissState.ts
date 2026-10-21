/**
 * 技能卸载标记持久化服务。
 * 发现结果仍可能扫到原文件，界面以这份名单决定「未安装 / 可重新导入」。
 */

import { normalizeSlashName } from './skillsApiHelpers';

export const SKILL_DISMISSED_KEY = 'crish_skills_uninstalled_v1';

function dismissedKeysOf(name: string): string[] {
  const lower = name.trim().toLowerCase();
  const slug = normalizeSlashName(name);
  return [lower, slug].filter(
    (key, index, all) => key && all.indexOf(key) === index
  );
}

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(SKILL_DISMISSED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return new Set();
    return new Set(
      arr.map((item) => String(item).toLowerCase()).filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function writeDismissed(keys: Set<string>): void {
  localStorage.setItem(SKILL_DISMISSED_KEY, JSON.stringify([...keys]));
}

export function isSkillDismissed(name: string): boolean {
  if (!name.trim()) return false;
  const stored = readDismissed();
  return dismissedKeysOf(name).some((key) => stored.has(key));
}

export function setSkillDismissed(name: string, dismissed: boolean): void {
  const stored = readDismissed();
  for (const key of dismissedKeysOf(name)) {
    if (dismissed) stored.add(key);
    else stored.delete(key);
  }
  writeDismissed(stored);
}

/** 安装 / 卸载后立刻通知扩展页重算，不等待整页刷新。 */
export function notifyExtensionLifecycle(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('crish-extensions-changed'));
}
