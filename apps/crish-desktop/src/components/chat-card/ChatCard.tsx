import React, {
  Suspense,
  lazy,
  useCallback,
  useRef,
  useState,
  useEffect,
} from 'react';
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
import { anyProviderHasKey } from '../../api/modelsCatalogLive';
import { ChatComposerWrapper } from './ChatComposerWrapper';
import { ToolBackgroundIndicator } from './ToolBackgroundIndicator';
import {
  openSettings,
  patchSession,
  triggerSessionMessageHydrateIfNeeded,
} from '../../store/storeAccess';
import { normalizeMessageAttachments } from '../chat-attachment/AttachmentCard';
import type { SessionMessage } from '../../store/types';
import type { ChatAttachment } from '../../hooks/chat-stream';
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
import { AppIcon } from '@/components/ui/icons';

/**
 * R1（打字解耦，性能 P0-2）：把上游逐渲染新建的回调收敛为身份恒定的
 * trampoline——内部 ref 恒指向最新闭包，调用语义与直调完全一致（无陈旧
 * 闭包风险），但引用永不变化，可安全进入下方分组 useMemo 的依赖数组。
 */
function useLatestCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

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

    const mainModelBadgeNode = React.useMemo(
      () => (
        <ModelBadgePicker
          engineModel={state.engineModel}
          needsModelSetup={state.needsModelSetup}
          needsKeySetup={state.needsKeySetup}
          showModelDropdown={state.showModelDropdown}
          setShowModelDropdown={state.setShowModelDropdown}
        />
      ),
      [
        state.engineModel,
        state.needsModelSetup,
        state.needsKeySetup,
        state.showModelDropdown,
        state.setShowModelDropdown,
      ]
    );

    const editModelBadgeNode = React.useMemo(
      () => (
        <ModelBadgePicker
          engineModel={state.engineModel}
          needsModelSetup={state.needsModelSetup}
          needsKeySetup={state.needsKeySetup}
        />
      ),
      [state.engineModel, state.needsModelSetup, state.needsKeySetup]
    );

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
    // R1（性能 P0-2）：元素 memo 化——依赖逐项取 composerProps 的字段值与
    // 本组件侧字段，任一字段身份不变时元素引用恒定，ChatCard 因流式/审批
    // 等无关状态重渲染时 React 可整棵跳过输入框子树（与 ChatComposer 的
    // React.memo 形成双层防线）；草稿变化时 chatInput 本就是其受控值，
    // 元素随之更新属预期。
    const mainComposerElement = React.useMemo(
      () => (
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
          onPermissionChange={state.setPermissionMode}
          rightActions={mainModelBadgeNode}
        />
      ),
      [
        state.composerProps.chatInput,
        state.composerProps.setChatInput,
        state.composerProps.isComposing,
        state.composerProps.setIsComposing,
        state.composerProps.hasUndo,
        state.composerProps.handleUndoDraft,
        state.composerProps.draftInjectionTick,
        state.composerProps.slashMenuOpen,
        state.composerProps.setSlashMenuOpen,
        state.composerProps.slashSelectedIndex,
        state.composerProps.setSlashSelectedIndex,
        state.composerProps.filteredCommands,
        state.composerProps.loadSkillSlash,
        state.composerProps.attachments,
        state.composerProps.setAttachments,
        state.composerProps.fileInputRef,
        state.composerProps.handleFilesSelected,
        state.composerProps.handlePathsSelected,
        state.composerProps.handleDroppedFiles,
        state.composerProps.handlePickFiles,
        state.composerProps.handlePasteImage,
        state.composerProps.handlePasteFiles,
        state.composerProps.handlePastePath,
        state.composerProps.canSend,
        state.composerProps.showPlusMenu,
        state.composerProps.setShowPlusMenu,
        state.composerProps.runStreamingAssistant,
        state.composerProps.handleSendChat,
        state.composerProps.handleStopGeneration,
        state.composerProps.handleSilentStopGeneration,
        state.composerProps.handleForceCancelGeneration,
        state.composerProps.onSend,
        state.emptyKind,
        isLanding,
        state.openPathInFilesPanel,
        state.isProcessing,
        state.permissionMode,
        state.setPermissionMode,
        mainModelBadgeNode,
      ]
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
        onPermissionChange={state.setPermissionMode}
        isEditingMessage={true}
        onCancelEdit={handleCancelEditMessage}
        rightActions={editModelBadgeNode}
      />
    ) : null;

    // R2-5 B3（P1-12 聚合）：ChatStatusRibbons 专属字段分组 + 派生上移（案甲）——
    // ① localHasKey 上移（模块级调用稳定）② onOpenTerminal/onOpenDiff 闭包上移
    // ③ goalMode 四派生值在此计算；ribbons 对象 useMemo 稳定引用
    // 波1收口：依赖由整个 state 对象收敛为字段级——原 [state] 使每次按键
    // （state 换新引用）都重算本对象并击穿下游 memo，与 R1 的分组稳定化口径对齐。
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
          localHasKey: anyProviderHasKey(),
          onOpenModelSettings: () => openSettings('models'),
          onOpenModelDropdown: () => state.setShowModelDropdown(true),
        },
        goal: {
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
      [
        state.openSidePanel,
        state.diffFiles,
        state.engineHint,
        state.needsKeySetup,
        state.needsModelSetup,
        state.onEmptySurface,
        state.setShowModelDropdown,
        state.goalModeActive,
        state.goalMode,
        state.composerProps,
        state.activeSessionId,
      ]
    );

    // R1（打字解耦，性能 P0-2）：chatStreamProps 六个分组逐组 useMemo 身份
    // 稳定化。此前这里是渲染体内裸对象字面量：ChatCard 每次渲染（含每次
    // 按键）都新建全部分组对象，ChatMessageList 的 memo 与
    // MessageVirtualizer 的分组引用比较恒失效，按键即整列表窗口重算。
    // 现在依赖只取各组的原始字段：草稿（chatInput）不进任何一组的依赖，
    // 按键时六组与容器对象引用全不变，两级 memo 真正命中。
    // 上游逐渲染新建的回调经 useLatestCallback 收敛为恒定引用：
    // handleSendFollowUp 的 useCallback 依赖整个 composerProps 字面量、
    // 生成/审批 handler 链入 chat-stream 与审批执行器内部，均无法在本批
    // 边界内保证身份；trampoline 调用恒走最新闭包，语义不变。
    const stableSendFollowUp = useLatestCallback(state.handleSendFollowUp);
    const stableRegenerate = useLatestCallback(state.handleRegenerate);
    const stableBranch = useLatestCallback(state.handleBranch);
    const stableRetract = useLatestCallback(state.handleRetract);
    const stableEditMessageAndResend = useLatestCallback(
      state.handleEditMessageAndResend
    );
    const stableApprovalAllow = useLatestCallback(
      state.approvalState.handleApprovalAllow
    );
    const stableApprovalDeny = useLatestCallback(
      state.approvalState.handleApprovalDeny
    );
    const stableBatchApprove = useLatestCallback(
      state.approvalState.handleBatchApprove
    );
    const stableBatchDeny = useLatestCallback(
      state.approvalState.handleBatchDeny
    );

    // 消息水合停滞时的重试出口：重新触发当前会话的懒水合（触发器内部
    // 有 in-flight 合并与已水合跳过守卫，重复点击无副作用）
    const handleRetryLoadMessages = useCallback(() => {
      if (state.activeSessionId) {
        triggerSessionMessageHydrateIfNeeded(state.activeSessionId);
      }
    }, [state.activeSessionId]);

    const messagesGroup = React.useMemo<ChatMessageListProps['messages']>(
      () => ({
        messages: state.displayMessages,
        allMessages: state.messages,
        agents: state.agents,
        activeSessionId: state.activeSessionId || '',
        showAllMessages: state.isFiltering,
        messagesLoading: state.messagesLoading,
        messagesLoadStalled: state.messagesLoadStalled,
        onRetryLoadMessages: handleRetryLoadMessages,
      }),
      [
        state.displayMessages,
        state.messages,
        state.agents,
        state.activeSessionId,
        state.isFiltering,
        state.messagesLoading,
        state.messagesLoadStalled,
        handleRetryLoadMessages,
      ]
    );

    const projectPickerGroup = React.useMemo<
      ChatMessageListProps['projectPicker']
    >(
      () => ({
        showProjectPicker: state.showProjectPicker,
        onShowProjectPicker: state.setShowProjectPicker,
        onProjectChanged: state.handleProjectChanged,
      }),
      [
        state.showProjectPicker,
        state.setShowProjectPicker,
        state.handleProjectChanged,
      ]
    );

    // composerElement（就地编辑框）仅在编辑态非空：编辑期间它随编辑草稿
    // 逐渲染更新、本组随之刷新属语义必需（列表行内渲染的正是该元素）；
    // 非编辑态恒为 null，不影响打字路径的稳定命中。
    const composerGroup = React.useMemo<ChatMessageListProps['composer']>(
      () => ({
        onSetChatInput: state.composerProps.setChatInput,
        onSendFollowUp: stableSendFollowUp,
        editingMessageId,
        onStartEditMessage: handleStartEditMessage,
        onCancelEditMessage: handleCancelEditMessage,
        composerElement: editComposerElement,
      }),
      [
        state.composerProps.setChatInput,
        stableSendFollowUp,
        editingMessageId,
        handleStartEditMessage,
        handleCancelEditMessage,
        editComposerElement,
      ]
    );

    const generationGroup = React.useMemo<ChatMessageListProps['generation']>(
      () => ({
        onRegenerate: stableRegenerate,
        onBranch: stableBranch,
        onRetract: stableRetract,
        onEditMessageAndResend: stableEditMessageAndResend,
      }),
      [
        stableRegenerate,
        stableBranch,
        stableRetract,
        stableEditMessageAndResend,
      ]
    );

    const approvalGroup = React.useMemo<ChatMessageListProps['approval']>(
      () => ({
        approvalBusy: state.approvalState.approvalBusy,
        pendingApprovalMsgId: state.approvalState.pendingApprovalMsgId,
        onApprovalAllow: stableApprovalAllow,
        onApprovalDeny: stableApprovalDeny,
        onBatchApprove: stableBatchApprove,
        onBatchDeny: stableBatchDeny,
      }),
      [
        state.approvalState.approvalBusy,
        state.approvalState.pendingApprovalMsgId,
        stableApprovalAllow,
        stableApprovalDeny,
        stableBatchApprove,
        stableBatchDeny,
      ]
    );

    const navigationGroup = React.useMemo<ChatMessageListProps['navigation']>(
      () => ({
        onOpenDiff: state.openDiffInRightPanel,
        onOpenPath: state.openPathInFilesPanel,
        onOpenTerminal: state.handleOpenTerminal,
        onOpenDiffPanel: state.handleOpenDiffPanel,
      }),
      [
        state.openDiffInRightPanel,
        state.openPathInFilesPanel,
        state.handleOpenTerminal,
        state.handleOpenDiffPanel,
      ]
    );

    // 有消息枝才进 stream 槽；空态 / 定时任务面保持现逻辑，不被槽吞掉。
    // 容器对象一并 memo 化：SlotOutlet 的 context 引用随之稳定。
    const chatStreamProps = React.useMemo<ChatMessageListProps>(
      () => ({
        messages: messagesGroup,
        projectPicker: projectPickerGroup,
        composer: composerGroup,
        generation: generationGroup,
        approval: approvalGroup,
        navigation: navigationGroup,
      }),
      [
        messagesGroup,
        projectPickerGroup,
        composerGroup,
        generationGroup,
        approvalGroup,
        navigationGroup,
      ]
    );

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
          <ToolBackgroundIndicator sessionId={state.activeSessionId} />
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
