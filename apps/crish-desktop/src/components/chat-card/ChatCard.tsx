import React, { Suspense, lazy, useRef, useState, useEffect } from 'react';
import styles from './ChatCard.module.css';
import { ChatMessageList } from '../chat-message-list/ChatMessageList';
import type { ChatMessageListProps } from '../chat-message-list/chatMessageListProps';
import '../chat-message-list/workspaceChatStream.slot';
import './workspaceChatComposerAbove.slot';
import { SlotOutlet } from '../../services/view-registry';
import { ChatEmptyState } from './ChatEmptyState';
import { ComposerProjectPicker } from './ComposerProjectPicker';
import { ChatLandingBrand } from './ChatLandingBrand';
import { ChatComposer } from '../chat-composer/ChatComposer';
import { ModelBadgePicker } from './ChatHeaderControls';
import { useChatCardState } from './useChatCardState';
import { anyProfileHasKey } from '../../api/providerProfiles';
import { ChatComposerWrapper } from './ChatComposerWrapper';
import { openSettings, patchSession } from '../../api/storeAccess';
import { normalizeMessageAttachments } from '../chat-attachment/AttachmentCard';
import type { SessionMessage } from '../../store/types';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { DURATION_LANDING_SETTLE_MS } from '../../utils/motionTokens';

const ScheduledTasksPanel = lazy(() =>
  import('../settings/ScheduledTasksPanel').then((m) => ({
    default: m.ScheduledTasksPanel,
  }))
);

const ExtensionsMainSurface = lazy(() =>
  import('../extensions-surface/ExtensionsMainSurface').then((m) => ({
    default: m.ExtensionsMainSurface,
  }))
);

import { useChatCardDragDrop } from './useChatCardDragDrop';
import { AppIcon } from '../ui/icons/index';

export type ComposerSurfaceState = 'landing' | 'docking' | 'docked';

export interface ChatCardProps {
  handleGlobalTabClick: (cardId: string) => void;
  sessionId?: string | null;
  wsId?: string;
}

export const ChatCard: React.FC<ChatCardProps> = React.memo(
  ({ wsId = 'default', handleGlobalTabClick, sessionId }) => {
    const state = useChatCardState({
      wsId,
      handleGlobalTabClick,
      sessionId,
    });

    const { rootRef, isDragOver, dragHandlers } = useChatCardDragDrop({
      handlePathsSelected: state.composerProps.handlePathsSelected,
      handleDroppedFiles: state.composerProps.handleDroppedFiles,
    });

    const [editingMessageId, setEditingMessageId] = React.useState<
      string | null
    >(null);
    const [editChatInput, setEditChatInput] = React.useState<string>('');
    const [editAttachments, setEditAttachments] = React.useState<
      ChatAttachment[]
    >([]);
    const [editIsComposing, setEditIsComposing] =
      React.useState<boolean>(false);
    const [editShowPlusMenu, setEditShowPlusMenu] =
      React.useState<boolean>(false);
    const editFileInputRef = React.useRef<HTMLInputElement | null>(null);

    React.useEffect(() => {
      setEditingMessageId(null);
    }, [state.activeSessionId]);

    const handleStartEditMessage = React.useCallback(
      (targetMsg: SessionMessage) => {
        setEditingMessageId(targetMsg.id);
        setEditChatInput(targetMsg.text || '');
        const cards = normalizeMessageAttachments(
          targetMsg.attachments,
          targetMsg.images
        );
        setEditAttachments(
          cards.map((item) => ({
            id:
              item.id ||
              `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: item.name || '附件',
            path: item.path,
            mime: item.mime,
            dataUrl: item.dataUrl,
            thumbnailUrl: item.dataUrl,
            isImage: item.isImage,
            size: item.size,
            status: 'ready' as const,
            progress: 100,
          }))
        );
      },
      []
    );

    const handleCancelEditMessage = React.useCallback(() => {
      setEditingMessageId(null);
      setEditChatInput('');
      setEditAttachments([]);
    }, []);

    const handleSaveEditMessage = React.useCallback(async () => {
      if (!editingMessageId) return;
      const targetId = editingMessageId;
      const newText = editChatInput;
      const newAttachments = editAttachments;
      setEditingMessageId(null);
      setEditChatInput('');
      setEditAttachments([]);
      await state.handleEditMessageAndResend(targetId, newText, newAttachments);
    }, [editingMessageId, editChatInput, editAttachments, state]);

    const handleEditDroppedFiles = React.useCallback(async (files: File[]) => {
      const mapped = files.map((f) => ({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name,
        mime: f.type,
        size: f.size,
        path: (f as { path?: string }).path,
        status: 'ready' as const,
        progress: 100,
      }));
      setEditAttachments((prev) => [...prev, ...mapped]);
    }, []);

    const handleEditPasteImage = React.useCallback(
      async (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items?.length) return;
        const imageFiles: File[] = [];
        for (const item of Array.from(items)) {
          if (!item.type.startsWith('image/')) continue;
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
        if (!imageFiles.length) return;
        try {
          const { blobToImageAttachment } =
            await import('../../api/imageProcessing');
          const next: ChatAttachment[] = [];
          for (const f of imageFiles) {
            next.push(await blobToImageAttachment(f, f.name || undefined));
          }
          setEditAttachments((prev) => [...prev, ...next]);
        } catch {
          // ignore
        }
      },
      []
    );

    const mainModelBadgeNode = state.showModelPicker ? (
      <ModelBadgePicker
        engineModel={state.engineModel}
        needsModelSetup={state.needsModelSetup}
        showModelDropdown={state.showModelDropdown}
        setShowModelDropdown={state.setShowModelDropdown}
      />
    ) : null;

    const editModelBadgeNode = state.showModelPicker ? (
      <ModelBadgePicker
        engineModel={state.engineModel}
        needsModelSetup={state.needsModelSetup}
      />
    ) : null;

    // 显式表面过渡状态机（ComposerSurfaceCoordinator）：
    // 严格解耦场景 A（同一会话首条消息发送：自然落底协同滑动）与 场景 B（切换会话标签：极简瞬时直切）
    const isLandingKind = state.emptyKind === 'session-empty';
    const [surfaceState, setSurfaceState] = useState<ComposerSurfaceState>(
      () => (isLandingKind ? 'landing' : 'docked')
    );
    const prevSessionIdRef = useRef(state.activeSessionId);
    const prevEmptyKindRef = useRef(state.emptyKind);

    useEffect(() => {
      let timer: number | undefined;
      const isSameSession = prevSessionIdRef.current === state.activeSessionId;
      const wasLanding = prevEmptyKindRef.current === 'session-empty';
      const isNowDocked = state.emptyKind == null;

      if (!isSameSession) {
        // 场景 B：切换会话标签页时瞬时就位，不进入跨视口物理滑动
        setSurfaceState(isLandingKind ? 'landing' : 'docked');
      } else if (wasLanding && isNowDocked) {
        // 场景 A：当前会话发送首条消息，触发平滑降落停靠态（docking）
        setSurfaceState('docking');
        timer = window.setTimeout(() => {
          setSurfaceState('docked');
        }, DURATION_LANDING_SETTLE_MS);
      } else {
        setSurfaceState(isLandingKind ? 'landing' : 'docked');
      }

      prevSessionIdRef.current = state.activeSessionId;
      prevEmptyKindRef.current = state.emptyKind;

      return () => {
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
      };
    }, [state.activeSessionId, state.emptyKind, isLandingKind]);

    const isLanding = surfaceState === 'landing';
    const isDocking = surfaceState === 'docking';

    // 底部主输入框：持续常驻，草稿状态完全独立保全
    const mainComposerElement = (
      <ChatComposer
        {...state.composerProps}
        emptyKind={state.emptyKind}
        layoutVariant={isLanding ? 'multiline' : 'adaptive'}
        onPasteImage={state.composerProps.handlePasteImage}
        onPasteFiles={state.composerProps.handlePasteFiles}
        onStop={state.composerProps.handleStopGeneration}
        onForceStop={state.composerProps.handleForceCancelGeneration}
        onFilesSelected={state.composerProps.handleDroppedFiles}
        onPickFiles={state.composerProps.handlePickFiles}
        onOpenPath={state.openPathInFilesPanel}
        isProcessing={state.isProcessing}
        permissionMode={state.permissionMode}
        onPermissionChange={(m) => {
          state.setPermissionMode(m);
        }}
        rightActions={mainModelBadgeNode}
      />
    );

    // 原位编辑输入框：在被编辑用户消息行原位呼出，具备独立输入/附件态与叉号取消
    const editComposerElement = editingMessageId ? (
      <ChatComposer
        chatInput={editChatInput}
        setChatInput={setEditChatInput}
        isComposing={editIsComposing}
        setIsComposing={setEditIsComposing}
        filteredCommands={state.composerProps.filteredCommands}
        loadSkillSlash={state.composerProps.loadSkillSlash}
        onPasteImage={handleEditPasteImage}
        onPasteFiles={handleEditDroppedFiles}
        onSend={handleSaveEditMessage}
        onStop={state.composerProps.handleStopGeneration}
        canSend={Boolean(editChatInput.trim() || editAttachments.length > 0)}
        isProcessing={state.isProcessing}
        attachments={editAttachments}
        setAttachments={setEditAttachments}
        fileInputRef={editFileInputRef}
        onFilesSelected={handleEditDroppedFiles}
        onPickFiles={state.composerProps.handlePickFiles}
        onOpenPath={state.openPathInFilesPanel}
        showPlusMenu={editShowPlusMenu}
        setShowPlusMenu={setEditShowPlusMenu}
        permissionMode={state.permissionMode}
        onPermissionChange={(m) => state.setPermissionMode(m)}
        isEditingMessage={true}
        onCancelEdit={handleCancelEditMessage}
        rightActions={editModelBadgeNode}
      />
    ) : null;

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
        editingMessageId,
        onStartEditMessage: handleStartEditMessage,
        onCancelEditMessage: handleCancelEditMessage,
        composerElement: editComposerElement,
      },
      generation: {
        onRegenerate: state.handleRegenerate,
        onBranch: state.handleBranch,
        onRetract: state.handleRetract,
        onEditMessageAndResend: state.handleEditMessageAndResend,
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
          ref={rootRef}
          className={styles.chatBody}
          data-testid="chat-body"
          role="region"
          aria-label={state.chatRegionAria}
          aria-busy={state.messagesLoading || undefined}
          data-main-surface={state.mainSurface}
          data-empty-kind={state.emptyKind ?? undefined}
          data-surface-state={surfaceState}
          data-settling={isDocking ? 'true' : undefined}
          data-messages-loading={state.messagesLoading ? 'true' : undefined}
          data-engine-ok={
            state.engineOk === false
              ? 'false'
              : state.engineOk === true
                ? 'true'
                : 'unknown'
          }
          data-approval-mode={state.approvalState.approvalUiPlan.mode}
          {...dragHandlers}
        >
          {isDragOver && (
            <div
              className={styles.dropOverlay}
              data-testid="chat-drop-overlay"
              aria-hidden
            >
              <AppIcon
                name="upload"
                className={styles.dropOverlayIcon}
                size={28}
                aria-hidden
              />
              <span className={styles.dropOverlayText}>
                释放文件以添加为附件
              </span>
            </div>
          )}
          <div
            className={styles.chatDocFlow}
            data-testid="chat-doc-flow"
            data-empty={state.emptyKind != null ? 'true' : undefined}
            aria-busy={state.messagesLoading || undefined}
          >
            {state.mainSurface === 'scheduled' ? (
              <Suspense fallback={null}>
                <ScheduledTasksPanel
                  onBackToChat={() => state.setMainSurface('chat')}
                />
              </Suspense>
            ) : state.mainSurface === 'extensions' ? (
              <Suspense fallback={null}>
                <ExtensionsMainSurface
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
            isSettling={isDocking}
            composerElement={mainComposerElement}
            ribbons={ribbons}
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
            isProcessing={state.isProcessing}
            onStopGeneration={state.composerProps.handleStopGeneration}
            composerLead={
              surfaceState !== 'docked' ? (
                <>
                  <ChatLandingBrand />
                  <ComposerProjectPicker
                    workspaceKey={state.workspaceKey}
                    sessionId={state.activeSessionId}
                    open={state.showProjectPicker}
                    onOpenChange={state.setShowProjectPicker}
                    onProjectChanged={() => state.setProjectTick((n) => n + 1)}
                  />
                </>
              ) : null
            }
          />
        </div>
      </>
    );
  }
);

ChatCard.displayName = 'ChatCard';
