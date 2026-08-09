/**
 * RuntimePanel 待确认区段：审批列表 + 允许/拒绝（防连点、本地乐观标记）。
 * 成功静默（列表切换即反馈）；仅失败 toast。
 */
import React, { useState } from 'react';
import styles from './RuntimePanel.module.css';
import { Button, Tooltip } from '../ui';
import type { PendingApprovalInfo } from '../../api/engineStatus';
import { engineApproveTool, engineDenyTool } from '../../api/chatBridge';
import { useLayoutStore } from '../../api/store-access/componentAccess';

export type ApprovalSectionProps = {
  approvals: PendingApprovalInfo[];
  countLabel: string | null;
  onShowToast: (msg: string) => void;
  onFocusSession: (sessionId: string) => void;
};

export const ApprovalSection: React.FC<ApprovalSectionProps> = ({
  approvals,
  countLabel,
  onShowToast,
  onFocusSession,
}) => {
  const sessions = useLayoutStore((state) => state.sessions);
  /** 审批按钮防连点；成功静默，仅失败 toast */
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);

  if (approvals.length === 0) return null;

  const handleApprovalClick = (a: PendingApprovalInfo) => {
    const toolCallId = a.toolCallId;
    let found = toolCallId
      ? sessions.find(
          (s) =>
            (s.messages || []).some((m) =>
              (m.toolCalls || []).some(
                (tc) => tc.id === toolCallId && tc.status === 'pending_approval',
              ),
            ) ||
            (s.agents || []).some((ag) =>
              (ag.messages || []).some((m) =>
                (m.toolCalls || []).some(
                  (tc) => tc.id === toolCallId && tc.status === 'pending_approval',
                ),
              ),
            ),
        )
      : undefined;
    if (!found && a.runId) {
      found = sessions.find(
        (s) => s.engineLastRunId === a.runId || s.id === a.runId,
      );
    }
    if (found) {
      onFocusSession(found.id);
    } else {
      onShowToast('未找到待确认会话');
    }
  };

  const markLocalTool = (
    toolCallId: string | undefined,
    status: 'running' | 'error',
    output: string,
  ) => {
    if (!toolCallId) return;
    useLayoutStore.setState((state) => {
      for (const s of state.sessions) {
        for (const m of s.messages || []) {
          const tc = m.toolCalls?.find((t) => t.id === toolCallId);
          if (tc) {
            tc.status = status;
            tc.output = output;
          }
        }
        for (const ag of s.agents || []) {
          for (const m of ag.messages || []) {
            const tc = m.toolCalls?.find((t) => t.id === toolCallId);
            if (tc) {
              tc.status = status;
              tc.output = output;
            }
          }
        }
      }
    });
  };

  const handleApprovalAllow = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = a.toolCallId;
    if (!id) {
      onShowToast('缺少工具 id，无法批准');
      return;
    }
    if (approvalBusyId) return;
    setApprovalBusyId(id);
    markLocalTool(id, 'running', '执行中…');
    void engineApproveTool(id)
      .catch(() => {
        markLocalTool(id, 'error', '批准失败');
        onShowToast('批准失败，请重试');
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  const handleApprovalDeny = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = a.toolCallId;
    if (!id) {
      onShowToast('缺少工具 id，无法拒绝');
      return;
    }
    if (approvalBusyId) return;
    setApprovalBusyId(id);
    markLocalTool(id, 'error', '已拒绝');
    void engineDenyTool(id)
      .catch(() => {
        onShowToast('拒绝失败，请重试');
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  return (
    <section className={styles.section} aria-labelledby="rt-sec-approve">
      <div className={styles.sectionHead}>
        <h4 id="rt-sec-approve" className={styles.sectionTitle}>
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
                  <span className={`${styles.dot} ${styles.warn}`} aria-hidden />
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
                  <Tooltip content="允许">
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
                  </Tooltip>
                  <Tooltip content="拒绝">
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
                  </Tooltip>
                </div>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
};
