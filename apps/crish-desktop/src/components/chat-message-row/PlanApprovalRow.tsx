import React from 'react';
import styles from './ChatMessageRow.module.css';
import { Button } from '../ui';
import type { PermissionMode } from '../../api/permissionModes';
import { looksLikePlan } from './chatMessageRowUtils';

// ─── Assistant Message Plan Approval Row ───────────────────────────────────

export interface PlanApprovalRowProps {
  inPlanMode: boolean;
  planApproved: boolean;
  isLastAssistant: boolean;
  text: string;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
}

export const PlanApprovalRow: React.FC<PlanApprovalRowProps> = ({
  inPlanMode,
  planApproved,
  isLastAssistant,
  text,
  setPermissionMode,
  setPlanApproved,
}) => {
  if (!inPlanMode || planApproved || !isLastAssistant || !looksLikePlan(text)) {
    return null;
  }

  return (
    <div className={styles.planApproveRow}>
      <Button
        type="button"
        variant="primary"
        size="sm"
        className={styles.planApproveChip}
        onClick={() => {
          setPermissionMode('ask');
          setPlanApproved(true);
        }}
      >
        批准此计划
      </Button>
    </div>
  );
};
