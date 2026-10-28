import React, { useCallback, useEffect, useState } from 'react';
import { Button, Tooltip } from '@/components/ui';
import { useToast } from '../../services/toast/ToastContext';
import { runLocalGit } from '../../api/gitApi';
import { getWorkspacePath, pathRelativeToRoot } from '../../api/workspaceFsApi';
import styles from './FileViewerCard.module.css';
import { AppIcon } from '@/components/ui/icons';

export interface FileViewerHistoryDrawerProps {
  filePath: string;
  hasWorkingChanges: boolean;
  onSelectDiffView: () => void;
  onClose: () => void;
}

interface CommitRecord {
  hash: string;
  message: string;
}

export const FileViewerHistoryDrawer: React.FC<
  FileViewerHistoryDrawerProps
> = ({ filePath, hasWorkingChanges, onSelectDiffView, onClose }) => {
  const { showToast } = useToast();
  const [history, setHistory] = useState<CommitRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [_error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cwd = getWorkspacePath() || '';
      const rel = pathRelativeToRoot(filePath, cwd) || filePath;
      const normalized = rel.replace(/\\/g, '/');
      const res = await runLocalGit(cwd, [
        'log',
        '--no-color',
        '--oneline',
        '--',
        normalized,
      ]);
      if (!res || !res.ok) {
        setHistory([]);
        if (res?.stderr) {
          setError(res.stderr);
        }
      } else {
        const lines = res.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const parsed: CommitRecord[] = lines.map((line) => {
          const spaceIdx = line.indexOf(' ');
          if (spaceIdx === -1) {
            return { hash: line, message: '' };
          }
          return {
            hash: line.substring(0, spaceIdx),
            message: line.substring(spaceIdx + 1),
          };
        });
        setHistory(parsed);
      }
    } catch (err) {
      setError(String(err));
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleCopyHash = (hash: string) => {
    void navigator.clipboard.writeText(hash).then(
      () => showToast(`提交哈希 ${hash} 已复制到剪贴板`),
      (e) => showToast(`复制失败：${String(e)}`)
    );
  };

  return (
    <aside
      className={styles.historyDrawer}
      role="region"
      aria-label="Git 提交历史面板"
    >
      <div className={styles.historyHeader}>
        <div className={styles.historyTitleWrap}>
          <AppIcon
            name="history"
            size={14}
            className={styles.historyHeaderIcon}
            aria-hidden
          />
          <span className={styles.historyTitle}>
            提交历史 {history.length > 0 ? `(${history.length})` : ''}
          </span>
        </div>
        <div className={styles.historyActions}>
          <Tooltip content="刷新历史记录">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={styles.drawerActBtn}
              onClick={() => void loadHistory()}
              disabled={loading}
              icon={
                <AppIcon
                  name="refresh"
                  size={13}
                  className={loading ? 'spin' : ''}
                  aria-hidden
                />
              }
              aria-label="刷新历史记录"
            />
          </Tooltip>
          <Tooltip content="关闭历史记录面板">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={styles.drawerActBtn}
              onClick={onClose}
              icon={<AppIcon name="x" size={13} aria-hidden />}
              aria-label="关闭历史记录面板"
            />
          </Tooltip>
        </div>
      </div>

      <div className={styles.historyBody}>
        {hasWorkingChanges && (
          <div
            className={styles.historyWorkingItem}
            onClick={onSelectDiffView}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectDiffView();
              }
            }}
            aria-label="当前工作区存在未提交修改，点击切换到变更对比"
          >
            <div className={styles.historyWorkingHeader}>
              <span className={styles.workingBadge}>工作区未提交改动</span>
            </div>
          </div>
        )}

        {loading ? (
          <div
            className={styles.historyLoading}
            role="status"
            aria-live="polite"
          >
            <AppIcon name="loader" size={16} className="spin" aria-hidden />
            <span>正在读取 Git 提交历史…</span>
          </div>
        ) : history.length === 0 ? (
          <div className={styles.historyEmpty} role="status" aria-live="polite">
            <AppIcon
              name="git-commit"
              size={22}
              className={styles.historyEmptyIcon}
              aria-hidden
            />
            <div className={styles.historyEmptyTitle}>暂无提交历史</div>
          </div>
        ) : (
          <div className={styles.historyList} role="list" aria-label="提交列表">
            {history.map((commit, idx) => (
              <div
                key={`${commit.hash}-${idx}`}
                className={styles.historyItem}
                role="listitem"
              >
                <div className={styles.commitMeta}>
                  <Tooltip content={`复制提交哈希 ${commit.hash}`}>
                    <Button
                      type="button"
                      variant="ghost"
                      className={styles.hashBadge}
                      onClick={() => handleCopyHash(commit.hash)}
                      aria-label={`复制提交哈希 ${commit.hash}`}
                    >
                      <AppIcon
                        name="git-commit"
                        size={12}
                        className={styles.commitIcon}
                        aria-hidden
                      />
                      <span>{commit.hash}</span>
                    </Button>
                  </Tooltip>
                </div>
                <Tooltip content={commit.message}>
                  <div className={styles.commitMsg}>{commit.message}</div>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};
