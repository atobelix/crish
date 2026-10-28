import React from 'react';
import { Tooltip } from '@/components/ui';
import type { GitStatusCode } from '../../api/gitTreeHelpers';
import { calculateDiffStatBars } from '../../api/gitTreeHelpers';
import styles from './GitStatusBadge.module.css';

export interface GitStatusBadgeProps {
  status: GitStatusCode;
  conflicted?: boolean;
  staged?: boolean;
  className?: string;
}

const STATUS_MAP: Record<
  GitStatusCode,
  { label: string; text: string; kind: string }
> = {
  M: { label: '修改 (Modified)', text: 'M', kind: 'modified' },
  A: { label: '新增 (Added)', text: 'A', kind: 'added' },
  D: { label: '删除 (Deleted)', text: 'D', kind: 'deleted' },
  U: { label: '未跟踪 (Untracked)', text: 'U', kind: 'untracked' },
  C: { label: '冲突 (Conflicted)', text: 'C', kind: 'conflicted' },
  R: { label: '重命名 (Renamed)', text: 'R', kind: 'renamed' },
  '?': { label: '未知状态 (Unknown)', text: '?', kind: 'unknown' },
};

export const GitStatusBadge: React.FC<GitStatusBadgeProps> = React.memo(
  function GitStatusBadge({ status, conflicted, staged, className }) {
    const config = conflicted
      ? STATUS_MAP.C
      : STATUS_MAP[status] || STATUS_MAP['?'];

    const tooltipContent = `${config.label}${staged ? ' · 已暂存' : ''}`;

    return (
      <Tooltip content={tooltipContent}>
        <span
          className={`${styles.badge} ${styles[config.kind] || ''} ${className || ''}`}
          aria-label={tooltipContent}
          role="status"
        >
          {config.text}
        </span>
      </Tooltip>
    );
  }
);

export interface DiffStatBarProps {
  additions: number;
  deletions: number;
  maxBars?: number;
  className?: string;
}

export const DiffStatBar: React.FC<DiffStatBarProps> = React.memo(
  function DiffStatBar({ additions, deletions, maxBars = 5, className }) {
    const total = (additions || 0) + (deletions || 0);
    if (total === 0) {
      return null;
    }

    const { addBars, delBars, emptyBars } = calculateDiffStatBars(
      additions,
      deletions,
      maxBars
    );

    return (
      <div
        className={`${styles.diffStatContainer} ${className || ''}`}
        aria-label={`+${additions}, -${deletions}`}
      >
        <div className={styles.microBar} aria-hidden>
          {Array.from({ length: addBars }).map((_, i) => (
            <span key={`add-${i}`} className={styles.barAdd} />
          ))}
          {Array.from({ length: delBars }).map((_, i) => (
            <span key={`del-${i}`} className={styles.barDel} />
          ))}
          {Array.from({ length: emptyBars }).map((_, i) => (
            <span key={`empty-${i}`} className={styles.barEmpty} />
          ))}
        </div>
        <div className={styles.statNumbers}>
          {additions > 0 && <span className={styles.numAdd}>+{additions}</span>}
          {deletions > 0 && <span className={styles.numDel}>−{deletions}</span>}
        </div>
      </div>
    );
  }
);
