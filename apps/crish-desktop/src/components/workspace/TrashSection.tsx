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
import { Button, Tooltip } from '../ui';
import { useSessionStore } from '../../store/sessionStore';
import {
  formatTrashedAt,
  listTrashEntries,
  purgeTrashEntry,
  restoreTrashEntry,
  type TrashEntryDto,
} from '../../api/trashApi';

export type TrashSectionProps = {
  className?: string;
  onShowToast?: (msg: string) => void;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const TrashSection: React.FC<TrashSectionProps> = () => {
  const { showToast } = useToast();
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const [entries, setEntries] = useState<TrashEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listTrashEntries();
      setEntries(res.entries);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

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
          activeSessionId || undefined
        );
        if (res.ok) {
          await refresh();
        } else {
          showToast(res.message, undefined, { type: 'error' });
        }
      } catch {
        showToast('恢复失败，请重试', undefined, { type: 'error' });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, activeSessionId, showToast, refresh]
  );

  const handlePurge = useCallback(
    async (entry: TrashEntryDto) => {
      if (busyId) return;
      setBusyId(entry.id);
      try {
        const res = await purgeTrashEntry(
          entry.id,
          activeSessionId || undefined
        );
        if (res.ok) {
          await refresh();
        } else {
          showToast(res.message, undefined, { type: 'error' });
        }
      } catch {
        showToast('清除失败，请重试', undefined, { type: 'error' });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, activeSessionId, showToast, refresh]
  );

  const countLabel = entries.length > 0 ? `${entries.length} 项` : null;
  const showEmpty = !loading && entries.length === 0;

  return (
    <RuntimeSection
      titleId="rt-sec-trash"
      title="回收站"
      count={
        countLabel
          ? { label: countLabel, ariaLabel: `${entries.length} 项可恢复` }
          : undefined
      }
      empty={
        showEmpty
          ? '回收站为空（误删文件可在此恢复）'
          : loading
            ? '加载中…'
            : null
      }
    >
      {!loading && entries.length > 0 ? (
        <div
          className={`${styles.list} ${styles.listScroll}`}
          role="list"
          aria-label="回收站条目"
        >
          {entries.map((entry) => {
            const busy = busyId === entry.id;
            const metaBits = [
              formatTrashedAt(entry.trashedAt),
              entry.kind === 'dir' ? '目录' : '文件',
              formatSize(entry.size),
            ];
            if (entry.checksum) metaBits.push('有校验和');
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
                  aria-label={`${entry.originalPath} 回收站操作`}
                >
                  <Tooltip
                    content={
                      entry.checksum
                        ? '恢复到原路径（校验和防篡改）'
                        : '恢复到原路径'
                    }
                  >
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      aria-label={`恢复 ${entry.originalPath}`}
                      disabled={Boolean(busyId)}
                      onClick={() => void handleRestore(entry)}
                    >
                      {busy ? '…' : '恢复'}
                    </Button>
                  </Tooltip>
                  <Tooltip content="彻底清除（不可恢复）">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`清除 ${entry.originalPath}`}
                      disabled={Boolean(busyId)}
                      onClick={() => void handlePurge(entry)}
                    >
                      清除
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
