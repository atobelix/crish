import React from 'react';
import styles from './ChatCard.module.css';
import { ChatStatusRibbons } from './ChatStatusRibbons';
import { anyProfileHasKey } from '../../api/providerProfiles';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import type { FileDiff } from '../../store/layoutStore';

export interface ChatComposerWrapperProps {
  mainSurface: string;
  emptyKind: string | null;
  composerElement: React.ReactNode;
  diffFiles: FileDiff[];
  engineHint: any;
  needsKeySetup: boolean;
  needsModelSetup: boolean;
  onEmptySurface: any;
  onOpenModelSettings: () => void;
  onOpenModelDropdown: () => void;
  inPlanMode: boolean;
  planApproved: boolean;
  onApprovePlan: () => void;
  goalModeActive: boolean;
  goalMode: any;
  onStopGoal: () => void;
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
  runNotice: any;
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
  emptyKind,
  composerElement,
  diffFiles,
  engineHint,
  needsKeySetup,
  needsModelSetup,
  onEmptySurface,
  onOpenModelSettings,
  onOpenModelDropdown,
  inPlanMode,
  planApproved,
  onApprovePlan,
  goalModeActive,
  goalMode,
  onStopGoal,
  showScrollToBottom,
  onScrollToBottom,
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
  handleGlobalTabClick,
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
          onOpenTerminal={() => openSidePanel('terminal')}
          onOpenDiff={() => openSidePanel('diff')}
          diffCount={diffFiles.length}
          engineHint={engineHint}
          needsKeySetup={needsKeySetup}
          needsModelSetup={needsModelSetup}
          onEmptySurface={onEmptySurface}
          localHasKey={anyProfileHasKey()}
          onOpenModelSettings={onOpenModelSettings}
          onOpenModelDropdown={onOpenModelDropdown}
          inPlanMode={inPlanMode}
          planApproved={planApproved}
          onApprovePlan={onApprovePlan}
          goalModeActive={goalModeActive}
          goalText={goalMode?.goal || ''}
          goalIteration={goalMode?.iteration ?? 0}
          goalTasksDone={(goalMode?.tasks || []).filter((t: any) => t.done).length}
          goalTasksTotal={(goalMode?.tasks || []).length}
          onStopGoal={onStopGoal}
          showScrollToBottom={showScrollToBottom}
          onScrollToBottom={onScrollToBottom}
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

ChatComposerWrapper.displayName = 'ChatComposerWrapper';
