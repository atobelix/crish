/**
 * 自定义快捷键读取与匹配。
 * 仅负责解析；触发动作由 App 壳层完成。
 */

import { configService } from '../services/ConfigService';

/** 与设置页 DEFAULT 对齐（新增 id 须同步 SettingsShortcutsTab） */
export const DEFAULT_SHORTCUT_BINDINGS: Record<string, string> = {
  toggle_settings: 'Ctrl + ,',
  new_session: 'Ctrl + N',
  focus_composer: 'Ctrl + L',
  branch_session: 'Escape Escape',
  command_palette: '/',
  stop_generation: 'Ctrl + Shift + Backspace',
  open_models: 'Ctrl + Shift + M',
  open_usage: 'Ctrl + Shift + U',
  open_security: 'Ctrl + Shift + E',
  open_shortcuts: 'Ctrl + Shift + K',
  open_extensions: 'Ctrl + Shift + X',
  open_schedule: 'Ctrl + Shift + J',
  toggle_sidebar: 'Ctrl + B',
  toggle_runtime: 'Ctrl + `',
  toggle_plan_mode: 'Ctrl + Shift + P',
  cheatsheet: 'Ctrl + Shift + /',
};

export type ShortcutActionId = keyof typeof DEFAULT_SHORTCUT_BINDINGS | string;

export function loadShortcutBindings(): Record<string, string> {
  const base = { ...DEFAULT_SHORTCUT_BINDINGS };
  try {
    const saved = configService.get<Record<string, string>>('shortcuts.overrides');
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === 'string' && v.trim()) base[k] = v.trim();
    }
  } catch {
    /* keep defaults */
  }
  return base;
}

/** 将 KeyboardEvent 规范成与存储一致的「Ctrl + Shift + M」形态 */
export function eventToShortcutLabel(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key) return null;
  // 仅修饰键不构成快捷键
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');

  let token = key;
  if (key === ' ') token = 'Space';
  else if (key === 'Escape') token = 'Escape';
  else if (key === 'Backspace') token = 'Backspace';
  else if (key === 'Enter') token = 'Enter';
  else if (key === 'ArrowUp') token = 'ArrowUp';
  else if (key === 'ArrowDown') token = 'ArrowDown';
  else if (key === 'ArrowLeft') token = 'ArrowLeft';
  else if (key === 'ArrowRight') token = 'ArrowRight';
  else if (key.length === 1) token = key.toUpperCase();
  else if (key === '`') token = '`';
  else if (key === ',') token = ',';
  else if (key === '/') token = '/';

  parts.push(token);
  return parts.join(' + ');
}

function normalizeBinding(raw: string): string {
  return raw
    .split(/\s*\+\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (/^control$/i.test(p) || /^cmd$/i.test(p) || /^meta$/i.test(p)) return 'Ctrl';
      if (/^shift$/i.test(p)) return 'Shift';
      if (/^alt$/i.test(p)) return 'Alt';
      if (p.length === 1) return p.toUpperCase();
      return p;
    })
    .join(' + ');
}

/** 当前按键命中的动作 id 列表（可多绑定撞车时都返回） */
export function matchShortcutActions(e: KeyboardEvent): string[] {
  const label = eventToShortcutLabel(e);
  if (!label) return [];
  const norm = normalizeBinding(label);
  const map = loadShortcutBindings();
  const hits: string[] = [];
  for (const [id, binding] of Object.entries(map)) {
    if (!binding) continue;
    // 双击 Esc 等空格分隔序列不在此匹配
    if (!binding.includes('+') && /\s/.test(binding)) continue;
    if (normalizeBinding(binding) === norm) hits.push(id);
  }
  return hits;
}
