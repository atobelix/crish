import React from 'react';
import { allowButtonLabel } from '../../api/chatApprovalUi';
import { Tooltip } from '../ui';
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
          <button
            type="button"
            className={`${styles.approvalCardBtn} ${styles.ghost} ${styles.disarm}`}
            disabled={busy}
            onClick={onDisarm}
            aria-label="取消二次确认准备"
            aria-keyshortcuts="Escape"
          >
            取消准备
          </button>
        </Tooltip>
      ) : (
        <Tooltip content="允许，并将命令前缀加入白名单">
          <button
            type="button"
            className={`${styles.approvalCardBtn} ${styles.ghost}`}
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
          </button>
        </Tooltip>
      )}
      <button
        type="button"
        className={`${styles.approvalCardBtn} ${styles.deny}`}
        disabled={busy}
        onClick={onDeny}
        aria-label="拒绝此操作"
        aria-busy={busy ? true : undefined}
      >
        拒绝
      </button>
      <button
        ref={allowBtnRef}
        type="button"
        className={`${styles.approvalCardBtn} ${styles.allow}${confirmArmed ? ` ${styles.isArmed}` : ''}`}
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
      </button>
    </div>
  );
};
