/**
 * 设置 · 快捷键：纯展示/校验辅助函数与常量（从 SettingsShortcutsTab 拆出，
 * 供组件与测试共用）。无 React 依赖，便于单测与 tree-shake。
 *
 * 展示元表 id → { group, desc }：仅承载设置页独有的展示维度（分组/说明），
 * label 与 defaultBinding 一律取自 ShortcutRegistry（单一真源）——本表不参与
 * 执行，防止绑定/文案双源漂移。
 */
import { BUILTIN_SHORTCUTS } from '../../services/ShortcutRegistry';
import { configService } from '../../services/ConfigService';

export const SHORTCUT_DISPLAY: Record<string, { group: string; desc: string }> =
  {
    toggle_settings: { group: '系统', desc: '打开或关闭' },
    open_models: { group: '系统', desc: '打开模型设置' },
    open_usage: { group: '系统', desc: '打开用量' },
    open_security: { group: '系统', desc: '权限与白名单' },
    open_shortcuts: { group: '系统', desc: '打开本页' },
    open_extensions: { group: '系统', desc: '插件、MCP、技能' },
    open_schedule: { group: '系统', desc: '打开定时任务' },
    export_logs: { group: '系统', desc: '导出诊断日志' },
    new_session: { group: '会话', desc: '开始新会话' },
    focus_composer: { group: '会话', desc: '定位到输入框' },
    branch_session: { group: '会话', desc: '从当前对话分出一支' },
    stop_generation: { group: '会话', desc: '中断输出' },
    toggle_plan_mode: { group: '会话', desc: '切换计划权限' },
    toggle_sidebar: { group: '工作区', desc: '展开或收起' },
  };

export type ShortcutItem = {
  id: string;
  label: string;
  desc: string;
  group: string;
  binding: string;
};

/** 从注册表派生展示行：行顺序 = 注册表顺序，label/binding 单一真源（T2-3） */
export function buildShortcutItems(): ShortcutItem[] {
  return BUILTIN_SHORTCUTS.map((meta) => {
    const display = SHORTCUT_DISPLAY[meta.id] ?? { group: '其他', desc: '' };
    return {
      id: meta.id,
      label: meta.label,
      desc: display.desc,
      group: display.group,
      binding: meta.defaultBinding,
    };
  });
}

export const SHORTCUT_ITEMS = buildShortcutItems();

/** 默认绑定真源 = 注册表 defaultBinding（无该 id 时返回空串，上游调用方以空值兜底） */
export function defaultBindingOf(id: string): string {
  return BUILTIN_SHORTCUTS.find((m) => m.id === id)?.defaultBinding ?? '';
}

/** 键名片段 → 中文展示（存储仍为英文 token，仅 UI 本地化） */
export const KEY_PART_ZH: Record<string, string> = {
  Ctrl: 'Ctrl',
  Control: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
  Meta: 'Win',
  Command: '⌘',
  Cmd: '⌘',
  Escape: 'Esc',
  Esc: 'Esc',
  Space: '空格',
  Enter: '回车',
  Return: '回车',
  Backspace: '退格',
  Delete: '删除',
  Del: '删除',
  Tab: 'Tab',
  Insert: '插入',
  Home: 'Home',
  End: 'End',
  PageUp: '上页',
  PageDown: '下页',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  MiddleClick: '鼠标中键',
  Middle: '鼠标中键',
  LeftClick: '鼠标左键',
  RightClick: '鼠标右键',
  DoubleClick: '双击',
  Click: '单击',
};

export function normalizeKeyPart(raw: string): string {
  return raw.trim();
}

export function formatShortcutLabel(raw: string | undefined | null): string {
  if (raw == null) return '未设置';
  const s = String(raw).trim();
  if (!s) return '未设置';
  if (!s.includes('+') && /\s+/.test(s)) {
    const parts = s.split(/\s+/).map(normalizeKeyPart).filter(Boolean);
    if (parts.length >= 2 && parts.every((p) => p === parts[0])) {
      const k = parts[0];
      if (k) return `双击 ${KEY_PART_ZH[k] || k}`;
    }
    return parts.map((p) => KEY_PART_ZH[p] || p).join(' · ');
  }
  const combo = s
    .split(/\s*\+\s*/)
    .map(normalizeKeyPart)
    .filter(Boolean);
  if (combo.length === 0) return '未设置';
  return combo.map((p) => KEY_PART_ZH[p] || p).join(' + ');
}

export function isValidShortcutValue(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 64;
}

export function loadShortcuts(): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const item of SHORTCUT_ITEMS) defaults[item.id] = item.binding;
  try {
    const saved = configService.get<Record<string, string>>(
      'shortcuts.overrides'
    );
    const merged: Record<string, string> = { ...defaults };
    for (const item of SHORTCUT_ITEMS) {
      const v = saved[item.id];
      if (isValidShortcutValue(v)) merged[item.id] = v.trim();
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function findConflict(
  map: Record<string, string>,
  id: string,
  key: string
): ShortcutItem | null {
  const hit = SHORTCUT_ITEMS.find(
    (item) => item.id !== id && (map[item.id] || '') === key
  );
  return hit ?? null;
}

export function isCustomized(map: Record<string, string>, id: string): boolean {
  const cur = (map[id] || '').trim();
  const def = defaultBindingOf(id).trim();
  return Boolean(cur) && cur !== def;
}

/** 快捷键分组键：设置页展示分组（从 SettingsShortcutsTab 拆出，tab 侧 re-export 保持兼容） */
export type ShortcutCategoryKey = 'system' | 'session' | 'workspace' | 'other';

export const SHORTCUT_CATEGORY_MAP: Record<string, ShortcutCategoryKey> = {
  toggle_settings: 'system',
  open_models: 'system',
  open_usage: 'system',
  open_security: 'system',
  open_shortcuts: 'system',
  open_extensions: 'system',
  open_schedule: 'system',
  export_logs: 'system',
  new_session: 'session',
  focus_composer: 'session',
  branch_session: 'session',
  stop_generation: 'session',
  toggle_plan_mode: 'session',
  toggle_sidebar: 'workspace',
};

export const CATEGORY_I18N_KEYS: Record<
  ShortcutCategoryKey,
  { key: string; fallback: string }
> = {
  system: { key: 'settings.shortcuts.groupGlobal', fallback: '全局快捷键' },
  session: { key: 'settings.shortcuts.groupChat', fallback: '对话与编辑' },
  workspace: {
    key: 'settings.shortcuts.groupNavigation',
    fallback: '界面导航',
  },
  other: { key: 'common.more', fallback: '其他' },
};

/** 键盘事件 → 快捷键组合 token（与原 SettingsShortcutsTab 录制逻辑一致）；仅修饰键未成完整组合时返回 null */
export function eventToShortcutKeys(e: KeyboardEvent): string[] | null {
  const keys: string[] = [];
  if (e.ctrlKey) keys.push('Ctrl');
  if (e.shiftKey) keys.push('Shift');
  if (e.altKey) keys.push('Alt');
  if (e.metaKey) keys.push('Meta');
  if (
    !['Control', 'Shift', 'Alt', 'Meta', 'Process', 'Unidentified'].includes(
      e.key
    )
  ) {
    let keyName = e.key;
    if (keyName === ' ') keyName = 'Space';
    keys.push(keyName.length === 1 ? keyName.toUpperCase() : keyName);
  }

  // 仅修饰键：继续等待完整组合
  if (
    keys.length === 0 ||
    keys.every((k) => ['Ctrl', 'Shift', 'Alt', 'Meta'].includes(k))
  ) {
    return null;
  }
  return keys;
}
