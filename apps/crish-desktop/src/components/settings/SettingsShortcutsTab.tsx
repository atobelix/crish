/**
 * 设置 · 快捷键：查看与改键；成功静默，冲突/写入失败才提示。
 */
import { useId, useState, useMemo, useCallback, useRef, useEffect } from 'react';
import styles from './SettingsShortcutsTab.module.css';
import { clientApi } from '../../api/clientApi';
import { configService } from '../../services/ConfigService';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Tooltip } from '../ui';
import { BUILTIN_SHORTCUTS } from '../../services/ShortcutRegistry';

type Props = {
  onShowToast: (msg: string) => void;
};

/**
 * 展示元表：id → { group, desc }。
 * 仅承载设置页独有的展示维度（分组/说明），label 与 defaultBinding 一律取自
 * ShortcutRegistry（单一真源）——本表不参与执行，防止绑定/文案双源漂移。
 */
const SHORTCUT_DISPLAY: Record<string, { group: string; desc: string }> = {
  toggle_settings: { group: '系统', desc: '打开或关闭' },
  open_models: { group: '系统', desc: '打开模型设置' },
  open_usage: { group: '系统', desc: '打开用量' },
  open_security: { group: '系统', desc: '权限与白名单' },
  open_shortcuts: { group: '系统', desc: '打开本页' },
  open_extensions: { group: '系统', desc: '插件、MCP、技能' },
  open_schedule: { group: '系统', desc: '打开定时任务' },
  export_logs: { group: '系统', desc: '导出诊断日志' },
  cheatsheet: { group: '系统', desc: '快捷键一览' },
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

const SHORTCUT_ITEMS = buildShortcutItems();

/** 默认绑定真源 = 注册表 defaultBinding（无该 id 时返回空串，上游调用方以空值兜底） */
function defaultBindingOf(id: string): string {
  return BUILTIN_SHORTCUTS.find((m) => m.id === id)?.defaultBinding ?? '';
}


/** 键名片段 → 中文展示（存储仍为英文 token，仅 UI 本地化） */
const KEY_PART_ZH: Record<string, string> = {
  Ctrl: 'Ctrl', Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Win',
  Command: '⌘', Cmd: '⌘', Escape: 'Esc', Esc: 'Esc', Space: '空格',
  Enter: '回车', Return: '回车', Backspace: '退格', Delete: '删除', Del: '删除',
  Tab: 'Tab', Insert: '插入', Home: 'Home', End: 'End', PageUp: '上页', PageDown: '下页',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
  MiddleClick: '鼠标中键', Middle: '鼠标中键', LeftClick: '鼠标左键',
  RightClick: '鼠标右键', DoubleClick: '双击', Click: '单击',
};

function normalizeKeyPart(raw: string): string { return raw.trim(); }

function formatShortcutLabel(raw: string | undefined | null): string {
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
  const combo = s.split(/\s*\+\s*/).map(normalizeKeyPart).filter(Boolean);
  if (combo.length === 0) return '未设置';
  return combo.map((p) => KEY_PART_ZH[p] || p).join(' + ');
}

/** 改键后全局立即生效 */


function isValidShortcutValue(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 64;
}

function loadShortcuts(): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const item of SHORTCUT_ITEMS) defaults[item.id] = item.binding;
  try {
    const saved = configService.get<Record<string, string>>('shortcuts.overrides');
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

function findConflict(
  map: Record<string, string>,
  id: string,
  key: string,
): ShortcutItem | null {
  const hit = SHORTCUT_ITEMS.find(
    (item) => item.id !== id && (map[item.id] || '') === key,
  );
  return hit ?? null;
}

function isCustomized(map: Record<string, string>, id: string): boolean {
  const cur = (map[id] || '').trim();
  const def = defaultBindingOf(id).trim();
  return Boolean(cur) && cur !== def;
}

export const SettingsShortcutsTab: React.FC<Props> = ({ onShowToast }) => {
  const [customShortcuts, setCustomShortcuts] = useState<Record<string, string>>(loadShortcuts);
  const [recordingShortcutId, setRecordingShortcutId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [focusIndex, setFocusIndex] = useState(0);

  const filterId = useId();
  const headMetaId = useId();
  const listId = useId();
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_ITEMS.slice();
    return SHORTCUT_ITEMS.filter((sh) => {
      const keyRaw = customShortcuts[sh.id] || '';
      const keyZh = formatShortcutLabel(keyRaw);
      return (
        sh.label.toLowerCase().includes(q) ||
        sh.desc.toLowerCase().includes(q) ||
        sh.group.toLowerCase().includes(q) ||
        sh.id.toLowerCase().includes(q) ||
        keyRaw.toLowerCase().includes(q) ||
        keyZh.toLowerCase().includes(q)
      );
    });
  }, [query, customShortcuts]);

  const grouped = useMemo(() => {
    const map = new Map<string, ShortcutItem[]>();
    for (const item of filtered) {
      const list = map.get(item.group) || [];
      list.push(item);
      map.set(item.group, list);
    }
    return Array.from(map.entries());
  }, [filtered]);

  /** 扁平索引：与键盘列表顺序一致 */
  const flatIds = useMemo(() => filtered.map((s) => s.id), [filtered]);

  useEffect(() => {
    // 筛选变化时把焦点索引钳到合法范围
    setFocusIndex((i) => {
      if (flatIds.length === 0) return 0;
      return Math.min(Math.max(0, i), flatIds.length - 1);
    });
  }, [flatIds]);

  const persist = useCallback(
    (updated: Record<string, string>): boolean => {
      try {
        configService.set('shortcuts.overrides', updated);
        setCustomShortcuts(updated);
        try {
          clientApi.saveSettingsEx('__global__', 'global', {
            shortcuts: updated,
          }).catch(() => {
            /* swallow-ok: 远端保存失败时本地已生效，不阻断用户操作 */
          });
        } catch { /* 远端保存失败时本地已生效，不阻断 */ }
        return true;
      } catch {
        onShowToast('保存失败：无法写入快捷键');
        return false;
      }
    },
    [onShowToast],
  );

  const restoreDefault = useCallback(
    (id: string) => {
      const def = defaultBindingOf(id);
      if (!def) return;
      if ((customShortcuts[id] || '') === def) return;
      const conflict = findConflict(customShortcuts, id, def);
      if (conflict) {
        onShowToast(`恢复失败：与「${conflict.label}」键位冲突`);
        return;
      }
      const updated = { ...customShortcuts, [id]: def };
      // 成功静默
      persist(updated);
      if (recordingShortcutId === id) setRecordingShortcutId(null);
    },
    [customShortcuts, onShowToast, persist, recordingShortcutId],
  );

  useEffect(() => {
    if (!recordingShortcutId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        setRecordingShortcutId(null);
        return;
      }

      const keys: string[] = [];
      if (e.ctrlKey) keys.push('Ctrl');
      if (e.shiftKey) keys.push('Shift');
      if (e.altKey) keys.push('Alt');
      if (e.metaKey) keys.push('Meta');
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        let keyName = e.key;
        if (keyName === ' ') keyName = 'Space';
        keys.push(keyName.length === 1 ? keyName.toUpperCase() : keyName);
      }

      // 仅修饰键：继续等待完整组合
      if (keys.length === 0 || keys.every((k) => ['Ctrl', 'Shift', 'Alt', 'Meta'].includes(k))) {
        return;
      }

      const newKey = keys.join(' + ');
      const conflict = findConflict(customShortcuts, recordingShortcutId, newKey);
      if (conflict) {
        setRecordingShortcutId(null);
        onShowToast(`录制失败：与「${conflict.label}」键位冲突`);
        return;
      }

      const updated = { ...customShortcuts, [recordingShortcutId]: newKey };
      setRecordingShortcutId(null);
      // 成功：按钮文案即时更新，绝不 toast
      persist(updated);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingShortcutId, customShortcuts, onShowToast, persist]);

  const hasQuery = query.trim().length > 0;
  const customCount = useMemo(
    () => SHORTCUT_ITEMS.filter((s) => isCustomized(customShortcuts, s.id)).length,
    [customShortcuts],
  );

  const recordingItem = recordingShortcutId
    ? SHORTCUT_ITEMS.find((s) => s.id === recordingShortcutId) ?? null
    : null;

  const filterTitle = recordingItem
    ? `录制中 · Esc 取消`
    : hasQuery
      ? 'Esc 清空筛选'
      : '点击右侧按键可改快捷键';

  const headMetaText = recordingItem
    ? `录制中 · ${recordingItem.label}`
    : hasQuery
      ? `${filtered.length} 个结果`
      : customCount > 0
        ? `已改 ${customCount} 项`
        : '';

  const clearQuery = useCallback(() => setQuery(''), []);

  const moveFocus = useCallback(
    (delta: number) => {
      if (flatIds.length === 0) return;
      setFocusIndex((prev) => {
        const next = (prev + delta + flatIds.length) % flatIds.length;
        // 下一帧聚焦按钮
        requestAnimationFrame(() => {
          btnRefs.current[next]?.focus();
        });
        return next;
      });
    },
    [flatIds.length],
  );

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (recordingShortcutId) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveFocus(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setFocusIndex(0);
        requestAnimationFrame(() => btnRefs.current[0]?.focus());
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = Math.max(0, flatIds.length - 1);
        setFocusIndex(last);
        requestAnimationFrame(() => btnRefs.current[last]?.focus());
      }
    },
    [flatIds.length, moveFocus, recordingShortcutId],
  );

  let flatIdx = -1;

  const headerMeta = (
    <div className="settings-head-tools settings-head-tools--shortcuts">
      <input
        id={filterId}
        type="search"
        className="settings-field-input settings-field-input--sm settings-field-input--w160 settings-shortcuts-filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索…"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="搜索快捷键"
        aria-controls={listId}
        aria-describedby={headMetaId}
        title={filterTitle}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            if (recordingShortcutId) {
              setRecordingShortcutId(null);
            } else if (query) {
              clearQuery();
            }
          } else if (e.key === 'ArrowDown' && flatIds.length > 0) {
            e.preventDefault();
            requestAnimationFrame(() => btnRefs.current[focusIndex]?.focus());
          }
        }}
      />
      {hasQuery ? (
        <Tooltip content="清空筛选">
          <button
            type="button"
            className="settings-shortcuts-filter-clear"
            onClick={clearQuery}
            aria-label="清空筛选"
          >
            清空
          </button>
        </Tooltip>
      ) : null}
      {headMetaText ? (
        <span
          id={headMetaId}
          className="settings-head-meta"
          title={filterTitle}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {headMetaText}
        </span>
      ) : (
        <span id={headMetaId} className="sr-only" />
      )}
    </div>
  );

  return (
    <SettingsPage title="快捷键" meta={headerMeta}>
      {grouped.length === 0 ? (
        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              title={hasQuery ? `无匹配「${query.trim()}」` : '暂无快捷键'}
              desc={hasQuery ? '试试更短关键词，或清空筛选' : ''}
              control={
                hasQuery ? (
                  <Tooltip content="清空筛选">
                    <button
                      type="button"
                      className="settings-shortcuts-filter-clear"
                      onClick={clearQuery}
                      aria-label="清空筛选并显示全部快捷键"
                    >
                      清空筛选
                    </button>
                  </Tooltip>
                ) : null
              }
            />
          </SettingsCard>
        </SettingsSection>
      ) : (
        <div id={listId} aria-labelledby={`${listId}-title`} onKeyDown={onListKeyDown}>
          {grouped.map(([groupName, items]) => {
            return (
              <SettingsSection key={groupName} title={groupName}>
                <SettingsCard>
                  {items.map((sh) => {
                    flatIdx += 1;
                    const rowIndex = flatIdx;
                    const isRecording = recordingShortcutId === sh.id;
                    const rawKey = customShortcuts[sh.id] || '';
                    const displayKey = formatShortcutLabel(rawKey || undefined);
                    const customized = isCustomized(customShortcuts, sh.id);
                    const tabIndex =
                      flatIds.length === 0
                        ? -1
                        : rowIndex === focusIndex
                          ? 0
                          : -1;

                    return (
                      <SettingsRow
                        key={sh.id}
                        title={sh.label}
                        desc={sh.desc}
                        control={
                          <div className={`settings-list-control settings-list-control--shortcuts ${styles.controlGroup}`}>
                            {customized && !isRecording ? (
                              <Tooltip content={`恢复默认：${formatShortcutLabel(defaultBindingOf(sh.id))}`}>
                                <button
                                  type="button"
                                  className="settings-shortcuts-filter-clear"
                                  onClick={() => restoreDefault(sh.id)}
                                  aria-label={`恢复「${sh.label}」为默认 ${formatShortcutLabel(defaultBindingOf(sh.id))}`}
                                >
                                  还原
                                </button>
                              </Tooltip>
                            ) : null}
                            <Tooltip content={
                              isRecording
                                ? '按键录制中，Esc 取消'
                                : `当前：${displayKey}，点击重新录制`
                            }>
                              <button
                                type="button"
                                ref={(el) => {
                                  btnRefs.current[rowIndex] = el;
                                }}
                                onClick={() =>
                                  setRecordingShortcutId(isRecording ? null : sh.id)
                                }
                                onFocus={() => setFocusIndex(rowIndex)}
                                className={`shortcut-key-btn ${isRecording ? 'recording' : ''}`}
                                aria-pressed={isRecording}
                                aria-label={
                                  isRecording
                                    ? `正在录制「${sh.label}」，按键设置，Esc 取消`
                                    : `「${sh.label}」当前 ${displayKey}，点击重新录制`
                                }
                                tabIndex={tabIndex}
                              >
                                {isRecording ? '按下新键…' : displayKey}
                              </button>
                            </Tooltip>
                          </div>
                        }
                      />
                    );
                  })}
                </SettingsCard>
              </SettingsSection>
            );
          })}
        </div>
      )}
    </SettingsPage>
  );
};
