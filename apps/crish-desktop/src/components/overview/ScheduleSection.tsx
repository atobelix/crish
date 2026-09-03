import React from 'react';
import styles from './OverviewCard.module.css';
import { CalendarClock } from 'lucide-react';
import { ChevronDownIcon } from '../../assets/icons';
import { scheduleLabel } from '../../api/workflowApi';
import type { CronJob } from '../../api/clientApi';
import type { WorkflowDefinition } from '../../api/workflowApi';

interface ScheduleSectionProps {
  open: boolean;
  workflows: WorkflowDefinition[];
  cronJobs?: CronJob[];
  onToggle: () => void;
}

export const ScheduleSection = React.memo(function ScheduleSection({
  open, workflows, cronJobs, onToggle,
}: ScheduleSectionProps) {
  const count = workflows.length + (cronJobs?.length || 0);

  return (
    <section className={styles.sec} aria-labelledby="overview-sec-cron">
      <button type="button" id="overview-sec-cron" className={styles.secH}
        aria-expanded={open} onClick={onToggle}>
        <CalendarClock size={15} strokeWidth={1.75} aria-hidden />
        <span>计划任务</span>
        {count > 0 ? (
          <span className={styles.pill}>{count}</span>
        ) : null}
        <ChevronDownIcon size={13} className={`${styles.chev} ${open ? styles.open : ''}`} aria-hidden />
      </button>
      {open ? (
        <div className={styles.secB}>
          {count === 0 ? (
            <p className={`${styles.empty} ${styles.emptyQuiet}`}>无</p>
          ) : (
            <ul className={styles.list}>
              {workflows.map((w) => {
                const enabled = w.enabled !== false;
                return (
                  <li key={w.id}>
                    <div className={styles.cronRow}>
                      <div className={styles.cronInfo}>
                        <span className={`${styles.dot} ${enabled ? styles.on : styles.off}`} />
                        <span className={styles.cronTitle}>{w.name}</span>
                      </div>
                      <span className={styles.cronMeta}>{scheduleLabel(w.schedule)}</span>
                    </div>
                  </li>
                );
              })}
              {cronJobs?.map((job: CronJob) => {
                const active = job.status === 'active';
                return (
                  <li key={job.id}>
                    <div className={styles.cronRow}>
                      <div className={styles.cronInfo}>
                        <span className={`${styles.dot} ${active ? styles.on : styles.off}`} />
                        <span className={styles.cronTitle}>{job.prompt}</span>
                      </div>
                      <span className={styles.cronMeta}>{job.cronExpression}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
});
