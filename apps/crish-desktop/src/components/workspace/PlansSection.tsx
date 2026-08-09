/**
 * RuntimePanel 计划任务区段：引擎 workflow + 本地 cron 双源列表 + 管理入口。
 * 纯渲染；数据由壳层 useRuntimePanelData 收拢后透传。
 */
import React from 'react';
import styles from './RuntimePanel.module.css';
import type { CronJob } from '../../api/clientApi';
import type { WorkflowDefinition } from '../../api/workflowApi';
import { scheduleLabel } from '../../api/workflowApi';
import { emitUiEvent } from '../../api/uiEvents';
import { emptyPlansHint } from './runtimePanelLib';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { Button } from '../ui';

export type PlansSectionProps = {
  workflows: WorkflowDefinition[];
  cronJobs: CronJob[];
  planCount: number;
  countLabel: string | null;
};

export const PlansSection: React.FC<PlansSectionProps> = ({
  workflows,
  cronJobs,
  planCount,
  countLabel,
}) => {
  // D2（C-10）：连接态投影（errorStore 真源），不再由 RuntimePanel props 下传
  const connectionStatus = useConnectionStatus();
  return (
    <section className={styles.section} aria-labelledby="rt-sec-plan">
      <div className={styles.sectionHead}>
        <h4 id="rt-sec-plan" className={styles.sectionTitle}>
          计划任务
        </h4>
        {countLabel ? (
          <span className={styles.rowMeta} aria-live="polite" aria-label={`${countLabel} 个计划`}>
            {countLabel}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="管理计划"
          onClick={() => {
            emitUiEvent('open-scheduled');
          }}
        >
          管理
        </Button>
      </div>
      {planCount === 0 ? (
        <div className={styles.empty} role="status">
          {emptyPlansHint(connectionStatus)}
        </div>
      ) : (
        <div className={`${styles.list} ${styles.listScroll}`} role="list" aria-label="计划任务列表">
          {workflows.map((w) => {
            const enabled = w.enabled !== false;
            return (
              <div
                key={w.id}
                className={styles.cronCard}
                role="listitem"
                aria-label={`${w.name}，${enabled ? '已启用' : '已停用'}，${scheduleLabel(w.schedule)}`}
              >
                <div className={styles.cronTop}>
                  <div className={styles.cronLeft}>
                    <span
                      className={`${styles.dot} ${enabled ? styles.on : styles.off}`}
                      aria-hidden
                    />
                    <span className={styles.cronExpr}>{scheduleLabel(w.schedule)}</span>
                  </div>
                </div>
                <div className={styles.cronPrompt}>{w.name}</div>
                {w.prompt && (
                  <div className={styles.cronNext}>{w.prompt.slice(0, 80)}</div>
                )}
              </div>
            );
          })}
          {cronJobs.map((job: CronJob) => {
            const active = job.status === 'active';
            return (
              <div
                key={job.id}
                className={styles.cronCard}
                role="listitem"
                aria-label={`${job.prompt || '计划'}，${active ? '进行中' : '已停用'}，${job.cronExpression}`}
              >
                <div className={styles.cronTop}>
                  <div className={styles.cronLeft}>
                    <span
                      className={`${styles.dot} ${active ? styles.on : styles.off}`}
                      aria-hidden
                    />
                    <span className={styles.cronExpr}>{job.cronExpression}</span>
                  </div>
                </div>
                <div className={styles.cronPrompt}>{job.prompt}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
