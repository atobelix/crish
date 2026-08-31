import React, { useMemo } from 'react';
import { FileCode } from 'lucide-react';
import type { FileDiff } from '../../store/types';
import styles from './ChatToolCallBlock.module.css';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';

export interface ToolCallDiffPreviewProps {
  diff: FileDiff;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
}

export const ToolCallDiffPreview: React.FC<ToolCallDiffPreviewProps> = ({
  diff,
  onOpenDiff,
}) => {
  const codeLang = useMemo(() => langFromFilename(diff.filePath), [diff.filePath]);

  return (
    <div className={styles.gitDiffCard} key={diff.filePath}>
      <div
        className={styles.gitDiffCardHeader}
        onClick={() => onOpenDiff?.(diff)}
      >
        <div className={styles.gitDiffFileInfo}>
          <FileCode size={16} style={{ color: 'var(--accent-color)' }} />
          <span className={styles.gitDiffFilename}>{diff.filePath}</span>
          <span className={styles.gitDiffPreviewTag}>在右侧查看</span>
        </div>
        <div className={styles.gitDiffBadge}>
          <span className={styles.gitDiffAdd}>+{diff.additions}</span>
          <span className={styles.gitDiffDel}>-{diff.deletions}</span>
        </div>
      </div>
      <div className={styles.gitDiffLinesContainer}>
        {diff.changes.slice(0, 8).map((change, i) => (
          <div
            key={i}
            className={`${styles.gitDiffLineRow} ${styles[change.type] || change.type}`}
          >
            <div className={styles.lineNumCol}>
              {change.type === 'addition'
                ? '+'
                : change.type === 'deletion'
                  ? '-'
                  : ' '}
            </div>
            <pre
              className={styles.lineContent}
              dangerouslySetInnerHTML={{
                __html: highlightCode(change.content, codeLang),
              }}
            />
          </div>
        ))}
        {diff.changes.length > 8 && (
          <div
            className={styles.gitDiffMoreIndicator}
            onClick={() => onOpenDiff?.(diff)}
          >
            还有 {diff.changes.length - 8} 行 · 点击在右侧查看完整 diff
          </div>
        )}
      </div>
    </div>
  );
};
