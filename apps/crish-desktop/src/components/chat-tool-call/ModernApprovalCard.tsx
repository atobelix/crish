import React from 'react';
import { Button } from '../ui';
import styles from './ModernToolCall.module.css';

export interface ModernApprovalCardProps {
  id?: string;
  command: string;
  summary?: string;
  onAllow?: () => void;
  onDeny?: () => void;
  className?: string;
}

/**
 * 极简高危命令执行授权卡片（单层纯净黑白灰，绝无大框套小框）
 */
export const ModernApprovalCard: React.FC<ModernApprovalCardProps> = ({
  id,
  command,
  summary = '高危命令执行确认',
  onAllow,
  onDeny,
  className = '',
}) => {
  return (
    <div
      className={`${styles.approvalCard} ${className}`}
      data-tool-id={id}
    >
      <div className={styles.approvalHead}>
        <span className={styles.approvalTitle}>{summary}</span>
      </div>

      <div className={styles.approvalBody}>
        <pre className={styles.approvalCodePreview}>$ {command}</pre>
      </div>

      <div className={styles.approvalFooter}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDeny}
        >
          拒绝
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onAllow}
        >
          允许执行
        </Button>
      </div>
    </div>
  );
};
