/**
 * 设置 · 快捷键：查看与改键；成功静默，冲突/写入失败才提示。
 */
import {
  useId,
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
} from 'react';
import styles from './SettingsShortcutsTab.module.css';
import { clientApi } from '../../api/clientApi';
import { configService } from '../../services/ConfigService';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsHeadTools,
} from './SettingsUI';
import uiStyles from './SettingsUI.module.css';
import { Button, Input, Tooltip } from '@/components/ui';
import { useToast } from '../../services/toast/ToastContext';
import { useI18n } from '../../i18n';
import {
  SHORTCUT_ITEMS,
  defaultBindingOf,
  formatShortcutLabel,
  loadShortcuts,
  findConflict,
  isCustomized,
  buildShortcutItems,
  eventToShortcutKeys,
  SHORTCUT_CATEGORY_MAP,
  CATEGORY_I18N_KEYS,
  type ShortcutCategoryKey,
  type ShortcutItem,
} from './SettingsShortcutsHelpers';

// 单源契约测试仍从本文件 import buildShortcutItems（T2-5），这里 re-export 保持兼容；
// 分类常量真源在 Helpers，tab 侧 re-export 维持对外导出面不变
export { buildShortcutItems, SHORTCUT_CATEGORY_MAP, CATEGORY_I18N_KEYS };
export type { ShortcutItem, ShortcutCategoryKey };

export const SettingsShortcutsTab: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [customShortcuts, setCustomShortcuts] =
    useState<Record<string, string>>(loadShortcuts);
  const [recordingShortcutId, setRecordingShortcutId] = useState<string | null>(
    null
  );
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
        (sh.desc ? sh.desc.toLowerCase().includes(q) : false) ||
        sh.group.toLowerCase().includes(q) ||
        sh.id.toLowerCase().includes(q) ||
        keyRaw.toLowerCase().includes(q) ||
        keyZh.toLowerCase().includes(q)
      );
    });
  }, [query, customShortcuts]);

  const grouped = useMemo(() => {
    const map = new Map<ShortcutCategoryKey, ShortcutItem[]>();
    for (const item of filtered) {
      const category: ShortcutCategoryKey =
        SHORTCUT_CATEGORY_MAP[item.id] ?? 'other';
      const list = map.get(category) || [];
      list.push(item);
      map.set(category, list);
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
          clientApi
            .saveSettingsEx('__global__', 'global', {
              shortcuts: updated,
            })
            .catch(() => {
              /* swallow-ok: 远端保存失败时本地已生效，不阻断用户操作 */
            });
        } catch {
          /* 远端保存失败时本地已生效，不阻断 */
        }
        return true;
      } catch {
        showToast(
          t('settings.shortcuts.saveFailed', '保存失败：无法写入快捷键'),
          undefined,
          { type: 'error' }
        );
        return false;
      }
    },
    [showToast, t]
  );

  const restoreDefault = useCallback(
    (id: string) => {
      const def = defaultBindingOf(id);
      if (!def) return;
      if ((customShortcuts[id] || '') === def) return;
      const conflict = findConflict(customShortcuts, id, def);
      if (conflict) {
        showToast(
          t(
            'settings.shortcuts.conflictWarning',
            `恢复失败：与「${conflict.label}」键位冲突`,
            {
              action: conflict.label,
            }
          ),
          undefined,
          { type: 'error' }
        );
        return;
      }
      const updated = { ...customShortcuts, [id]: def };
      // 成功静默
      persist(updated);
      if (recordingShortcutId === id) setRecordingShortcutId(null);
    },
    [customShortcuts, showToast, persist, recordingShortcutId, t]
  );

  useEffect(() => {
    if (!recordingShortcutId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return;
      if (e.key === 'Process' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();

      if (
        e.key === 'Escape' &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        setRecordingShortcutId(null);
        return;
      }

      const keys = eventToShortcutKeys(e);
      // 仅修饰键：继续等待完整组合
      if (!keys) return;

      const newKey = keys.join(' + ');
      const conflict = findConflict(
        customShortcuts,
        recordingShortcutId,
        newKey
      );
      if (conflict) {
        setRecordingShortcutId(null);
        showToast(
          t(
            'settings.shortcuts.conflictWarning',
            `录制失败：与「${conflict.label}」键位冲突`,
            {
              action: conflict.label,
            }
          ),
          undefined,
          { type: 'error' }
        );
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
    () =>
      SHORTCUT_ITEMS.filter((s) => isCustomized(customShortcuts, s.id)).length,
    [customShortcuts]
  );

  const recordingItem = recordingShortcutId
    ? (SHORTCUT_ITEMS.find((s) => s.id === recordingShortcutId) ?? null)
    : null;

  const headMetaText = recordingItem
    ? `${t('settings.shortcuts.recording', '录制中')} · ${recordingItem.label}`
    : hasQuery
      ? `${filtered.length} ${t('common.results', '个结果')}`
      : customCount > 0
        ? `${t('settings.shortcuts.customized', '已改')} ${customCount} ${t('common.items', '项')}`
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
    [flatIds.length]
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
    [flatIds.length, moveFocus, recordingShortcutId]
  );

  let flatIdx = -1;

  const headerMeta = (
    <SettingsHeadTools>
      <div className={uiStyles.filterInput}>
        <Input
          id={filterId}
          variant="search"
          size="sm"
          className={styles.shortcutSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t(
            'settings.shortcuts.searchPlaceholder',
            '搜索快捷键...'
          )}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label={t('settings.shortcuts.searchPlaceholder', '搜索快捷键')}
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
      </div>
      {hasQuery ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={clearQuery}
          aria-label={t('common.clear', '清空筛选')}
        >
          {t('common.clear', '清空')}
        </Button>
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
    </SettingsHeadTools>
  );

  return (
    <SettingsPage title={t('nav.shortcuts', '快捷键')} meta={headerMeta}>
      {grouped.length === 0 ? (
        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              title={
                hasQuery
                  ? t(
                      'settings.shortcuts.noMatch',
                      `无匹配「${query.trim()}」`,
                      { query: query.trim() }
                    )
                  : t('settings.shortcuts.empty', '暂无快捷键')
              }
              desc={
                hasQuery
                  ? t(
                      'settings.shortcuts.noMatchDesc',
                      '试试更短关键词，或清空筛选'
                    )
                  : ''
              }
              control={
                hasQuery ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearQuery}
                    aria-label={t(
                      'settings.shortcuts.clearFilterAria',
                      '清空筛选并显示全部快捷键'
                    )}
                  >
                    {t('settings.shortcuts.clearFilter', '清空筛选')}
                  </Button>
                ) : null
              }
            />
          </SettingsCard>
        </SettingsSection>
      ) : (
        <div
          id={listId}
          aria-labelledby={`${listId}-title`}
          onKeyDown={onListKeyDown}
        >
          {grouped.map(([categoryKey, items]) => {
            const config =
              CATEGORY_I18N_KEYS[categoryKey] ?? CATEGORY_I18N_KEYS.other;
            const groupTitle = t(config.key, config.fallback);
            return (
              <SettingsSection key={categoryKey} title={groupTitle}>
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
                        control={
                          <div
                            className={`settings-list-control settings-list-control--shortcuts ${styles.controlGroup}`}
                          >
                            {customized && !isRecording ? (
                              <Tooltip
                                content={t(
                                  'settings.shortcuts.restoreDefaultTooltip',
                                  `恢复默认：${formatShortcutLabel(defaultBindingOf(sh.id))}`,
                                  {
                                    default: formatShortcutLabel(
                                      defaultBindingOf(sh.id)
                                    ),
                                  }
                                )}
                              >
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => restoreDefault(sh.id)}
                                  aria-label={t(
                                    'settings.shortcuts.restoreDefaultAria',
                                    `恢复「${sh.label}」为默认 ${formatShortcutLabel(defaultBindingOf(sh.id))}`,
                                    {
                                      label: sh.label,
                                      default: formatShortcutLabel(
                                        defaultBindingOf(sh.id)
                                      ),
                                    }
                                  )}
                                >
                                  {t('common.reset', '还原')}
                                </Button>
                              </Tooltip>
                            ) : null}
                            <Tooltip
                              content={
                                isRecording
                                  ? t(
                                      'settings.shortcuts.recordingTooltip',
                                      '按键录制中，Esc 取消'
                                    )
                                  : t(
                                      'settings.shortcuts.currentKeyTooltip',
                                      `当前：${displayKey}，点击重新录制`,
                                      { key: displayKey }
                                    )
                              }
                            >
                              <Button
                                type="button"
                                ref={(el) => {
                                  btnRefs.current[rowIndex] = el;
                                }}
                                onClick={() =>
                                  setRecordingShortcutId(
                                    isRecording ? null : sh.id
                                  )
                                }
                                onFocus={() => setFocusIndex(rowIndex)}
                                className={`${styles.shortcutKeyBtn} shortcut-key-btn${isRecording ? ` ${styles.recording} recording` : ''}`}
                                variant="secondary"
                                size="sm"
                                active={isRecording}
                                aria-pressed={isRecording}
                                aria-label={
                                  isRecording
                                    ? t(
                                        'settings.shortcuts.recordingAria',
                                        `正在录制「${sh.label}」，按键设置，Esc 取消`,
                                        { label: sh.label }
                                      )
                                    : t(
                                        'settings.shortcuts.currentKeyAria',
                                        `「${sh.label}」当前 ${displayKey}，点击重新录制`,
                                        { label: sh.label, key: displayKey }
                                      )
                                }
                                tabIndex={tabIndex}
                              >
                                {isRecording
                                  ? t(
                                      'settings.shortcuts.recordPrompt',
                                      '按下快捷键组合...'
                                    )
                                  : displayKey}
                              </Button>
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
