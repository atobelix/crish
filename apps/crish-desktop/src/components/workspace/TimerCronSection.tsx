/**
 * 定时 / Cron 数据面展示区段（L2）。
 *
 * 数据源 = 数据面路由（dataPlaneRouter）收到的 timer-fired / timer-cancelled /
 * cron-fired 事件经 taskEventHandlers 维护的运行期摘要（TimerCronSummary）——
 * 事件视角摘要，非真实注册表状态（注册表真实状态前端不可得，不做冒充）。
 *
 * 展示（最小克制，复用 RuntimeSection 基座与既有行/统计样式）：
 * - 空态：无任何 timer/cron 事件 → 空态提示（隐藏噪音，不显示 0 误导）；
 * - 有数据：活跃定时器数 + Cron 累计触发统计，附最近事件摘要（≤ 3 条）；
 * - 事件驱动更新：useSyncExternalStore 订阅摘要，事件到达即重渲（无重动效）。
 */
import React, { useSyncExternalStore } from 'react';
import styles from './RuntimePanel.module.css';
import { RuntimeSection } from './RuntimeSection';
import {
  getTimerCronSummary,
  subscribeTimerCron,
  type TimerCronEventView,
} from '../../api/chat-bridge/handlers/taskEventHandlers';

/** 事件类型 → 中文短标签（数据面口径，与 Rust 事件一一对应） */
const TIMER_CRON_TYPE_LABELS: Readonly<
  Record<TimerCronEventView['type'], string>
> = Object.freeze({
  'timer-fired': '定时器触发',
  'timer-cancelled': '定时器取消',
  'cron-fired': 'Cron 触发',
});

/** 时间戳 → HH:MM:SS（本地区时，最近事件展示） */
function formatClock(atMs: number): string {
  const d = new Date(atMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 最近事件行文案（类型标签 + id + 时间；cron 触发附迭代序号） */
function eventLineText(ev: TimerCronEventView): string {
  const label = TIMER_CRON_TYPE_LABELS[ev.type];
  const suffix =
    ev.type === 'cron-fired' && ev.iteration != null
      ? `第 ${ev.iteration} 次`
      : null;
  return `${label} ${ev.id}${suffix ? ` · ${suffix}` : ''} · ${formatClock(ev.atMs)}`;
}

export const TimerCronSection: React.FC = () => {
  const summary = useSyncExternalStore(
    subscribeTimerCron,
    getTimerCronSummary,
    getTimerCronSummary,
  );

  const hasActivity =
    summary.timerFiredTotal > 0 ||
    summary.cronFiredTotal > 0 ||
    summary.recent.length > 0;

  // 无事件 → 空态（不渲染计数与统计，避免 0 噪音）
  if (!hasActivity) {
    return (
      <RuntimeSection
        titleId="rt-sec-sched"
        title="定时 / Cron"
        empty={
          <span data-testid="timer-cron-empty">
            暂无定时器 / Cron 活动
          </span>
        }
      />
    );
  }

  const totalFired = summary.timerFiredTotal + summary.cronFiredTotal;

  return (
    <RuntimeSection
      titleId="rt-sec-sched"
      title="定时 / Cron"
      count={{
        label: `${totalFired} 次`,
        ariaLabel: `累计 ${totalFired} 次定时与 Cron 触发`,
      }}
    >
      <div className={styles.usageStats} data-testid="timer-cron-stats">
        <div className={styles.statRow}>
          <span className={styles.statLabel}>活跃定时器</span>
          <span className={styles.statValue}>
            {summary.activeTimers}
            {summary.lastTimerFiredAtMs != null
              ? ` · ${formatClock(summary.lastTimerFiredAtMs)}`
              : ''}
          </span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>Cron 触发</span>
          <span className={styles.statValue}>
            {summary.cronFiredTotal} 次
            {summary.lastCronFiredAtMs != null
              ? ` · ${formatClock(summary.lastCronFiredAtMs)}`
              : ''}
          </span>
        </div>
        {summary.recent.length > 0 ? (
          <div
            className={styles.list}
            role="list"
            aria-label="最近定时与 Cron 事件"
          >
            {summary.recent.map((ev, i) => (
              <div
                key={`${ev.type}-${ev.id}-${i}`}
                className={styles.row}
                role="listitem"
                data-testid="timer-cron-event"
              >
                <div className={styles.rowMain}>
                  <span
                    className={`${styles.dot} ${
                      ev.type === 'cron-fired' ? styles.warn : styles.on
                    }`}
                    aria-hidden
                  />
                  <span className={styles.rowMeta}>{eventLineText(ev)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </RuntimeSection>
  );
};
