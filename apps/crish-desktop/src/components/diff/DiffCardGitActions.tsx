import React, { useEffect } from 'react';
import styles from './DiffCard.module.css';
import { Button, Textarea, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

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

  const canCommit =
    !commitLoading &&
    !pushLoading &&
    (commitMsg.trim().length > 0 || stagedCount > 0);

  if (!open) {
    return (
      <div
        className={styles.commitTriggerBar}
        role="button"
        tabIndex={0}
        aria-expanded={false}
        aria-label={`展开提交与推送面板，已暂存 ${stagedCount} 个，未暂存 ${unstagedCount} 个`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <AppIcon name="git-commit" size={14} className={styles.commitTriggerIcon} />
        <span className={styles.commitTriggerText}>
          输入提交信息… ({stagedCount} 个已暂存 / {unstagedCount} 个未暂存)
        </span>
        <AppIcon name="chevron-right" size={14} className={styles.commitTriggerArrow} />
      </div>
    );
  }

  return (
    <div className={styles.commitPanel}>
      <div className={styles.commitHeader}>
        <span className={styles.commitTitle}>提交与推送 (Commit & Push)</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.commitCloseBtn}
          aria-label="关闭提交面板"
          onClick={onToggle}
          icon={<AppIcon name="x" size={13} />}
        />
      </div>
      <Textarea
        bare
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
          if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            if (canCommit) {
              e.preventDefault();
              onCommit();
            }
          }
        }}
      />
      <div className={styles.commitActions}>
        <Button
          type="button"
          variant="primary"
          size="sm"
          style={{ height: 28, borderRadius: 'var(--radius-sm)' }}
          disabled={!canCommit}
          onClick={onCommit}
          icon={<AppIcon name="git-commit" size={14} style={{ marginRight: 4 }} />}
        >
          {commitLoading
            ? '提交中…'
            : stagedCount > 0
              ? '提交已暂存'
              : '暂存并提交全部'}
        </Button>
        <Tooltip content="将本地提交推送至远程仓库">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            style={{ height: 28, borderRadius: 'var(--radius-sm)' }}
            disabled={commitLoading || pushLoading}
            onClick={onPush}
            icon={<AppIcon name="cloud-upload" size={14} style={{ marginRight: 4 }} />}
          >
            {pushLoading ? '推送中…' : '推送 (Push)'}
          </Button>
        </Tooltip>
        {commitMsg.length > 0 && (
          <span className={styles.commitCharCount} aria-label={`已输入 ${commitMsg.length} 个字符`}>
            {commitMsg.length}
          </span>
        )}
      </div>
    </div>
  );
};
