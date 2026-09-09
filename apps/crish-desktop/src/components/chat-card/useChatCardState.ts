import { useChatSessionMeta } from './useChatSessionMeta';
import { useChatProjectPicker } from './useChatProjectPicker';
import { useChatModelPicker } from './useChatModelPicker';
import { useChatMessages } from './useChatMessages';
import { useChatApproval } from './useChatApproval';
import { useChatDiffPanel } from './useChatDiffPanel';
import { useChatSessionActions } from './useChatSessionActions';
import { useChatComposerProps } from './useChatComposerProps';

export { useScopedSessionField } from './useScopedSessionField';
export type { SessionStoreStateShape } from './useScopedSessionField';

export interface UseChatCardStateOptions {
  wsId: string;
  handleGlobalTabClick: (cardId: string) => void;
  /** 渲染真源；缺省则用全局 activeSessionId */
  sessionId?: string | null;
}

export function useChatCardState({
  wsId,
  handleGlobalTabClick,
  sessionId: sessionIdProp,
}: UseChatCardStateOptions) {
  // 1. 会话元数据域
  const sessionMeta = useChatSessionMeta({ sessionIdProp });

  // 2. 项目选择器与消息过滤域
  const projectPicker = useChatProjectPicker({
    activeSessionId: sessionMeta.activeSessionId,
  });

  // 3. 模型选择与 provider 域
  const modelPicker = useChatModelPicker({
    projectTick: projectPicker.projectTick,
  });

  // 4. 消息列表与空态域
  const chatMessages = useChatMessages({
    resolveSessionId: sessionMeta.resolveSessionId,
    activeSessionId: sessionMeta.activeSessionId,
    localMsgFilter: projectPicker.localMsgFilter,
    mainSurface: projectPicker.mainSurface,
  });

  // 5. 权限与审批域
  const approval = useChatApproval({
    activeSessionId: sessionMeta.activeSessionId,
    messages: chatMessages.messages,
    agents: chatMessages.agents,
  });

  // 6. Diff 面板域
  const diffPanel = useChatDiffPanel({
    messages: chatMessages.messages,
    handleGlobalTabClick,
  });

  // 7. Composer 域（另一个 Agent 负责拆分，此处仅装配）
  const composerProps = useChatComposerProps({
    wsId,
    activeSessionId: sessionMeta.activeSessionId,
    needsKeySetup: modelPicker.needsKeySetup,
    needsModelSetup: modelPicker.needsModelSetup,
    isProcessing: chatMessages.isProcessing,
    handleGlobalTabClick,
    setShowModelDropdown: modelPicker.setShowModelDropdown,
    setPickerInlineError: modelPicker.setPickerInlineError,
  });

  // 8. 会话操作域
  const sessionActions = useChatSessionActions({
    wsId,
    activeSessionId: sessionMeta.activeSessionId,
    activeSessionTitle: sessionMeta.activeSessionTitle,
    handleGlobalTabClick,
    setProjectTick: projectPicker.setProjectTick,
    composerProps,
  });

  // engineOk 派生（engineHint == null ? null : engineHint.ok）
  const engineOk: boolean | null =
    modelPicker.engineHint == null ? null : modelPicker.engineHint.ok;

  return {
    activeSessionId: sessionMeta.activeSessionId,
    activeSessionTitle: sessionMeta.activeSessionTitle,
    workspaceKey: sessionMeta.workspaceKey,
    messages: chatMessages.messages,
    agents: chatMessages.agents,
    goalMode: sessionMeta.goalMode,
    goalModeActive: sessionMeta.goalModeActive,
    diffFiles: diffPanel.diffFiles,
    showProjectPicker: projectPicker.showProjectPicker,
    setShowProjectPicker: projectPicker.setShowProjectPicker,
    mainSurface: projectPicker.mainSurface,
    setMainSurface: projectPicker.setMainSurface,
    projectTick: projectPicker.projectTick,
    setProjectTick: projectPicker.setProjectTick,
    localMsgFilter: projectPicker.localMsgFilter,
    setLocalMsgFilter: projectPicker.setLocalMsgFilter,
    showMsgFilter: projectPicker.showMsgFilter,
    setShowMsgFilter: projectPicker.setShowMsgFilter,
    msgFilterInputRef: projectPicker.msgFilterInputRef,
    engineModel: modelPicker.engineModel,
    activeProfileId: modelPicker.activeProfileId,
    showModelDropdown: modelPicker.showModelDropdown,
    setShowModelDropdown: modelPicker.setShowModelDropdown,
    engineHint: modelPicker.engineHint,
    needsKeySetup: modelPicker.needsKeySetup,
    needsModelSetup: modelPicker.needsModelSetup,
    showModelPicker: modelPicker.showModelPicker,
    displayMessages: chatMessages.displayMessages,
    messagesLoading: chatMessages.messagesLoading,
    emptyKind: chatMessages.emptyKind,
    onEmptySurface: chatMessages.onEmptySurface,
    chatRegionAria: chatMessages.chatRegionAria,
    permissionMode: approval.permissionMode,
    setPermissionMode: approval.setPermissionMode,
    planApproved: approval.planApproved,
    setPlanApproved: approval.setPlanApproved,
    inPlanMode: approval.inPlanMode,
    openSidePanel: sessionActions.openSidePanel,
    isProcessing: chatMessages.isProcessing,
    openPathInFilesPanel: sessionActions.openPathInFilesPanel,
    composerProps,
    handleRegenerate: sessionActions.handleRegenerate,
    handleBranch: sessionActions.handleBranch,
    handleRetract: sessionActions.handleRetract,
    handleEditMessageAndResend: sessionActions.handleEditMessageAndResend,
    handleExportMarkdown: sessionActions.handleExportMarkdown,
    approvalState: approval.approvalState,
    openDiffInRightPanel: diffPanel.openDiffInRightPanel,
    isFiltering: projectPicker.isFiltering,
    firstRunOpen: sessionMeta.firstRunOpen,
    engineOk,
    handleCreateSessionFromEmpty:
      sessionActions.handleCreateSessionFromEmpty,
    handleProjectChanged: sessionActions.handleProjectChanged,
    handleSendFollowUp: sessionActions.handleSendFollowUp,
    handleOpenTerminal: sessionActions.handleOpenTerminal,
    handleOpenDiffPanel: sessionActions.handleOpenDiffPanel,
  };
}

export type ChatCardState = ReturnType<typeof useChatCardState>;
