import React from 'react';
import styles from './OverviewCard.module.css';
import { Button } from '@/components/ui';

import { ChevronDownIcon } from '../../assets/icons';
import { formatBgTaskMeta } from './helpers';
import type { BackgroundTaskInfo } from '../../api/backgroundTasksApi';
import { AppIcon } from '@/components/ui/icons';

interface BackgroundSectionProps {
  open: boolean;
  bgTasks: BackgroundTaskInfo[];
  bgOpeningId: string | null;
  onToggle: () => void;
  onOpenTask: (t: BackgroundTaskInfo) => void;
}

export const BackgroundSection = React.memo(function BackgroundSection({
  open,
  bgTasks,
  bgOpeningId,
  onToggle,
  onOpenTask,
}: BackgroundSectionProps) {
  return (
    <section className={styles.sec} aria-labelledby="overview-sec-bg">
      <Button
        type="button"
        variant="ghost"
        id="overview-sec-bg"
        className={styles.secH}
        aria-expanded={open}
        onClick={onToggle}
      >
        <AppIcon name="terminal" size={16} aria-hidden />
        <span>后台常驻</span>
        {bgTasks.length > 0 ? (
          <span className={styles.pill}>{bgTasks.length}</span>
        ) : null}
        <ChevronDownIcon
          size={13}
          className={`${styles.chev} ${open ? styles.open : ''}`}
          aria-hidden
        />
      </Button>
      {open ? (
        <div className={styles.secB}>
          {bgTasks.length === 0 ? (
            <p className={`${styles.empty} ${styles.emptyQuiet}`}>无</p>
          ) : (
            <ul className={styles.list}>
              {bgTasks.map((t) => {
                const opening = bgOpeningId === t.id;
                const meta = formatBgTaskMeta({
                  state: t.state,
                  command: t.command,
                  opening,
                });
                return (
                  <li key={t.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.itemBtn}
                      onClick={() => onOpenTask(t)}
                    >
                      <AppIcon
                        name="terminal"
                        size={12}
                        className={styles.ico}
                      />
                      <span className={styles.itemMain}>
                        <span className={styles.itemName}>{t.label}</span>
                        <em>{meta}</em>
                      </span>
                    </Button>
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
