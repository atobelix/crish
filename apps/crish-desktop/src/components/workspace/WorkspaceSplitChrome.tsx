import React from 'react';
import { Columns, X } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import styles from '../Workspace.module.css';

interface WorkspaceSplitChromeProps {
  ordinal: string;
  colCountLabel: string;
  isActiveWorkspace: boolean;
  wsId: string;
  onClose: (id: string) => void;
}

export const WorkspaceSplitChrome: React.FC<WorkspaceSplitChromeProps> = ({
  ordinal,
  colCountLabel,
  isActiveWorkspace,
  wsId,
  onClose,
}) => (
  <div
    className={`${styles.splitChrome} workspace-split-chrome`}
    role="toolbar"
    aria-label={`拆分工作区 ${ordinal} 工具栏`}
  >
    <div className={styles.splitInfo}>
      <Columns size={12} strokeWidth={1.75} aria-hidden />
      <span className={styles.splitLabel}>
        拆分工作区 {ordinal}
        <span className={styles.splitSubLabel}>
          · {colCountLabel}
          {isActiveWorkspace ? ' · 当前焦点' : ''}
        </span>
      </span>
    </div>
    <Tooltip content={`关闭拆分工作区 ${ordinal}`}>
      <button
        type="button"
        className="workspace-close-btn card-action-btn"
        onClick={() => onClose(wsId)}
        aria-label={`关闭拆分工作区 ${ordinal}`}
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  </div>
);
