import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import styles from './SettingsArchiveTab.module.css';
import uiStyles from './SettingsUI.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsHeadTools,
} from './SettingsUI';
import { Button, ConfirmDialog, Input, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import {
  closeSettings,
  deleteSessionCascade,
  listProjects,
  useSessionStore,
} from '../../store/storeAccess';
import { sessionListProjectLabel } from '../sidebar/session-list/sessionListUtils';
import { getCompositionRoot } from '../../app/compositionRoot';
import { sessionListDisplayTitle } from '../../api/sessionTitle';
import {
  compareSessionsByActivity,
  formatSessionListAbsoluteTime,
  formatSessionListTime,
} from '../../api/sessionTime';
import { useToast } from '../../services/toast/ToastContext';
import type { SessionState } from '../../store/types';
import { useI18n } from '../../i18n';

type Props = {
  onBlockingOverlayChange?: (open: boolean) => void;
};

type PendingDeleteState =
  | { mode: 'single'; sessionId: string; title: string }
  | { mode: 'all'; count: number }
  | null;

export const SettingsArchiveTab: React.FC<Props> = ({
  onBlockingOverlayChange,
}) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const sessions = useSessionStore((s) => s.sessions);
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteState>(null);

  const filterId = useId();
  const headMetaId = useId();

  useEffect(() => {
    onBlockingOverlayChange?.(pendingDelete !== null);
    return () => {
      onBlockingOverlayChange?.(false);
    };
  }, [pendingDelete, onBlockingOverlayChange]);

  const projects = useMemo(() => listProjects(), []);

  const archivedSessions = useMemo(() => {
    const list = sessions.filter((s) => Boolean(s?.isArchived));
    return list.sort(compareSessionsByActivity);
  }, [sessions]);

  const hasQuery = query.trim().length > 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return archivedSessions;
    return archivedSessions.filter((s) => {
      const title = sessionListDisplayTitle(s).toLowerCase();
      const folder = sessionListProjectLabel(s.folder, projects).toLowerCase();
      return (
        title.includes(q) ||
        folder.includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [archivedSessions, query, projects]);

  const clearQuery = useCallback(() => setQuery(''), []);

  const handleOpenSession = useCallback((session: SessionState) => {
    const root = getCompositionRoot();
    root.session.unarchiveSession(session.id);
    root.shell.openSession(session.id, {
      title: session.title,
      workspaceKey: session.folder,
    });
    closeSettings();
  }, []);

  const handleRestoreSession = useCallback(
    (session: SessionState) => {
      const title = sessionListDisplayTitle(session);
      getCompositionRoot().session.unarchiveSession(session.id);
      showToast(
        t('settings.archive.restoredSession', '已还原对话: {title}', {
          title,
        })
      );
    },
    [showToast, t]
  );

  const handleRestoreAll = useCallback(() => {
    if (archivedSessions.length === 0) return;
    const root = getCompositionRoot();
    const count = archivedSessions.length;
    for (const s of archivedSessions) {
      root.session.unarchiveSession(s.id);
    }
    showToast(
      t('settings.archive.restoredAllCount', '已还原 {count} 个对话', {
        count,
      })
    );
  }, [archivedSessions, showToast, t]);

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    if (pendingDelete.mode === 'single') {
      deleteSessionCascade(pendingDelete.sessionId);
      showToast(
        t('settings.archive.deletedSession', '已删除对话: {title}', {
          title: pendingDelete.title,
        })
      );
    } else {
      const targets = [...archivedSessions];
      for (const s of targets) {
        deleteSessionCascade(s.id);
      }
      showToast(
        t('settings.archive.clearedAllCount', '已清空 {count} 个归档对话', {
          count: targets.length,
        })
      );
    }
    setPendingDelete(null);
  }, [pendingDelete, archivedSessions, showToast, t]);

  const headMetaText = hasQuery
    ? t('settings.archive.resultsCount', '{count} 个结果', {
        count: filtered.length,
      })
    : archivedSessions.length > 0
      ? t('settings.archive.itemsCount', '{count} 项', {
          count: archivedSessions.length,
        })
      : '';

  const headerMeta = (
    <SettingsHeadTools>
      {(archivedSessions.length > 0 || hasQuery) && (
        <div className={uiStyles.filterInput}>
          <Input
            id={filterId}
            variant="search"
            size="sm"
            className={styles.archiveSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.archive.searchPlaceholder', '搜索…')}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('settings.archive.searchAria', '搜索已归档对话')}
            aria-describedby={headMetaId}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                e.stopPropagation();
                clearQuery();
              }
            }}
          />
        </div>
      )}
      {hasQuery && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={clearQuery}
          aria-label={t('settings.archive.clearFilterAria', '清空筛选')}
        >
          {t('settings.archive.clearFilterBtnText', '清空')}
        </Button>
      )}
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
      {archivedSessions.length > 0 && !hasQuery && (
        <>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={handleRestoreAll}
            data-testid="archive-restore-all"
          >
            {t('settings.archive.restoreAll', '全部还原')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              setPendingDelete({
                mode: 'all',
                count: archivedSessions.length,
              })
            }
            data-testid="archive-clear-all"
          >
            {t('settings.archive.clearAllBtnText', '清空')}
          </Button>
        </>
      )}
    </SettingsHeadTools>
  );

  const now = Date.now();

  return (
    <SettingsPage
      title={t('settings.archive.pageTitle', '已归档')}
      meta={headerMeta}
    >
      <SettingsSection>
        <SettingsCard>
          {filtered.length === 0 ? (
            <SettingsRow
              title={
                <span className={styles.emptyTitle}>
                  {hasQuery
                    ? t(
                        'settings.archive.noMatchForQuery',
                        '无匹配「{query}」',
                        { query: query.trim() }
                      )
                    : t(
                        'settings.archive.noArchivedSessions',
                        '暂无已归档对话'
                      )}
                </span>
              }
              control={
                hasQuery ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={clearQuery}
                  >
                    {t('settings.archive.clearFilterBtn', '清空筛选')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            filtered.map((session) => {
              const displayTitle = sessionListDisplayTitle(session);
              const folderLabel = sessionListProjectLabel(
                session.folder,
                projects
              );
              const relTime = formatSessionListTime(session, now);
              const absTime = formatSessionListAbsoluteTime(session, now);
              const msgCount = session.messages?.length ?? 0;

              return (
                <SettingsRow
                  key={session.id}
                  icon={<AppIcon name="message-square" size={16} aria-hidden />}
                  title={
                    <span className={styles.rowTitle}>{displayTitle}</span>
                  }
                  desc={
                    <span className={styles.rowMeta}>
                      <span>{folderLabel}</span>
                      {msgCount > 0 && (
                        <>
                          <span className={styles.metaDot} aria-hidden="true">
                            ·
                          </span>
                          <span>
                            {t('settings.archive.msgCount', '{count} 条消息', {
                              count: msgCount,
                            })}
                          </span>
                        </>
                      )}
                      {relTime && (
                        <>
                          <span className={styles.metaDot} aria-hidden="true">
                            ·
                          </span>
                          <Tooltip content={absTime || relTime}>
                            <span>{relTime}</span>
                          </Tooltip>
                        </>
                      )}
                    </span>
                  }
                  control={
                    <div className={styles.controlGroup}>
                      <Tooltip
                        content={t(
                          'settings.archive.restoreAndOpen',
                          '还原并打开对话'
                        )}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => handleOpenSession(session)}
                          data-testid={`archive-open-${session.id}`}
                        >
                          {t('common.open', '打开')}
                        </Button>
                      </Tooltip>
                      <Tooltip
                        content={t(
                          'settings.archive.restoreToSidebar',
                          '还原至侧栏列表'
                        )}
                      >
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          onClick={() => handleRestoreSession(session)}
                          data-testid={`archive-restore-${session.id}`}
                        >
                          {t('common.restore', '还原')}
                        </Button>
                      </Tooltip>
                      <Tooltip
                        content={t(
                          'settings.archive.deletePermanently',
                          '永久删除'
                        )}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className={styles.deleteBtn}
                          aria-label={t(
                            'settings.archive.deletePermanentlyAria',
                            '永久删除 {title}',
                            { title: displayTitle }
                          )}
                          data-testid={`archive-delete-${session.id}`}
                          onClick={() =>
                            setPendingDelete({
                              mode: 'single',
                              sessionId: session.id,
                              title: displayTitle,
                            })
                          }
                          icon={<AppIcon name="trash" size={14} aria-hidden />}
                        />
                      </Tooltip>
                    </div>
                  }
                />
              );
            })
          )}
        </SettingsCard>
      </SettingsSection>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.mode === 'all'
            ? t('settings.archive.clearConfirmTitle', '清空已归档对话')
            : t('settings.archive.deleteConfirmTitle', '删除对话')
        }
        description={
          pendingDelete?.mode === 'all'
            ? t(
                'settings.archive.clearConfirmDesc',
                '确定要永久删除全部 {count} 个已归档对话吗？删除后无法恢复。',
                { count: pendingDelete.count }
              )
            : pendingDelete?.mode === 'single'
              ? t(
                  'settings.archive.deleteSingleConfirmDesc',
                  '确定要永久删除对话“{title}”吗？删除后无法恢复。',
                  { title: pendingDelete.title }
                )
              : undefined
        }
        confirmLabel={
          pendingDelete?.mode === 'all'
            ? t('settings.archive.deleteAllConfirmBtn', '全部删除')
            : t('common.confirmDelete', '确认删除')
        }
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </SettingsPage>
  );
};
