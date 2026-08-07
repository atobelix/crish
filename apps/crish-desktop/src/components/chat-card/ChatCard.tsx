import React, { Suspense, lazy } from 'react';
import styles from './ChatCard.module.css';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { ChatMessageList } from '../chat-message-list/ChatMessageList';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatComposer } from '../chat-composer/ChatComposer';
import { ModelBadgePicker } from './ChatHeaderControls';
import { useChatCardState } from './useChatCardState';
import { ChatHeader } from './ChatHeader';
import { ChatComposerWrapper } from './ChatComposerWrapper';
import { WithdrawConfirmDialog } from '../overlay/WithdrawConfirmDialog';

const ScheduledTasksPanel = lazy(() =>
  import('../settings/ScheduledTasksPanel').then((m) => ({
    default: m.ScheduledTasksPanel,
  }))
);

interface ChatCardProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: ShowToastFn;
  handleGlobalTabClick: (cardId: string) => void;
  /**
   * 绑定的会话 id（Shell redesign：TabSurface.sessionId）。
   * 未传时回退全局 activeSessionId（兼容旧调用）。
   */
  sessionId?: string | null;
}

export const ChatCard: React.FC<ChatCardProps> = React.memo(
  ({ wsId, onShowToast, handleGlobalTabClick, sessionId }) => {
    const state = useChatCardState({
      wsId,
      onShowToast,
      handleGlobalTabClick,
      sessionId,
    });

    const composerElement = (
      <ChatComposer
        chatInput={state.composerProps.chatInput}
        setChatInput={state.composerProps.setChatInput}
        isComposing={state.composerProps.isComposing}
        setIsComposing={state.composerProps.setIsComposing}
        slashMenuOpen={state.composerProps.slashMenuOpen}
        setSlashMenuOpen={state.composerProps.setSlashMenuOpen}
        slashSelectedIndex={state.composerProps.slashSelectedIndex}
        setSlashSelectedIndex={state.composerProps.setSlashSelectedIndex}
        filteredCommands={state.composerProps.filteredCommands}
        loadSkillSlash={state.composerProps.loadSkillSlash}
        onPasteImage={state.composerProps.handlePasteImage}
        onSend={state.composerProps.onSend}
        onStop={state.composerProps.handleStopGeneration}
        onForceStop={state.composerProps.handleForceCancelGeneration}
        queuedMessages={state.composerProps.queuedMessages}
        onSendQueuedNow={state.composerProps.sendQueuedMessageNow}
        onEditQueued={state.composerProps.editQueuedMessage}
        onDeleteQueued={state.composerProps.deleteQueuedMessage}
        canSend={state.composerProps.canSend}
        isProcessing={state.isProcessing}
        attachments={state.composerProps.attachments}
        setAttachments={state.composerProps.setAttachments}
        fileInputRef={state.composerProps.fileInputRef}
        onFilesSelected={state.composerProps.handleFilesSelected}
        showPlusMenu={state.composerProps.showPlusMenu}
        setShowPlusMenu={state.composerProps.setShowPlusMenu}
        permissionMode={state.permissionMode}
        onPermissionChange={(m) => {
          state.setPermissionMode(m);
        }}
        onOpenSchedule={() => {
          state.setMainSurface('scheduled');
        }}
        // P1-F4 根因修复：移除「打开 + 菜单时把 showPlusMenu 置 false」的错误
        // 接线——ChatComposer 打开「+」菜单时回调 onCloseSiblingMenus，此处
        // 却把刚打开的菜单关掉（React 批处理后 state 恒为 false，菜单永远
        // 打不开）；且 ChatComposer 其余兄弟菜单（权限模式等）均为自管状态，
        // 本接线既无关闭对象又自相矛盾，删除。
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
          <ChatHeader
            mainSurface={state.mainSurface}
            showMsgFilter={state.showMsgFilter}
            localMsgFilter={state.localMsgFilter}
            setLocalMsgFilter={state.setLocalMsgFilter}
            setShowMsgFilter={state.setShowMsgFilter}
            displayCount={state.displayMessages.length}
            totalCount={state.messages.length}
            inputRef={state.msgFilterInputRef}
            activeSessionId={state.activeSessionId}
            onExportMarkdown={state.handleExportMarkdown}
            onClearHistory={
              state.activeSessionId &&
              !state.activeSessionId.startsWith('__pending')
                ? () => {
                    // 清空当前会话消息（不删会话）
                    const sid = state.activeSessionId;
                    if (!sid) return;
                    state.clearSessionMessages(sid);
                  }
                : undefined
            }
          />

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
                  onShowToast={onShowToast}
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
              <ChatMessageList
                messages={state.displayMessages}
                allMessages={state.messages}
                agents={state.agents}
                activeSessionId={state.activeSessionId || ''}
                showAllMessages={state.isFiltering}
                showProjectPicker={state.showProjectPicker}
                onShowProjectPicker={state.setShowProjectPicker}
                onProjectChanged={state.handleProjectChanged}
                onSetChatInput={state.composerProps.setChatInput}
                onSendFollowUp={state.handleSendFollowUp}
                onWithdraw={state.handleWithdraw}
                onRegenerate={state.handleRegenerate}
                onBranch={state.handleBranch}
                onShowToast={onShowToast}
                approvalBusy={state.approvalState.approvalBusy}
                pendingApprovalMsgId={state.approvalState.pendingApprovalMsgId}
                onOpenDiff={state.openDiffInRightPanel}
                onOpenPath={state.openPathInFilesPanel}
                onOpenTerminal={state.handleOpenTerminal}
                onOpenDiffPanel={state.handleOpenDiffPanel}
                onApprovalAllow={state.approvalState.handleApprovalAllow}
                onApprovalDeny={state.approvalState.handleApprovalDeny}
                onBatchApprove={state.approvalState.handleBatchApprove}
                onBatchDeny={state.approvalState.handleBatchDeny}
              />
            )}
          </div>

          <ChatComposerWrapper
            mainSurface={state.mainSurface}
            emptyKind={state.emptyKind}
            composerElement={composerElement}
            diffFiles={state.diffFiles}
            engineHint={state.engineHint}
            needsKeySetup={state.needsKeySetup}
            needsModelSetup={state.needsModelSetup}
            onEmptySurface={state.onEmptySurface}
            onOpenModelSettings={() => state.openSettings('models')}
            onOpenModelDropdown={() => state.setShowModelDropdown(true)}
            inPlanMode={state.inPlanMode}
            planApproved={state.planApproved}
            onApprovePlan={() => {
              state.setPermissionMode('ask');
              state.setPlanApproved(true);
            }}
            goalModeActive={state.goalModeActive}
            goalMode={state.goalMode}
            onStopGoal={() => {
              state.composerProps.handleStopGeneration();
              if (state.activeSessionId) {
                state.patchSession(state.activeSessionId, { goalMode: null });
              }
            }}
            showScrollToBottom={state.showScrollToBottom}
            onScrollToBottom={state.scrollToBottom}
            runNotice={state.composerProps.runNotice}
            onDismissRunNotice={() => state.composerProps.setRunNotice(null)}
            pendingApprovalCount={state.approvalState.pendingApprovalCount}
            showApprovalDock={state.approvalState.approvalDockVisible}
            pendingApprovalSummary={
              state.approvalState.pendingApprovalDockLabel
            }
            pendingApprovalToolId={state.approvalState.pendingApprovalToolId}
            pendingApprovalMsgId={state.approvalState.pendingApprovalMsgId}
            activeSessionId={state.activeSessionId}
            onShowToast={onShowToast}
            openSidePanel={state.openSidePanel}
            handleGlobalTabClick={handleGlobalTabClick}
          />
        </div>

        {state.pendingWithdraw ? (
          <WithdrawConfirmDialog
            scope={state.pendingWithdraw}
            isOpen={!!state.pendingWithdraw}
            onConfirm={() => {
              void state.confirmWithdraw();
            }}
            onCancel={state.cancelWithdraw}
          />
        ) : null}
      </>
    );
  }
);

ChatCard.displayName = 'ChatCard';
