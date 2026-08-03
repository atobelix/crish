/**
 * 安全审计日志视图（I3-S9 任务 4；数据源 = security-audit 事件 → store）。
 *
 * RuntimePanel 区段：最近审计条目（操作 · 决策 · 目标 · 影响面），
 * 空态隐藏噪音。展示顺序：最近在前（store 追加尾部，此处逆序）。
 */
import React from 'react';
import styles from './RuntimePanel.module.css';
import { RuntimeSection } from './RuntimeSection';
import {
  auditDecisionLabel,
  auditEntrySummary,
  auditOperationLabel,
  type SecurityAuditEntry,
} from '../../api/chat-bridge/handlers/securityAuditStore';

export type SecurityAuditSectionProps = {
  /** 审计条目（store 尾部追加；最多展示最近 8 条） */
  entries: SecurityAuditEntry[];
};

const MAX_VISIBLE = 8;

export const SecurityAuditSection: React.FC<SecurityAuditSectionProps> = ({
  entries,
}) => {
  if (entries.length === 0) return null;

  const visible = entries.slice(-MAX_VISIBLE).reverse();

  return (
    <RuntimeSection
      titleId="rt-sec-audit"
      title="安全审计"
      count={{
        label: `${entries.length} 条`,
        ariaLabel: `${entries.length} 条安全审计记录`,
      }}
    >
      <div
        className={`${styles.list} ${styles.listScroll}`}
        role="list"
        aria-label="安全审计记录"
      >
        {visible.map((entry, i) => {
          const key = `${entry.toolCallId ?? entry.timestamp}-${i}`;
          const flagged = entry.impact?.flagged;
          return (
            <div
              key={key}
              className={styles.row}
              role="listitem"
              data-testid="audit-entry"
            >
              <div className={styles.rowMain}>
                <span
                  className={`${styles.dot} ${flagged ? styles.warn : styles.on}`}
                  aria-hidden
                />
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>
                    {auditOperationLabel(entry.operation)} ·{' '}
                    {auditDecisionLabel(entry.decision)}
                  </span>
                  <span
                    className={styles.rowMeta}
                    title={entry.targets.join('\n')}
                  >
                    {auditEntrySummary(entry)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </RuntimeSection>
  );
};
