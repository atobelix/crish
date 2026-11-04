/**
 * apps/crish-desktop/src/components/chat-message-list/ChatTimeSeparator.tsx
 *
 * 时间分隔行呈现（批 B ㉑）：居中弱化小字，只报时间点、不加底色/边框
 * （与全仓无边框、灰阶分层口径一致）。挂载位置由 MessageVirtualizer
 * 裁决（computeTimeSeparatorHosts），本组件渲染在宿主行测量容器内，
 * 其高度自然计入行高测量，不另设占位。
 *
 * 标签格式经 SafeIntl.formatDate（应用语言单例）：同年 = 月/日 + 时:分，
 * 跨年补年份。
 */

import React from 'react';
import { formatDate } from '../../i18n/SafeIntl';
import styles from './ChatTimeSeparator.module.css';

export function formatTimeSeparatorLabel(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return formatDate(date.toISOString(), {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const ChatTimeSeparator: React.FC<{ timestamp: number }> = ({
  timestamp,
}) => {
  const label = formatTimeSeparatorLabel(timestamp);
  if (!label) return null;
  return (
    <div className={styles.separator} data-testid="chat-time-separator">
      <span>{label}</span>
    </div>
  );
};
