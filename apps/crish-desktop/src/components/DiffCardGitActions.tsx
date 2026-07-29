import React, { useEffect } from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { Tooltip } from './Tooltip';

interface DiffCardGitActionsProps {
  open: boolean;
  commitMsg: string;
  commitLoading: boolean;
  pushLoading: boolean;
  stagedCount: number;
  unstagedCount: number;
  onToggle: () => void;
  onCommitMsgChange: (msg: string) => void;
  onCommit: () => void;
  onPush: () => void;
}

export const DiffCardGitActions: React.FC<DiffCardGitActionsProps> = ({
  open,
  commitMsg,
  commitLoading,
  pushLoading,
  stagedCount,
  unstagedCount,
  onToggle,
  onCommitMsgChange,
  onCommit,
  onPush,
}) => {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onToggle]);

  if (!open) {
    return (
      <div className={styles.commitTriggerBar} onClick={onToggle}>
        <Lucide.GitCommit size={14} className={styles.commitTriggerIcon} />
        <span className={styles.commitTriggerText}>
          输入提交信息… ({stagedCount} 个已暂存 / {unstagedCount} 个未暂存)
        </span>
        <Lucide.ChevronRight size={14} className={styles.commitTriggerArrow} />
      </div>
    );
  }

  return (
    <div className={styles.commitPanel}>
      <div className={styles.commitHeader}>
        <span className={styles.commitTitle}>提交与推送 (Commit & Push)</span>
        <button type="button" className={styles.commitCloseBtn} aria-label="关闭提交面板" onClick={onToggle}>
          <Lucide.X size={13} />
        </button>
      </div>
      <textarea
        className={styles.commitInput}
        placeholder={
          stagedCount > 0
            ? '输入提交信息… 将仅提交已暂存的更改 (Ctrl+Enter 提交)'
            : '输入提交信息… 将自动暂存全部更改并提交 (Ctrl+Enter 提交)'
        }
        value={commitMsg}
        disabled={commitLoading || pushLoading}
        onChange={(e) => onCommitMsgChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onCommit();
          }
        }}
      />
      <div className={styles.commitActions}>
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm"
          style={{ height: 28 }}
          disabled={commitLoading || pushLoading}
          onClick={onCommit}
        >
          <Lucide.GitCommit size={14} style={{ marginRight: 4 }} />
          {commitLoading ? '提交中…' : stagedCount > 0 ? '提交已暂存' : '暂存并提交'}
        </button>
        <Tooltip content="将本地提交推送至远程仓库">
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            style={{ height: 28 }}
            disabled={commitLoading || pushLoading}
            onClick={onPush}
          >
            <Lucide.CloudUpload size={14} style={{ marginRight: 4 }} />
            {pushLoading ? '推送中…' : '推送 (Push)'}
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
