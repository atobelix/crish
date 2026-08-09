import React from 'react';
import type { SessionState } from '../../../store/types';
import {
  clampSessionListWindowRange,
  type SessionListWindowRange,
} from '../../../api/sessionListWindow';
import styles from '../SidebarSessionList.module.css';

export interface WindowedSessionUlProps {
  sessions: SessionState[];
  range: SessionListWindowRange;
  listRef?: React.RefObject<HTMLUListElement | null> | undefined;
  className: string;
  renderRow: (s: SessionState) => React.ReactNode;
  ariaLabel?: string | undefined;
}

export function WindowedSessionUl({
  sessions,
  range,
  listRef,
  className,
  renderRow,
  ariaLabel = '对话列表',
}: WindowedSessionUlProps) {
  // 防御：异常 range 钳回合法切片，spacer 与 count 对齐（CC helpers）
  const safe = clampSessionListWindowRange(range, sessions.length);
  if (!safe.windowed) {
    return (
      <ul
        ref={listRef}
        className={className}
        role="tree"
        aria-label={ariaLabel}
        data-windowed="0"
        data-window-count={sessions.length}
        aria-rowcount={sessions.length}
      >
        {sessions.map((s) => renderRow(s))}
      </ul>
    );
  }
  const slice = sessions.slice(safe.start, safe.end);
  return (
    <ul
      ref={listRef}
      className={`${className} ${styles.sessionListWindowed}`}
      role="tree"
      aria-label={ariaLabel}
      data-windowed="1"
      data-window-start={safe.start}
      data-window-end={safe.end}
      data-window-count={sessions.length}
      data-window-mounted={slice.length}
      aria-rowcount={sessions.length}
    >
      {safe.topPad > 0 ? (
        <li
          className={styles.sessionWindowSpacer}
          style={{ height: safe.topPad }}
          aria-hidden
        />
      ) : null}
      {slice.map((s) => renderRow(s))}
      {safe.bottomPad > 0 ? (
        <li
          className={styles.sessionWindowSpacer}
          style={{ height: safe.bottomPad }}
          aria-hidden
        />
      ) : null}
    </ul>
  );
}
