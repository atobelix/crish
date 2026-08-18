/**
 * 审批 sticky dock：队列 / 子 agent 待确认时显示（单条主时间线靠 ApprovalAskCard）。
 * 点击后滚动定位到审批卡，找不到则尝试打开子 agent 侧栏，兜底 toast。
 * 挂载门闩与文案 / aria 来自 chatStatusRibbonsLib。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './ApprovalDock.module.css';
import { Button, Tooltip } from '../ui';
import { getSessionById } from '../../store/storeAccess';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { useToast } from '../../services/toast/ToastContext';
import {
  resolveApprovalDockAriaLabel,
  resolveApprovalDockLabelText,
  shouldRenderApprovalDock,
} from './chatStatusRibbonsLib';

export type ApprovalDockProps = {
  /** 是否显示 dock（防双渲染：漏传时安全不挂） */
  show: boolean;
  pendingCount: number;
  /** dock 完整文案（含「N 待审批 · 队列/协作…」），勿再拼前缀 */
  summary: string;
  toolId: string;
  msgId: string;
  activeSessionId: string | null | undefined;
};

export const ApprovalDock: React.FC<ApprovalDockProps> = ({
  show,
  pendingCount,
  summary,
  toolId,
  msgId,
  activeSessionId,
}) => {
  const { showToast } = useToast();
  if (!shouldRenderApprovalDock(show, pendingCount)) return null;

  const ariaLabel = resolveApprovalDockAriaLabel(pendingCount, summary);
  const labelText = resolveApprovalDockLabelText(pendingCount, summary);

  const handleClick = () => {
    const byTool = toolId
      ? document.querySelector(
          `.approval-card[data-tool-id="${CSS.escape(toolId)}"], [data-tool-id="${CSS.escape(toolId)}"]`
        )
      : null;
    const byMsg = msgId
      ? document.querySelector(
          `.approval-card[data-msg="${CSS.escape(msgId)}"]`
        )
      : null;
    const el = byTool || byMsg || document.querySelector('.approval-card');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el instanceof HTMLElement) {
        try {
          el.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const sess = activeSessionId ? getSessionById(activeSessionId) : undefined;
    const pendingAgent = (sess?.agents || []).find((ag) =>
      (ag.messages || []).some((m) =>
        (m.toolCalls || []).some((tc) => tc.status === 'pending_approval')
      )
    );
    if (pendingAgent) {
      // 打开侧栏即反馈，不 toast「已打开…」
      openAgentInSidePanel(pendingAgent.id, {
        sessionId: activeSessionId || undefined,
      });
      return;
    }
    // 找不到可滚目标：仅错误级短提示
    showToast('未找到待确认项');
  };

  return (
    <Tooltip content={ariaLabel}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`${styles.approvalDock} ${styles.slim}`}
        aria-label={ariaLabel}
        data-pending-count={pendingCount}
        onClick={handleClick}
      >
        <span className={styles.approvalDockDot} aria-hidden />
        <span className={styles.approvalDockLabel}>{labelText}</span>
        <Lucide.ChevronRight
          size={14}
          className={styles.approvalDockGoIcon}
          aria-hidden
        />
      </Button>
    </Tooltip>
  );
};
