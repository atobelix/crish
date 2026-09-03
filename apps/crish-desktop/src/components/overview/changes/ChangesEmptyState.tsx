/**
 * ChangesEmptyState.tsx — 改动面板规范纯净空状态组件（单一职责）。
 * 纯文本展示，不留多余下挂按钮。
 */

import React from 'react';
import styles from '../OverviewCard.module.css';

export interface ChangesEmptyStateProps {
  message?: string;
}

export const ChangesEmptyState: React.FC<ChangesEmptyStateProps> = ({
  message = '当前对话暂无文件改动',
}) => {
  return (
    <div className={styles.emptyWrap} role="status">
      <p className={`${styles.empty} ${styles.emptyQuiet}`}>
        {message}
      </p>
    </div>
  );
};
