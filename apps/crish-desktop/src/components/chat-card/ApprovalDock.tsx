/**
 * 审批 sticky dock：队列 / 子 agent 待确认时显示（单条主时间线靠 ApprovalAskCard）。
 * 点击后滚动定位到审批卡，找不到则尝试打开子 agent 侧栏，兜底 toast。
 * 挂载门闩与文案 / aria 来自 chatStatusRibbonsLib。
 */
import React, { useRef } from 'react';

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
import { AppIcon } from '../ui/icons/index';

function escapeCss(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id);
  }
  return id.replace(/["\\]/g, '\\$&');
}

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
  const dockRef = useRef<HTMLButtonElement | null>(null);

  if (!shouldRenderApprovalDock(show, pendingCount)) return null;

  const ariaLabel = resolveApprovalDockAriaLabel(pendingCount, summary);
  const labelText = resolveApprovalDockLabelText(pendingCount, summary);

  const handleClick = (e?: React.MouseEvent<HTMLButtonElement>) => {
    const targetEl =
      (e?.currentTarget as HTMLElement | null) ?? dockRef.current;
    const root =
      targetEl?.closest<HTMLElement>('[data-leaf-id]') ??
      targetEl?.closest<HTMLElement>('.chatBody, .chat-body') ??
      targetEl?.parentElement ??
      document;

    const escToolId = toolId ? escapeCss(toolId) : '';
    const escMsgId = msgId ? escapeCss(msgId) : '';

    const byTool = escToolId
      ? root.querySelector(
          `.approval-card[data-tool-id="${escToolId}"], [data-tool-id="${escToolId}"], [data-approval-card-anchor="${escToolId}"]`
        )
      : null;
    const byMsg = escMsgId
      ? root.querySelector(
          `.approval-card[data-msg="${escMsgId}"], [data-approval-card-anchor="${escMsgId}"]`
        )
      : null;
    const el =
      byTool ||
      byMsg ||
      root.querySelector('.approval-card, [data-approval-card-anchor]');
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
        ref={dockRef}
        type="button"
        variant="ghost"
        size="sm"
        className={`${styles.approvalDock} ${styles.slim} ${styles.docked}`}
        aria-label={ariaLabel}
        data-pending-count={pendingCount}
        onClick={handleClick}
      >
        <span className={styles.approvalDockDot} aria-hidden />
        <span className={styles.approvalDockLabel}>{labelText}</span>
        <AppIcon
          name="chevron-right"
          size={14}
          className={styles.approvalDockGoIcon}
          aria-hidden
        />
      </Button>
    </Tooltip>
  );
};
