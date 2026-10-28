import React from 'react';
import { Button, Tooltip } from '@/components/ui';
import styles from './ApprovalAskCard.module.css';

/** 同意/拒绝按钮组（单次确权：取消准备 / 拒绝 / 允许） */
export const ApprovalActions: React.FC<{
  confirmArmed: boolean;
  needsDouble: boolean;
  busy: boolean;
  allowBtnRef: React.RefObject<HTMLButtonElement | null>;
  onDisarm: () => void;
  onAllow: () => void;
  onDeny: () => void;
}> = ({
  confirmArmed,
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
      ) : null}
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
        onClick={onAllow}
        aria-label={
          confirmArmed
            ? '再次确认允许'
            : needsDouble
              ? '准备允许（需再次确认）'
              : '允许'
        }
        aria-pressed={needsDouble ? confirmArmed : undefined}
        aria-busy={busy ? true : undefined}
        data-armed={confirmArmed ? 'true' : undefined}
      >
        {confirmArmed ? '再次确认允许' : needsDouble ? '准备允许' : '允许'}
      </Button>
    </div>
  );
};
