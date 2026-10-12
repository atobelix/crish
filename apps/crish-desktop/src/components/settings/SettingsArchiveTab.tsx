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
import { Button, ConfirmDialog, Input, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
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
      showToast(`已还原对话: ${title}`);
    },
    [showToast]
  );

  const handleRestoreAll = useCallback(() => {
    if (archivedSessions.length === 0) return;
    const root = getCompositionRoot();
    const count = archivedSessions.length;
    for (const s of archivedSessions) {
      root.session.unarchiveSession(s.id);
    }
    showToast(`已还原 ${count} 个对话`);
  }, [archivedSessions, showToast]);

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    if (pendingDelete.mode === 'single') {
      deleteSessionCascade(pendingDelete.sessionId);
      showToast(`已删除对话: ${pendingDelete.title}`);
    } else {
      const targets = [...archivedSessions];
      for (const s of targets) {
        deleteSessionCascade(s.id);
      }
      showToast(`已清空 ${targets.length} 个归档对话`);
    }
    setPendingDelete(null);
  }, [pendingDelete, archivedSessions, showToast]);

  const headMetaText = hasQuery
    ? `${filtered.length} 个结果`
    : archivedSessions.length > 0
      ? `${archivedSessions.length} 项`
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
            placeholder="搜索…"
            spellCheck={false}
            autoComplete="off"
            aria-label="搜索已归档对话"
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
          aria-label="清空筛选"
        >
          清空
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
            全部还原
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
            清空
          </Button>
        </>
      )}
    </SettingsHeadTools>
  );

  const now = Date.now();

  return (
    <SettingsPage title="已归档" meta={headerMeta}>
      <SettingsSection>
        <SettingsCard>
          {filtered.length === 0 ? (
            <SettingsRow
              title={
                <span className={styles.emptyTitle}>
                  {hasQuery ? `无匹配「${query.trim()}」` : '暂无已归档对话'}
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
                    清空筛选
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
                          <span>{msgCount} 条消息</span>
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
                      <Tooltip content="还原并打开对话">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => handleOpenSession(session)}
                          data-testid={`archive-open-${session.id}`}
                        >
                          打开
                        </Button>
                      </Tooltip>
                      <Tooltip content="还原至侧栏列表">
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          onClick={() => handleRestoreSession(session)}
                          data-testid={`archive-restore-${session.id}`}
                        >
                          还原
                        </Button>
                      </Tooltip>
                      <Tooltip content="永久删除">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className={styles.deleteBtn}
                          aria-label={`永久删除 ${displayTitle}`}
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
        title={pendingDelete?.mode === 'all' ? '清空已归档对话' : '删除对话'}
        description={
          pendingDelete?.mode === 'all'
            ? `确定要永久删除全部 ${pendingDelete.count} 个已归档对话吗？删除后无法恢复。`
            : pendingDelete?.mode === 'single'
              ? `确定要永久删除对话“${pendingDelete.title}”吗？删除后无法恢复。`
              : undefined
        }
        confirmLabel={pendingDelete?.mode === 'all' ? '全部删除' : '确认删除'}
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </SettingsPage>
  );
};
