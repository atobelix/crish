import React, { Suspense, lazy } from 'react';
import styles from './ChatCard.module.css';
import type { } from '../../hooks/useToastQueue';
import { ChatMessageList } from '../chat-message-list/ChatMessageList';
import type { ChatMessageListProps } from '../chat-message-list/chatMessageListProps';
import '../chat-message-list/workspaceChatStream.slot';
import './workspaceChatComposerAbove.slot';
import { SlotOutlet } from '../../services/view-registry';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatComposer } from '../chat-composer/ChatComposer';
import { ModelBadgePicker } from './ChatHeaderControls';
import { useChatCardState } from './useChatCardState';
import { anyProfileHasKey } from '../../api/providerProfiles';
import { ChatComposerWrapper } from './ChatComposerWrapper';
import { openSettings, patchSession } from '../../api/storeAccess';

const ScheduledTasksPanel = lazy(() =>
  import('../settings/ScheduledTasksPanel').then((m) => ({
    default: m.ScheduledTasksPanel,
  }))
);

import { useToast } from '../../services/toast/ToastContext';

export interface ChatCardProps {
  handleGlobalTabClick: (cardId: string) => void;
  sessionId?: string | null;
  /** @deprecated @see ChatCard 保持可选向后兼容 */
  wsId?: string;
  colIdx?: number;
  groupIdx?: number;
}

export const ChatCard: React.FC<ChatCardProps> = React.memo(
  ({ wsId = 'default', handleGlobalTabClick, sessionId }) => {
    const { showToast: _showToast } = useToast();
    const state = useChatCardState({
      wsId,
      handleGlobalTabClick,
      sessionId,
    });

    // R2-5 B1（P1-12 聚合）：ChatComposer 主要 props 经 spread 传递；
    // on* 命名差异字段（handle* → on*）保持显式映射（消除 30 字段逐项拆包）
    const composerElement = (
      <ChatComposer
        {...state.composerProps}
        onPasteImage={state.composerProps.handlePasteImage}
        onStop={state.composerProps.handleStopGeneration}
        onForceStop={state.composerProps.handleForceCancelGeneration}
        onFilesSelected={state.composerProps.handleFilesSelected}
        onOpenPath={state.openPathInFilesPanel}
        isProcessing={state.isProcessing}
        permissionMode={state.permissionMode}
        onPermissionChange={(m) => {
          state.setPermissionMode(m);
        }}
        onOpenSchedule={() => {
          state.setMainSurface('scheduled');
        }}
        // R1 撤回（统一输入流收敛战役）：composer 撤回按钮 → 引擎
        // session_retract（停 run → 冻结 → timeline-truncate → 投影重放）
        onRetract={state.handleRetract}
        canRetract={state.messages?.some((m) => m.sender === 'user')}
        rightActions={
          state.showModelPicker ? (
            <ModelBadgePicker
              engineModel={state.engineModel}
              activeProfileId={state.activeProfileId}
              needsModelSetup={state.needsModelSetup}
              showModelDropdown={state.showModelDropdown}
              setShowModelDropdown={state.setShowModelDropdown}
            />
          ) : null
        }
      />
    );

    // R2-5 B3（P1-12 聚合）：ChatStatusRibbons 专属字段分组 + 派生上移（案甲）——
    // ① localHasKey 上移（模块级调用稳定）② onOpenTerminal/onOpenDiff 闭包上移
    // ③ goalMode 四派生值在此计算；ribbons 对象 useMemo 稳定引用
    const ribbons = React.useMemo(
      () => ({
        streaming: {
          onOpenTerminal: () => state.openSidePanel('terminal'),
          onOpenDiff: () => state.openSidePanel('diff'),
          diffCount: state.diffFiles.length,
          engineHint: state.engineHint,
          needsKeySetup: state.needsKeySetup,
          needsModelSetup: state.needsModelSetup,
          onEmptySurface: state.onEmptySurface,
          localHasKey: anyProfileHasKey(),
          onOpenModelSettings: () => openSettings('models'),
          onOpenModelDropdown: () => state.setShowModelDropdown(true),
          showScrollToBottom: state.showScrollToBottom,
          onScrollToBottom: state.scrollToBottom,
        },
        goal: {
          inPlanMode: state.inPlanMode,
          planApproved: state.planApproved,
          onApprovePlan: () => {
            state.setPermissionMode('ask');
            state.setPlanApproved(true);
          },
          goalModeActive: state.goalModeActive,
          goalText: state.goalMode?.goal || '',
          goalIteration: state.goalMode?.iteration ?? 0,
          goalTasksDone: (state.goalMode?.tasks || []).filter((t) => t.done)
            .length,
          goalTasksTotal: (state.goalMode?.tasks || []).length,
          onStopGoal: () => {
            state.composerProps.handleStopGeneration();
            if (state.activeSessionId) {
              patchSession(state.activeSessionId, { goalMode: null });
            }
          },
        },
      }),

      [state]
    );

    // 有消息枝才进 stream 槽；空态 / 定时任务面保持现逻辑，不被槽吞掉
    const chatStreamProps: ChatMessageListProps = {
      messages: {
        messages: state.displayMessages,
        allMessages: state.messages,
        agents: state.agents,
        activeSessionId: state.activeSessionId || '',
        showAllMessages: state.isFiltering,
      },
      projectPicker: {
        showProjectPicker: state.showProjectPicker,
        onShowProjectPicker: state.setShowProjectPicker,
        onProjectChanged: state.handleProjectChanged,
      },
      composer: {
        onSetChatInput: state.composerProps.setChatInput,
        onSendFollowUp: state.handleSendFollowUp,
      },
      generation: {
        onRegenerate: state.handleRegenerate,
        onBranch: state.handleBranch,
      },
      approval: {
        approvalBusy: state.approvalState.approvalBusy,
        pendingApprovalMsgId: state.approvalState.pendingApprovalMsgId,
        onApprovalAllow: state.approvalState.handleApprovalAllow,
        onApprovalDeny: state.approvalState.handleApprovalDeny,
        onBatchApprove: state.approvalState.handleBatchApprove,
        onBatchDeny: state.approvalState.handleBatchDeny,
      },
      navigation: {
        onOpenDiff: state.openDiffInRightPanel,
        onOpenPath: state.openPathInFilesPanel,
        onOpenTerminal: state.handleOpenTerminal,
        onOpenDiffPanel: state.handleOpenDiffPanel,
      },
    };

    return (
      <>
        <div
          className={styles.chatBody}
          data-testid="chat-body"
          role="region"
          aria-label={state.chatRegionAria}
          aria-busy={state.messagesLoading || undefined}
          data-main-surface={state.mainSurface}
          data-empty-kind={state.emptyKind ?? undefined}
          data-messages-loading={state.messagesLoading ? 'true' : undefined}
          data-engine-ok={
            state.engineOk === false
              ? 'false'
              : state.engineOk === true
                ? 'true'
                : 'unknown'
          }
          data-approval-mode={state.approvalState.approvalUiPlan.mode}
        >
          <div
            className={styles.chatDocFlow}
            data-testid="chat-doc-flow"
            data-empty={state.emptyKind != null ? 'true' : undefined}
            ref={state.chatFlowRef}
            aria-busy={state.messagesLoading || undefined}
          >
            {state.mainSurface === 'scheduled' ? (
              <Suspense fallback={null}>
                <ScheduledTasksPanel
                  onBackToChat={() => state.setMainSurface('chat')}
                />
              </Suspense>
            ) : state.emptyKind != null ? (
              <div className={styles.chatCol} data-empty-col="true">
                <ChatEmptyState
                  kind={state.emptyKind}
                  filterQuery={state.localMsgFilter}
                  needsKeySetup={state.needsKeySetup}
                  needsModelSetup={state.needsModelSetup}
                  firstRunOpen={state.firstRunOpen}
                  engineOk={state.engineOk}
                  messagesLoading={state.messagesLoading}
                  showProjectPicker={state.showProjectPicker}
                  onShowProjectPicker={state.setShowProjectPicker}
                  onProjectChanged={() => state.setProjectTick((n) => n + 1)}
                  onSetChatInput={state.composerProps.setChatInput}
                  onCreateSession={state.handleCreateSessionFromEmpty}
                  onClearFilter={() => state.setLocalMsgFilter('')}
                />
              </div>
            ) : (
              <SlotOutlet
                slotKey="workspace.chat.stream"
                context={chatStreamProps}
                fallback={<ChatMessageList {...chatStreamProps} />}
              />
            )}
          </div>

          <ChatComposerWrapper
            mainSurface={state.mainSurface}
            emptyKind={state.emptyKind}
            composerElement={composerElement}
            ribbons={ribbons}
            runNotice={state.composerProps.runNotice}
            onDismissRunNotice={() => state.composerProps.setRunNotice(null)}
            pendingApprovalCount={state.approvalState.pendingApprovalCount}
            showApprovalDock={state.approvalState.approvalDockVisible}
            pendingApprovalSummary={
              state.approvalState.pendingApprovalDockLabel
            }
            pendingApprovalToolId={state.approvalState.pendingApprovalToolId}
            pendingApprovalMsgId={state.approvalState.pendingApprovalMsgId}
            approvalBusy={state.approvalState.approvalBusy}
            onApprovalAllow={state.approvalState.handleApprovalAllow}
            onApprovalDeny={state.approvalState.handleApprovalDeny}
            activeSessionId={state.activeSessionId}
            openSidePanel={state.openSidePanel}
            handleGlobalTabClick={handleGlobalTabClick}
          />
        </div>
      </>
    );
  }
);

ChatCard.displayName = 'ChatCard';
