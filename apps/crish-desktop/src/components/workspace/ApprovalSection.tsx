import { useToast } from '../../services/toast/ToastContext';
/**
 * RuntimePanel 待确认区段：审批列表 + 允许/拒绝（防连点、本地乐观标记）。
 * 成功静默（列表切换即反馈）；仅失败 toast。
 */
import React, { useState } from 'react';
import styles from './RuntimePanel.module.css';
import { Button, Tooltip } from '@/components/ui';
import type { PendingApprovalInfo } from '../../api/engineStatus';
import { engineApproveTool, engineDenyTool } from '../../api/chatBridge';
import { useSessionStore } from '../../store/storeAccess';

export type ApprovalSectionProps = {
  approvals: PendingApprovalInfo[];
  countLabel: string | null;
  onFocusSession: (sessionId: string) => void;
};

export const ApprovalSection: React.FC<ApprovalSectionProps> = ({
  approvals,
  countLabel,
  onFocusSession,
}) => {
  const { showToast } = useToast();
  const sessions = useSessionStore((state) => state.sessions);
  /** 审批按钮防连点；成功静默，仅失败 toast */
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const titleId = React.useId();

  if (approvals.length === 0) return null;

  const handleApprovalClick = (a: PendingApprovalInfo) => {
    const toolCallId = a.toolCallId;
    let found = toolCallId
      ? sessions.find(
          (s) =>
            (s.messages || []).some((m) =>
              (m.toolCalls || []).some(
                (tc) => tc.id === toolCallId && tc.status === 'pending_approval'
              )
            ) ||
            (s.agents || []).some((ag) =>
              (ag.messages || []).some((m) =>
                (m.toolCalls || []).some(
                  (tc) =>
                    tc.id === toolCallId && tc.status === 'pending_approval'
                )
              )
            )
        )
      : undefined;
    if (!found && a.runId) {
      found = sessions.find(
        (s) => s.engineLastRunId === a.runId || s.id === a.runId
      );
    }
    if (found) {
      onFocusSession(found.id);
    } else {
      showToast('未找到待确认会话');
    }
  };

  const markLocalTool = (
    toolCallId: string | undefined,
    status: 'running' | 'error',
    output: string,
    runId?: string
  ) => {
    if (!toolCallId) return;
    // T-E 步骤 4（C2）：raw setState 全表扫描 → markToolCallLocalStatus action
    //（与 useOverviewState C1 共用同一 action；scope 限定 runId 时只扫 scope 内）
    useSessionStore
      .getState()
      .markToolCallLocalStatus(
        toolCallId,
        status,
        output,
        runId ? { runId } : undefined
      );
  };

  const handleApprovalAllow = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = a.toolCallId;
    if (!id) {
      showToast('缺少工具 id，无法批准');
      return;
    }
    if (approvalBusyId) return;
    setApprovalBusyId(id);
    markLocalTool(id, 'running', '执行中…', a.runId);
    void engineApproveTool(id)
      .catch(() => {
        markLocalTool(id, 'error', '批准失败', a.runId);
        showToast('批准失败，请重试');
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  const handleApprovalDeny = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = a.toolCallId;
    if (!id) {
      showToast('缺少工具 id，无法拒绝');
      return;
    }
    if (approvalBusyId) return;
    setApprovalBusyId(id);
    markLocalTool(id, 'error', '已拒绝', a.runId);
    void engineDenyTool(id)
      .catch(() => {
        showToast('拒绝失败，请重试');
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <div className={styles.sectionHead}>
        <h4 id={titleId} className={styles.sectionTitle}>
          待确认
        </h4>
        {countLabel ? (
          <span
            className={styles.rowMeta}
            aria-live="polite"
            aria-label={`${countLabel} 项待确认`}
          >
            {countLabel}
          </span>
        ) : null}
      </div>
      <div className={styles.list} role="list" aria-label="待确认工具">
        {approvals.map((a, i) => {
          const toolLabel = a.toolName || '工具';
          const busy = approvalBusyId === (a.toolCallId || '');
          return (
            <Tooltip key={a.toolCallId || i} content="打开待确认会话">
              <div
                className={`${styles.row} ${styles.isClickable}`}
                role="button"
                tabIndex={0}
                aria-label={`${toolLabel}，等待批准，打开对应会话`}
                onClick={() => handleApprovalClick(a)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleApprovalClick(a);
                  }
                }}
              >
                <div className={styles.rowMain}>
                  <span
                    className={`${styles.dot} ${styles.warn}`}
                    aria-hidden
                  />
                  <div className={styles.rowText}>
                    <span className={styles.rowTitle}>{toolLabel}</span>
                    <span className={styles.rowMeta}>
                      {a.summary || a.toolCallId || '等待批准'}
                    </span>
                  </div>
                </div>
                <div
                  className={styles.rowActions}
                  role="group"
                  aria-label={`${toolLabel} 审批`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    aria-label={`允许 ${toolLabel}`}
                    aria-busy={busy || undefined}
                    disabled={Boolean(approvalBusyId)}
                    onClick={(e) => handleApprovalAllow(a, e)}
                  >
                    {busy ? '…' : '允许'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`拒绝 ${toolLabel}`}
                    disabled={Boolean(approvalBusyId)}
                    onClick={(e) => handleApprovalDeny(a, e)}
                  >
                    拒绝
                  </Button>
                </div>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
};
