/**
 * workspace.chat.composerAbove 的 ownerProps。
 * 放业务域，避免 SlotTypes 反向 import 组件。
 */

export interface ChatComposerAboveProps {
  pendingCount: number;
  firstToolId: string;
  firstMsgId: string;
  firstSummary: string;
  firstCommand?: string;
  requiresDoubleConfirm?: boolean;
  approvalBusy?: boolean;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
}
