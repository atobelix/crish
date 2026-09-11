import React from 'react';
import styles from './OverviewCard.module.css';
import { Button } from '../ui';

import { ChevronDownIcon } from '../../assets/icons';
import { formatElapsed } from './helpers';
import type { PendingApprovalInfo } from '../../api/engineStatus';

import type { LiveTask } from './useOverviewState';
import { AppIcon } from '../ui/icons/index';

interface ActiveTasksSectionProps {
  open: boolean;
  liveTasks: LiveTask[];
  pendingApprovals: PendingApprovalInfo[];
  approvalBusyId: string | null;
  onToggle: () => void;
  onApprovalClick: (a: PendingApprovalInfo) => void;
  onApprovalAllow: (a: PendingApprovalInfo, e: React.MouseEvent) => void;
  onApprovalDeny: (a: PendingApprovalInfo, e: React.MouseEvent) => void;
  onLiveTaskClick: (wk: LiveTask) => void;
}

export const ActiveTasksSection = React.memo(function ActiveTasksSection({
  open,
  liveTasks,
  pendingApprovals,
  approvalBusyId,
  onToggle,
  onApprovalClick,
  onApprovalAllow,
  onApprovalDeny,
  onLiveTaskClick,
}: ActiveTasksSectionProps) {
  const total = liveTasks.length + pendingApprovals.length;
  return (
    <section className={styles.sec} aria-labelledby="overview-sec-active">
      <button
        type="button"
        id="overview-sec-active"
        className={styles.secH}
        aria-expanded={open}
        onClick={onToggle}
      >
        <AppIcon name="activity" size={15} aria-hidden />
        <span>活动任务</span>
        {total > 0 ? <span className={styles.pill}>{total}</span> : null}
        <ChevronDownIcon
          size={13}
          className={`${styles.chev} ${open ? styles.open : ''}`}
          aria-hidden
        />
      </button>
      {open ? (
        <div className={styles.secB}>
          {total === 0 ? (
            <p className={`${styles.empty} ${styles.emptyQuiet}`}>无</p>
          ) : (
            <ul className={styles.list}>
              {pendingApprovals.map((a, i) => {
                const busy = approvalBusyId === (a.toolCallId || '');
                return (
                  <li key={a.toolCallId || i} className={styles.actionRow}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.itemBtn}
                      onClick={() => onApprovalClick(a)}
                    >
                      <span className={`${styles.dot} ${styles.warn}`} />
                      <span className={styles.itemMain}>
                        <span className={styles.itemName}>
                          {a.toolName || '工具'} (待确认)
                        </span>
                        <em>{a.summary || '等待批准'}</em>
                      </span>
                    </Button>
                    <div
                      className={styles.rowActions}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={Boolean(approvalBusyId)}
                        onClick={(e) => onApprovalAllow(a, e)}
                      >
                        {busy ? '…' : '允许'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={Boolean(approvalBusyId)}
                        onClick={(e) => onApprovalDeny(a, e)}
                      >
                        拒绝
                      </Button>
                    </div>
                  </li>
                );
              })}
              {liveTasks.map((wk) => (
                <li key={wk.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.itemBtn}
                    onClick={() => {
                      if (wk.sessionId) onLiveTaskClick(wk);
                    }}
                  >
                    <span className={`${styles.dot} ${styles.live}`} />
                    <span className={styles.itemMain}>
                      <span className={styles.itemName}>{wk.taskName}</span>
                      <em>{formatElapsed(wk.elapsedSeconds)}</em>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
});
