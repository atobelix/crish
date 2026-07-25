import React, { Suspense, lazy } from 'react';
import styles from './ChatCard.module.css';
import type { ShowToastFn } from '../hooks/useToastQueue';
import { ChatMessageList } from './ChatMessageList';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatComposer } from './ChatComposer';
import { ModelBadgePicker } from './chat-card/ChatHeaderControls';
import { useChatCardState } from './chat-card/useChatCardState';
import { ChatHeader } from './chat-card/ChatHeader';
import { ChatComposerWrapper } from './chat-card/ChatComposerWrapper';

const ScheduledTasksPanel = lazy(() =>
  import('./ScheduledTasksPanel').then((m) => ({
    default: m.ScheduledTasksPanel,
  }))
);

interface ChatCardProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: ShowToastFn;
  handleGlobalTabClick: (cardId: string) => void;
}

export const ChatCard: React.FC<ChatCardProps> = React.memo(
  ({ wsId, onShowToast, handleGlobalTabClick }) => {
    const state = useChatCardState({
      wsId,
      onShowToast,
      handleGlobalTabClick,
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
        onSend={() => {
          void state.composerProps.handleSendChat(false);
        }}
        onStop={state.composerProps.handleStopGeneration}
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
        onCloseSiblingMenus={() => state.composerProps.setShowPlusMenu(false)}
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
      <div
        className={styles.chatBody}
        role="region"
        aria-label={state.chatRegionAria}
        aria-busy={state.messagesLoading || undefined}
        data-main-surface={state.mainSurface}
        data-empty-kind={state.emptyKind ?? undefined}
        data-messages-loading={state.messagesLoading ? 'true' : undefined}
        data-engine-ok={
          state.engineOk === false ? 'false' : state.engineOk === true ? 'true' : 'unknown'
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
        />

        <div
          className={styles.chatDocFlow}
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
              composer={
                state.emptyKind === 'session-empty'
                  ? React.cloneElement(composerElement, {
                      className: styles.emptyComposer,
                    })
                  : undefined
              }
            />
          ) : (
            <ChatMessageList
              messages={state.displayMessages}
              agents={state.agents}
              activeSessionId={state.activeSessionId || ''}
              thinkingSeconds={state.thinkingSeconds}
              showAllMessages={state.isFiltering}
              showProjectPicker={state.showProjectPicker}
              onShowProjectPicker={state.setShowProjectPicker}
              onProjectChanged={() => state.setProjectTick((n) => n + 1)}
              onSetChatInput={state.composerProps.setChatInput}
              onSendFollowUp={(prompt) => {
                void state.composerProps.handleSendChat(false, prompt);
              }}
              onWithdraw={state.handleWithdraw}
              onRegenerate={state.handleRegenerate}
              onBranch={state.handleBranch}
              onShowToast={onShowToast}
              approvalBusy={state.approvalState.approvalBusy}
              pendingApprovalMsgId={state.approvalState.pendingApprovalMsgId}
              onOpenDiff={state.openDiffInRightPanel}
              onOpenPath={state.openPathInFilesPanel}
              onOpenTerminal={() => state.openSidePanel('terminal')}
              onOpenDiffPanel={() => state.openSidePanel('diff')}
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
          pendingApprovalSummary={state.approvalState.pendingApprovalDockLabel}
          pendingApprovalToolId={state.approvalState.pendingApprovalToolId}
          pendingApprovalMsgId={state.approvalState.pendingApprovalMsgId}
          activeSessionId={state.activeSessionId}
          onShowToast={onShowToast}
          openSidePanel={state.openSidePanel}
          handleGlobalTabClick={handleGlobalTabClick}
        />
      </div>
    );
  }
);

ChatCard.displayName = 'ChatCard';
