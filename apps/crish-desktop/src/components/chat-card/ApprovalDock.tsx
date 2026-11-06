/**
 * 审批 sticky dock：队列 / 子 agent 待确认时显示（单条主时间线靠 ApprovalAskCard）。
 * 点击后滚动定位到审批卡，找不到则尝试打开子 agent 侧栏，兜底 toast。
 * 挂载门闩与文案 / aria 来自 chatStatusRibbonsLib。
 */
import React, { useRef } from 'react';

import styles from './ApprovalDock.module.css';
import { Button, Tooltip } from '@/components/ui';
import { getSessionById } from '../../store/storeAccess';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { useToast } from '../../services/toast/ToastContext';
import {
  resolveApprovalDockAriaLabel,
  resolveApprovalDockLabelText,
  shouldRenderApprovalDock,
} from './chatStatusRibbonsLib';
import { useEntranceReveal } from '../motion/useEntranceReveal';
import { useClosingValue } from '../motion/useExitReveal';
import { useExitReveal } from '../motion/useExitReveal';
import { AppIcon } from '@/components/ui/icons';

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
  /**
   * S4 退场：外部宿主（ChatStatusRibbons）发放的 closing 标志；未传时
   * dock 自宿主（覆盖 ChatComposerWrapper 路径）。closing=true 时 dock
   * 高度收敛 + 淡出，父级保证挂载到退场播完。
   */
  closing?: boolean | undefined;
};

export const ApprovalDock: React.FC<ApprovalDockProps> = ({
  show,
  pendingCount,
  summary,
  toolId,
  msgId,
  activeSessionId,
  closing: closingProp,
}) => {
  const { showToast } = useToast();
  const dockRef = useRef<HTMLButtonElement | null>(null);

  // 统一入场通道：审批 dock 只在待审批实况中存在（存在本身即事件），
  // liveOnMount 判定 + grow 变体让缎带条高度同步生长，不再瞬时顶开。
  const entrance = useEntranceReveal({
    key: `dock:${toolId || msgId}`,
    liveOnMount: true,
    variant: 'grow',
  });

  // S4 退场：dock 自宿主（覆盖 ChatComposerWrapper 路径——wrapper 无条件
  // 渲染、dock 自门）。队列清空时保持最后一次快照播 150ms 退场。
  // 外部宿主（ChatStatusRibbons）传入 closing 时以外来标志为准，父级
  // 保证挂载；未传时用自宿主的保活值与 closing。
  const selfClosing = useClosingValue(
    shouldRenderApprovalDock(show, pendingCount)
      ? { pendingCount, summary, toolId, msgId, activeSessionId }
      : null,
    { key: `dock:${toolId || msgId}` }
  );
  const renderValue =
    closingProp !== undefined
      ? { pendingCount, summary, toolId, msgId, activeSessionId }
      : selfClosing.value;
  const closing = closingProp !== undefined ? closingProp : selfClosing.closing;
  // S4 退场：closing 翻 true 时收敛高度并淡出；退场期间入场生长让位。
  const exit = useExitReveal({ closing });

  if (renderValue == null) return null;
  const {
    pendingCount: vCount,
    summary: vSummary,
    toolId: vToolId,
    msgId: vMsgId,
    activeSessionId: vSid,
  } = renderValue;

  const ariaLabel = resolveApprovalDockAriaLabel(vCount, vSummary);
  const labelText = resolveApprovalDockLabelText(vCount, vSummary);

  const handleClick = (e?: React.MouseEvent<HTMLButtonElement>) => {
    const targetEl =
      (e?.currentTarget as HTMLElement | null) ?? dockRef.current;
    const root =
      targetEl?.closest<HTMLElement>('[data-leaf-id]') ??
      targetEl?.closest<HTMLElement>('.chatBody, .chat-body') ??
      targetEl?.parentElement ??
      document;

    const escToolId = vToolId ? escapeCss(vToolId) : '';
    const escMsgId = vMsgId ? escapeCss(vMsgId) : '';

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
    const sess = vSid ? getSessionById(vSid) : undefined;
    const pendingAgent = (sess?.agents || []).find((ag) =>
      (ag.messages || []).some((m) =>
        (m.toolCalls || []).some((tc) => tc.status === 'pending_approval')
      )
    );
    if (pendingAgent) {
      // 打开侧栏即反馈，不 toast「已打开…」
      openAgentInSidePanel(pendingAgent.id, {
        sessionId: vSid || undefined,
      });
      return;
    }
    // 找不到可滚目标：仅错误级短提示
    showToast('未找到待确认项');
  };

  return (
    <Tooltip content={ariaLabel}>
      <Button
        ref={(el: HTMLButtonElement | null) => {
          dockRef.current = el;
          entrance.rootRef(el);
          exit.rootRef(el);
        }}
        type="button"
        variant="ghost"
        size="sm"
        className={`${styles.approvalDock} ${styles.slim} ${styles.docked}${entrance.entering ? ' crish-entrance-fade' : ''}${closing ? ' crish-exit-fade' : ''}`}
        style={
          entrance.entering || closing
            ? ({
                ...(entrance.entering
                  ? { '--reveal-delay': `${entrance.delayMs}ms` }
                  : null),
                ...(closing ? { pointerEvents: 'none' } : null),
              } as React.CSSProperties)
            : undefined
        }
        aria-label={ariaLabel}
        aria-hidden={closing ? true : undefined}
        data-pending-count={vCount}
        data-entering={entrance.entering ? 'true' : undefined}
        data-exiting={closing ? 'true' : undefined}
        onAnimationEnd={entrance.handleAnimationEnd}
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
