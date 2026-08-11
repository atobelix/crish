import React from 'react';
import { allowButtonLabel } from '../../api/chatApprovalUi';
import { Button, Tooltip } from '../ui';
import styles from './ApprovalAskCard.module.css';

/** 同意/拒绝按钮组（ConfirmButton 组：取消准备 / 记住并允许 / 拒绝 / 允许） */
export const ApprovalActions: React.FC<{
  confirmArmed: boolean;
  rememberIntent: boolean;
  needsDouble: boolean;
  busy: boolean;
  allowBtnRef: React.RefObject<HTMLButtonElement | null>;
  onDisarm: () => void;
  onAllow: (remember: boolean) => void;
  onDeny: () => void;
}> = ({
  confirmArmed,
  rememberIntent,
  needsDouble,
  busy,
  allowBtnRef,
  onDisarm,
  onAllow,
  onDeny,
}) => {
  return (
    <div
      className={styles.approvalCardActions}
      role="group"
      aria-label="审批操作"
    >
      {confirmArmed ? (
        <Tooltip content="取消二次确认准备 (Esc)">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.approvalCardBtn}
            disabled={busy}
            onClick={onDisarm}
            aria-label="取消二次确认准备"
            aria-keyshortcuts="Escape"
          >
            取消准备
          </Button>
        </Tooltip>
      ) : (
        <Tooltip content="允许，并将命令前缀加入白名单">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.approvalCardBtn}
            disabled={busy}
            onClick={() => onAllow(true)}
            aria-label={
              needsDouble
                ? '记住并准备允许（需再次确认）'
                : '允许并记住命令前缀'
            }
            aria-busy={busy ? true : undefined}
          >
            {allowButtonLabel(needsDouble, confirmArmed, true)}
          </Button>
        </Tooltip>
      )}
      <Button
        type="button"
        variant="danger"
        size="sm"
        className={styles.approvalCardBtn}
        disabled={busy}
        onClick={onDeny}
        aria-label="拒绝此操作"
        aria-busy={busy ? true : undefined}
      >
        拒绝
      </Button>
      <Button
        ref={allowBtnRef}
        type="button"
        variant="primary"
        size="sm"
        className={styles.approvalCardBtn}
        disabled={busy}
        onClick={() => onAllow(false)}
        aria-label={
          confirmArmed
            ? rememberIntent
              ? '再次确认允许并记住'
              : '再次确认允许'
            : needsDouble
              ? '准备允许（需再次确认）'
              : '允许'
        }
        aria-pressed={needsDouble ? confirmArmed : undefined}
        aria-busy={busy ? true : undefined}
        data-armed={confirmArmed ? 'true' : undefined}
      >
        {allowButtonLabel(needsDouble, confirmArmed, rememberIntent)}
      </Button>
    </div>
  );
};
