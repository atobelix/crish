/**
 * 误删恢复面板（I3-S9 任务 3；数据源 = I2-S5 引擎命令 trash_list）。
 *
 * - 列表：路径 / 删除时间 / 类型 / 大小 / checksum（备份校验和）；
 * - 恢复按钮 → trash_restore（校验 checksum 防篡改、原路径已存在拒绝覆盖）；
 * - 清除按钮 → trash_purge（彻底删除，不可恢复）；
 * - 成功静默（列表刷新即反馈）；仅失败 toast。
 */
import React, { useCallback, useEffect, useState } from 'react';
import styles from './RuntimePanel.module.css';
import { RuntimeSection } from './RuntimeSection';
import { useToast } from '../../services/toast/ToastContext';
import { Button, Tooltip } from '@/components/ui';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';
import { useI18n } from '../../i18n';
import {
  formatTrashedAt,
  listTrashEntries,
  purgeTrashEntry,
  restoreTrashEntry,
  type TrashEntryDto,
} from '../../api/trashApi';

export type TrashSectionProps = {
  className?: string;
  sessionId?: string | null;
  leafId?: string | null;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const TrashSection: React.FC<TrashSectionProps> = ({
  className: _className,
  sessionId: sessionIdProp,
  leafId: _leafId,
}) => {
  const { showToast } = useToast();
  const { t } = useI18n();
  const scopedSessionId = useScopedSessionId(sessionIdProp);
  const [entries, setEntries] = useState<TrashEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listTrashEntries();
      setEntries(res.entries);
      setLoadError(null);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : t('workspace.trash.unknownError');
      setLoadError(message);
      showToast(t('workspace.trash.readFailedDetail', { message }), undefined, {
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRestore = useCallback(
    async (entry: TrashEntryDto) => {
      if (busyId) return;
      setBusyId(entry.id);
      try {
        const res = await restoreTrashEntry(
          entry.id,
          scopedSessionId || undefined
        );
        if (res.ok) {
          await refresh();
        } else {
          showToast(res.message, undefined, { type: 'error' });
        }
      } catch {
        showToast(t('workspace.trash.restoreFailed'), undefined, {
          type: 'error',
        });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, scopedSessionId, showToast, refresh, t]
  );

  const handlePurge = useCallback(
    async (entry: TrashEntryDto) => {
      if (busyId) return;
      setBusyId(entry.id);
      try {
        const res = await purgeTrashEntry(
          entry.id,
          scopedSessionId || undefined
        );
        if (res.ok) {
          await refresh();
        } else {
          showToast(res.message, undefined, { type: 'error' });
        }
      } catch {
        showToast(t('workspace.trash.purgeFailed'), undefined, {
          type: 'error',
        });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, scopedSessionId, showToast, refresh, t]
  );

  const countLabel =
    entries.length > 0
      ? t('workspace.trash.count', { count: entries.length })
      : null;
  const emptyMessage =
    loading && entries.length === 0
      ? t('workspace.trash.loading')
      : entries.length > 0
        ? null
        : loadError
          ? t('workspace.trash.readFailedDetail', { message: loadError })
          : t('workspace.trash.empty');

  return (
    <RuntimeSection
      titleId="rt-sec-trash"
      title={t('workspace.trash.title')}
      count={
        countLabel
          ? {
              label: countLabel,
              ariaLabel: t('workspace.trash.recoverableCount', {
                count: entries.length,
              }),
            }
          : undefined
      }
      empty={emptyMessage}
    >
      {loadError && entries.length > 0 ? (
        <div className={styles.rowMeta} role="alert">
          {t('workspace.trash.refreshFailed', { message: loadError })}
        </div>
      ) : null}
      {!loading && entries.length > 0 ? (
        <div
          className={`${styles.list} ${styles.listScroll}`}
          role="list"
          aria-label={t('workspace.trash.entriesAria')}
        >
          {entries.map((entry) => {
            const busy = busyId === entry.id;
            const metaBits = [
              formatTrashedAt(entry.trashedAt),
              entry.kind === 'dir'
                ? t('workspace.trash.directory')
                : t('workspace.trash.file'),
              formatSize(entry.size),
            ];
            if (entry.checksum) {
              metaBits.push(t('workspace.trash.hasChecksum'));
            }
            return (
              <div
                key={entry.id}
                className={styles.row}
                role="listitem"
                data-testid="trash-entry"
              >
                <div className={styles.rowMain}>
                  <span
                    className={`${styles.dot} ${styles.warn}`}
                    aria-hidden
                  />
                  <div className={styles.rowText}>
                    <Tooltip content={entry.originalPath}>
                      <span className={styles.rowTitle}>
                        {entry.originalPath}
                      </span>
                    </Tooltip>
                    <span className={styles.rowMeta}>
                      {metaBits.join(' · ')}
                    </span>
                  </div>
                </div>
                <div
                  className={styles.rowActions}
                  role="group"
                  aria-label={t('workspace.trash.operationsAria', {
                    path: entry.originalPath,
                  })}
                >
                  <Tooltip
                    content={
                      entry.checksum
                        ? t('workspace.trash.restoreToOriginalWithChecksum')
                        : t('workspace.trash.restoreToOriginal')
                    }
                  >
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      aria-label={t('workspace.trash.restoreAria', {
                        path: entry.originalPath,
                      })}
                      disabled={Boolean(busyId)}
                      onClick={() => void handleRestore(entry)}
                    >
                      {busy ? '…' : t('workspace.trash.restore')}
                    </Button>
                  </Tooltip>
                  <Tooltip content={t('workspace.trash.permanentlyDelete')}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('workspace.trash.purgeAria', {
                        path: entry.originalPath,
                      })}
                      disabled={Boolean(busyId)}
                      onClick={() => void handlePurge(entry)}
                    >
                      {t('workspace.trash.purge')}
                    </Button>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </RuntimeSection>
  );
};
