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
import { useToast } from '../../services/toast/ToastContext';
import {
  SHORTCUT_ITEMS,
  defaultBindingOf,
  formatShortcutLabel,
  loadShortcuts,
  findConflict,
  isCustomized,
  buildShortcutItems,
  type ShortcutItem,
} from './SettingsShortcutsHelpers';

// 单源契约测试仍从本文件 import buildShortcutItems（T2-5），这里 re-export 保持兼容
export { buildShortcutItems };
export type { ShortcutItem };

export const SettingsShortcutsTab: React.FC = () => {
  const { showToast } = useToast();
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
        showToast('保存失败：无法写入快捷键', undefined, { type: 'error' });
        return false;
      }
    },
    [showToast],
  );

  const restoreDefault = useCallback(
    (id: string) => {
      const def = defaultBindingOf(id);
      if (!def) return;
      if ((customShortcuts[id] || '') === def) return;
      const conflict = findConflict(customShortcuts, id, def);
      if (conflict) {
        showToast(`恢复失败：与「${conflict.label}」键位冲突`, undefined, { type: 'error' });
        return;
      }
      const updated = { ...customShortcuts, [id]: def };
      // 成功静默
      persist(updated);
      if (recordingShortcutId === id) setRecordingShortcutId(null);
    },
    [customShortcuts, showToast, persist, recordingShortcutId],
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
        showToast(`录制失败：与「${conflict.label}」键位冲突`, undefined, { type: 'error' });
        return;
      }

      const updated = { ...customShortcuts, [recordingShortcutId]: newKey };
      setRecordingShortcutId(null);
      // 成功：按钮文案即时更新，绝不 toast
      persist(updated);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingShortcutId, customShortcuts, showToast, persist]);

  const hasQuery = query.trim().length > 0;
  const customCount = useMemo(
    () => SHORTCUT_ITEMS.filter((s) => isCustomized(customShortcuts, s.id)).length,
    [customShortcuts],
  );

  const recordingItem = recordingShortcutId
    ? SHORTCUT_ITEMS.find((s) => s.id === recordingShortcutId) ?? null
    : null;

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
