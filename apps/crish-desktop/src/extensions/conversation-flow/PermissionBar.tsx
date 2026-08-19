/**
 * 插件开时挂在 composer 上沿：首条 +「还有 N」。
 * 回调走 useChatApproval / engineApproveTool；不要演示倒计时槽。
 */
import { useCallback, useState, type ReactElement } from 'react';
import {
  allowButtonLabel,
  nextAllowConfirmPhase,
} from '../../api/chatApprovalUi';
import type { ChatComposerAboveProps } from '../../components/chat-card/chatComposerAboveProps';
import { Button, Tooltip } from '../../components/ui';
import styles from './permissionBar.module.css';
import {
  permissionBarMoreCount,
  permissionBarMoreLabel,
  shouldRenderPermissionBar,
} from './permissionBarModel';

export function PermissionBar({
  pendingCount,
  firstToolId,
  firstMsgId,
  firstSummary,
  firstCommand,
  requiresDoubleConfirm = false,
  approvalBusy = false,
  onApprovalAllow,
  onApprovalDeny,
}: ChatComposerAboveProps): ReactElement | null {
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [rememberIntent, setRememberIntent] = useState(false);

  const fireAllow = useCallback(
    (remember: boolean) => {
      if (approvalBusy) return;
      const phase = nextAllowConfirmPhase(requiresDoubleConfirm, confirmArmed);
      if (phase === 'armed') {
        setConfirmArmed(true);
        setRememberIntent(remember);
        return;
      }
      const doRemember = remember || rememberIntent;
      setConfirmArmed(false);
      setRememberIntent(false);
      onApprovalAllow(firstToolId, firstMsgId, doRemember);
    },
    [
      approvalBusy,
      requiresDoubleConfirm,
      confirmArmed,
      rememberIntent,
      onApprovalAllow,
      firstToolId,
      firstMsgId,
    ]
  );

  const handleDeny = useCallback(() => {
    if (confirmArmed || rememberIntent) {
      setConfirmArmed(false);
      setRememberIntent(false);
    }
    if (approvalBusy) return;
    onApprovalDeny(firstToolId, firstMsgId);
  }, [
    confirmArmed,
    rememberIntent,
    approvalBusy,
    onApprovalDeny,
    firstToolId,
    firstMsgId,
  ]);

  if (!shouldRenderPermissionBar(pendingCount, firstToolId)) return null;

  const more = permissionBarMoreCount(pendingCount);
  const moreLabel = permissionBarMoreLabel(more);
  const summary = firstSummary.trim() || '需要你的确认';
  const cmd = firstCommand?.trim() || '';
  const moreTip = moreLabel ? `队列中${moreLabel}项待确认` : '';

  return (
    <div
      className={styles.bar}
      role="region"
      aria-label="权限确认"
      data-permission-bar=""
      data-tool-id={firstToolId}
      data-msg={firstMsgId || undefined}
      data-pending-count={String(pendingCount)}
      data-confirm-armed={confirmArmed ? 'true' : undefined}
      tabIndex={-1}
    >
      <div className={styles.line1}>
        <span className={styles.summary}>{summary}</span>
        {moreLabel ? (
          <Tooltip content={moreTip}>
            <span className={styles.more}>{moreLabel}</span>
          </Tooltip>
        ) : null}
      </div>
      {cmd && cmd !== summary ? (
        <code className={styles.cmd}>{cmd}</code>
      ) : null}
      {confirmArmed ? (
        <div className={styles.warn} role="alert">
          {rememberIntent
            ? '高风险操作：再点一次才会执行并加入白名单'
            : '高风险操作：再点一次才会执行'}
        </div>
      ) : null}
      <div className={styles.actions} role="group" aria-label="审批操作">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={approvalBusy}
          onClick={() => fireAllow(true)}
          aria-label={
            requiresDoubleConfirm
              ? '记住并准备允许（需再次确认）'
              : '允许并记住命令前缀'
          }
        >
          {allowButtonLabel(requiresDoubleConfirm, confirmArmed, true)}
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={approvalBusy}
          onClick={handleDeny}
          aria-label="拒绝此操作"
        >
          拒绝
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={approvalBusy}
          onClick={() => fireAllow(false)}
          aria-label={
            confirmArmed
              ? rememberIntent
                ? '再次确认允许并记住'
                : '再次确认允许'
              : requiresDoubleConfirm
                ? '准备允许（需再次确认）'
                : '允许'
          }
          aria-pressed={requiresDoubleConfirm ? confirmArmed : undefined}
          data-armed={confirmArmed ? 'true' : undefined}
        >
          {allowButtonLabel(requiresDoubleConfirm, confirmArmed, rememberIntent)}
        </Button>
      </div>
    </div>
  );
}
