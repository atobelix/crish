import React from 'react';
import styles from '../CardPanel.module.css';
import { LayoutPanelLeft } from 'lucide-react';
import { Button } from '../ui';

export function PanelBodyEmpty({
  title,
  hint,
  onOpenOverview,
}: {
  title: string;
  hint: string;
  onOpenOverview: () => void;
}) {
  return (
    <div
      className={`${styles.empty} panel-body-empty`}
      role="status"
      aria-live="polite"
    >
      <LayoutPanelLeft
        size={22}
        strokeWidth={1.5}
        aria-hidden
        className={styles.emptyIcon}
      />
      <div className={styles.emptyTitle}>{title}</div>
      <div className={styles.emptyHint}>{hint}</div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={styles.emptyBtn}
        onClick={onOpenOverview}
        aria-label="打开总览侧栏"
      >
        打开总览
      </Button>
    </div>
  );
}
