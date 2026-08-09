import React from 'react';
import styles from './ApprovalAskCard.module.css';

/** 超时倒计时进度条 */
export const ApprovalCountdown: React.FC<{
  remainingMs: number;
  percent: number;
}> = ({ remainingMs, percent }) => {
  return (
    <div
      className={`${styles.approvalCardTimeoutBar} ${
        percent <= 0 ? styles.approvalCardTimeoutBarExpired : ''
      }`}
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`审批剩余时间 ${Math.ceil(remainingMs / 1000)} 秒`}
    >
      <span
        className={styles.approvalCardTimeoutFill}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
};
