/**
 * 流内 Task 根：仅 plan 模式由 host 挂上。不画步骤竖轨 / Hub / 绿勾。
 */
import type { ReactElement } from 'react';
import type { PlanNode } from '@crish/conversation-flow';
import styles from './narrative.module.css';

export interface PlanRootProps {
  plan: PlanNode;
}

export function PlanRoot({ plan }: PlanRootProps): ReactElement {
  const approved = plan.status === 'success';
  return (
    <div
      className={styles.plan}
      data-flow-plan={plan.id}
      data-flow-task="root"
      data-plan-status={plan.status}
      data-derived="frontend"
      role="status"
      aria-live="polite"
      aria-label={
        approved ? '任务已启动，计划已批准' : '任务已启动，计划模式只规划'
      }
    >
      <div className={`${styles.head} ${styles.headStatic}`}>
        {plan.status === 'running' ? (
          <span className={styles.pulse} aria-hidden />
        ) : null}
        <span className={styles.primary}>任务已启动 · {plan.title}</span>
        <span className={styles.meta}>{approved ? '已批准' : '只规划'}</span>
      </div>
    </div>
  );
}
