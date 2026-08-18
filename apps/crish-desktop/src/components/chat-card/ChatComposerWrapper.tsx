import React from 'react';
import styles from './ChatCard.module.css';
import {
  ChatStatusRibbons,
  type StreamingRibbonProps,
  type GoalRibbonProps,
  type ApprovalRibbonProps,
} from './ChatStatusRibbons';
import type { } from '../../hooks/useToastQueue';
import type { RunNotice } from '../../hooks/useChatStream';

/**
 * R2-5 B3（P1-12 聚合）：ChatStatusRibbons 专属字段分组（ribbons 对象由调用方
 * 构造稳定引用，案甲：ChatCard 层 useMemo）——消除 20+ 字段平铺 drilling。
 * streaming/goal 子对象由 ribbons 传入；approval/runNotice/activeSessionId
 * 仍平铺（它们同时被 ChatComposerWrapper 其他消费面引用）。
 */
export interface RibbonsGroup {
  streaming: Omit<StreamingRibbonProps, 'runNotice' | 'onDismissRunNotice'>;
  goal: GoalRibbonProps;
}

export interface ChatComposerWrapperProps {
  mainSurface: string;
  emptyKind: string | null;
  composerElement: React.ReactNode;
  /** R2-5 B3：ribbons 专属字段分组（调用方构造稳定引用） */
  ribbons: RibbonsGroup;
  runNotice: RunNotice | null;
  onDismissRunNotice: () => void;
  pendingApprovalCount: number;
  showApprovalDock: boolean;
  pendingApprovalSummary: string;
  pendingApprovalToolId: string;
  pendingApprovalMsgId: string;
  activeSessionId: string | null;
  openSidePanel: (panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files') => void;
  handleGlobalTabClick: (cardId: string) => void;
}

export const ChatComposerWrapper: React.FC<ChatComposerWrapperProps> = React.memo(({
  mainSurface,
  composerElement,
  ribbons,
  runNotice,
  onDismissRunNotice,
  pendingApprovalCount,
  showApprovalDock,
  pendingApprovalSummary,
  pendingApprovalToolId,
  pendingApprovalMsgId,
  activeSessionId,
}) => {
  // 组装审批域子对象（平铺字段 → ApprovalRibbonProps）
  const approval: ApprovalRibbonProps = {
    pendingApprovalCount,
    showApprovalDock,
    pendingApprovalSummary,
    pendingApprovalToolId,
    pendingApprovalMsgId,
    activeSessionId,
  };

  return (
    <div
      className={styles.chatFooter}
      data-testid="chat-footer"
      style={{
        display: mainSurface === 'scheduled' ? 'none' : undefined,
      }}
    >
      {/* chatCol 与消息 listInner 同 max-width / 水平 padding，对齐 stream + composer */}
      <div className={styles.chatCol}>
        <ChatStatusRibbons
          streaming={{ ...ribbons.streaming, runNotice, onDismissRunNotice }}
          goal={ribbons.goal}
          approval={approval}
        />

        {/* composer 始终在 .chatFooter 渲染（不再注入到 ChatEmptyState 内）。 */}
        {composerElement}
      </div>
    </div>
  );
});
