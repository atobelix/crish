import React from 'react';
import styles from './ChatCard.module.css';
import { ChatStatusRibbons, type ChatStatusRibbonsProps } from './ChatStatusRibbons';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import type { RunNotice } from '../../hooks/useChatStream';

/**
 * R2-5 B3（P1-12 聚合）：ChatStatusRibbons 专属字段分组（ribbons 对象由调用方
 * 构造稳定引用，案甲：ChatCard 层 useMemo）——消除 20+ 字段平铺 drilling。
 * runNotice/onDismissRunNotice/approval 族/activeSessionId/onShowToast 仍平铺
 * （它们同时被 ChatComposerWrapper 其他消费面引用）。
 */
export type RibbonsGroup = Omit<
  ChatStatusRibbonsProps,
  | 'runNotice'
  | 'onDismissRunNotice'
  | 'pendingApprovalCount'
  | 'showApprovalDock'
  | 'pendingApprovalSummary'
  | 'pendingApprovalToolId'
  | 'pendingApprovalMsgId'
  | 'activeSessionId'
  | 'onShowToast'
>;

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
  onShowToast: ShowToastFn;
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
  onShowToast,
  openSidePanel,
}) => {
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
          {...ribbons}
          runNotice={runNotice}
          onDismissRunNotice={onDismissRunNotice}
          pendingApprovalCount={pendingApprovalCount}
          showApprovalDock={showApprovalDock}
          pendingApprovalSummary={pendingApprovalSummary}
          pendingApprovalToolId={pendingApprovalToolId}
          pendingApprovalMsgId={pendingApprovalMsgId}
          activeSessionId={activeSessionId}
          onShowToast={onShowToast}
        />

        {/* composer 始终在 .chatFooter 渲染（不再注入到 ChatEmptyState 内）。 */}
        {composerElement}
      </div>
    </div>
  );
});
