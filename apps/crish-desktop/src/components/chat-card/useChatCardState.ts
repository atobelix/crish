import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { useLayoutStore, type FileDiff } from '../../store/layoutStore';
import {
  selectActiveSessionId,
  useSessionField,
} from '../../store/sessionStore';
import {
  openSettings,
  patchSession,
  clearSessionMessages,
  setActiveDiffSource as setActiveDiffSourceAccess,
} from '../../api/storeAccess';
import { getActiveProjectId } from '../../api/projectStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { isDemoMode } from '../../api/appMode';
import { getProviderSetupStatus } from '../../api/providerProfiles';
import { openFileInPanel } from '../../api/workspaceFsApi';
import { onUiEvent } from '../../api/uiEvents';
import { isFirstRunOverlayOpen } from '../firstRunOverlayFlag';

import { useModelSelection } from './ChatHeaderControls';
import { useChatScrollAnchor } from './ChatScrollAnchor';
import { useChatComposerProps } from './useChatComposerProps';
import { useChatApprovalHandlers } from './useChatApprovalHandlers';
import { useChatEmptyKind } from './useChatEmptyKind';
import { useChatHandlers } from './useChatHandlers';

const EMPTY_ARRAY: never[] = [];

export interface UseChatCardStateOptions {
  wsId: string;
  onShowToast: ShowToastFn;
  handleGlobalTabClick: (cardId: string) => void;
  /** 渲染真源；缺省则用全局 activeSessionId */
  sessionId?: string | null;
}

export function useChatCardState({
  wsId,
  onShowToast,
  handleGlobalTabClick,
  sessionId: sessionIdProp,
}: UseChatCardStateOptions) {
  // Resolve session id inside the selector so prop changes rebind correctly
  // and store activeSessionId updates still notify when prop is absent.
  const activeSessionId = useSessionField(
    useCallback(
      (s) => sessionIdProp ?? selectActiveSessionId(s),
      [sessionIdProp]
    )
  );
  const messages = useSessionField(
    useCallback(
      (s) => {
        const sid = (sessionIdProp ?? selectActiveSessionId(s)) || '';
        return s.sessionsById[sid]?.messages || EMPTY_ARRAY;
      },
      [sessionIdProp]
    )
  );
  const agents = useSessionField(
    useCallback(
      (s) => {
        const sid = (sessionIdProp ?? selectActiveSessionId(s)) || '';
        return s.sessionsById[sid]?.agents || EMPTY_ARRAY;
      },
      [sessionIdProp]
    )
  );
  const goalMode = useSessionField(
    useCallback(
      (s) => {
        const sid = (sessionIdProp ?? selectActiveSessionId(s)) || '';
        return s.sessionsById[sid]?.goalMode;
      },
      [sessionIdProp]
    )
  );
  const hydratedFromEngine = useSessionField(
    useCallback(
      (s) => {
        const sid = (sessionIdProp ?? selectActiveSessionId(s)) || '';
        return s.sessionsById[sid]?.hydratedFromEngine;
      },
      [sessionIdProp]
    )
  );
  const engineCursor = useSessionField(
    useCallback(
      (s) => {
        const sid = (sessionIdProp ?? selectActiveSessionId(s)) || '';
        return s.sessionsById[sid]?.engineCursor;
      },
      [sessionIdProp]
    )
  );
  const engineLastRunId = useSessionField(
    useCallback(
      (s) => {
        const sid = (sessionIdProp ?? selectActiveSessionId(s)) || '';
        return s.sessionsById[sid]?.engineLastRunId;
      },
      [sessionIdProp]
    )
  );
  const activeSessionTitle = useSessionField(
    useCallback(
      (s) => {
        const sid = (sessionIdProp ?? selectActiveSessionId(s)) || '';
        return s.sessionsById[sid]?.title;
      },
      [sessionIdProp]
    )
  );

  const appSettings = useLayoutStore((s) => s.appSettings);
  const diffFiles = useLayoutStore((s) => s.diffFiles);

  const [pickerInlineError, setPickerInlineError] = useState('');
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const mainSurface = useLayoutStore((s) => s.chatMainSurface || 'chat');
  const setMainSurface = useLayoutStore((s) => s.setChatMainSurface);
  const [projectTick, setProjectTick] = useState(0);
  const [localMsgFilter, setLocalMsgFilter] = useState('');
  const [showMsgFilter, setShowMsgFilter] = useState(false);
  const msgFilterInputRef = useRef<HTMLInputElement>(null);

  const {
    engineModel,
    activeProfileId,
    showModelDropdown,
    setShowModelDropdown,
    engineHint,
  } = useModelSelection(appSettings ?? undefined, projectTick);

  useEffect(() => {
    const offs = [
      onUiEvent('project-changed', () => setProjectTick((n) => n + 1)),
      onUiEvent('open-project-picker', () => setShowProjectPicker(true)),
      onUiEvent('open-scheduled', () => setMainSurface('scheduled')),
      onUiEvent('open-chat', () => setMainSurface('chat')),
      onUiEvent('toggle-msg-filter', () => {
        setShowMsgFilter((v) => {
          const next = !v;
          if (!next) setLocalMsgFilter('');
          return next;
        });
      }),
      onUiEvent('focus-composer', () => {
        setMainSurface('chat');
        window.requestAnimationFrame(() => {
          const el =
            document.querySelector<HTMLTextAreaElement>(
              'textarea[data-chat-composer], .chat-composer textarea, .composer-textarea'
            ) ||
            document.querySelector<HTMLTextAreaElement>(
              '.chat-footer textarea'
            );
          el?.focus();
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [setMainSurface]);

  const prevActiveSessionRef = useRef(activeSessionId);
  useEffect(() => {
    if (prevActiveSessionRef.current !== activeSessionId) {
      prevActiveSessionRef.current = activeSessionId;
      setMainSurface('chat');
    }
  }, [activeSessionId, setMainSurface]);

  const setupStatus = getProviderSetupStatus({
    ...(engineHint?.ok !== undefined ? { engineOk: engineHint.ok } : {}),
    ...(engineHint?.hasApiKey !== undefined
      ? { engineHasApiKey: engineHint.hasApiKey }
      : {}),
    engineModel: engineHint?.model ?? engineModel,
  });
  const needsKeySetup = setupStatus.needsKeySetup;
  const needsModelSetup = setupStatus.needsModelSetup;
  const showModelPicker = setupStatus.showModelPicker;
  const goalModeActive = Boolean(goalMode?.active);

  useEffect(() => {
    setLocalMsgFilter('');
    setShowMsgFilter(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (showMsgFilter) {
      window.requestAnimationFrame(() => msgFilterInputRef.current?.focus());
    }
  }, [showMsgFilter]);

  const {
    displayMessages,
    messagesLoading,
    emptyKind,
    onEmptySurface,
    chatRegionAria,
  } = useChatEmptyKind({
    activeSessionId,
    messages,
    localMsgFilter,
    mainSurface,
    hydratedFromEngine,
    engineCursor,
    engineLastRunId,
  });

  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const openSidePanel = useCallback(
    (panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files') => {
      handleGlobalTabClick(panelId);
    },
    [handleGlobalTabClick]
  );

  const isProcessing = messages.some((m) => m.status === 'processing');

  const openPathInFilesPanel = useCallback(
    (filePath: string) => {
      openSidePanel('files');
      openFileInPanel(filePath);
    },
    [openSidePanel]
  );

  const { chatFlowRef, showScrollToBottom, scrollToBottom } =
    useChatScrollAnchor({
      messages,
      isProcessing,
      activeSessionId,
      onOpenPathInFilesPanel: openPathInFilesPanel,
    });

  const composerProps = useChatComposerProps({
    wsId,
    activeSessionId,
    needsKeySetup,
    needsModelSetup,
    isProcessing,
    onShowToast,
    handleGlobalTabClick,
    setShowModelDropdown,
    setPickerInlineError,
  });

  const {
    handleWithdraw,
    handleRegenerate,
    handleBranch,
    handleExportMarkdown,
    pendingWithdraw,
    confirmWithdraw,
    cancelWithdraw,
  } = useChatHandlers({
    wsId,
    activeSessionId,
    activeSessionTitle,
    onShowToast,
    handleStopGeneration: composerProps.handleStopGeneration,
    setChatInput: composerProps.setChatInput,
    runStreamingAssistant: composerProps.runStreamingAssistant,
  });

  const approvalState = useChatApprovalHandlers({
    activeSessionId,
    messages,
    agents,
    onShowToast,
  });

  useEffect(() => {
    if (pickerInlineError) {
      onShowToast(pickerInlineError);
      setPickerInlineError('');
    }
  }, [pickerInlineError, onShowToast]);

  useEffect(() => {
    return onUiEvent('stop-generation', () => {
      composerProps.handleStopGeneration();
    });
  }, [composerProps.handleStopGeneration]);

  const openDiffInRightPanel = useCallback(
    (diff: FileDiff) => {
      setActiveDiffSourceAccess(diff);
      handleGlobalTabClick('diff');
    },
    [handleGlobalTabClick]
  );

  const isFiltering = Boolean(localMsgFilter.trim());
  const firstRunOpen = !isDemoMode() && isFirstRunOverlayOpen();
  const engineOk: boolean | null = engineHint == null ? null : engineHint.ok;

  const handleCreateSessionFromEmpty = useCallback(() => {
    // 必须走 shell，否则 ChatCardBound 仍绑定旧 sessionId；不 wipe 其它顶栏 tab
    getCompositionRoot().shell.openNewDraftTab(
      getActiveProjectId() || undefined
    );
  }, []);

  // Stable callbacks for ChatMessageList props (avoid inline arrows breaking React.memo)
  const handleProjectChanged = useCallback(() => {
    setProjectTick((n) => n + 1);
  }, []);

  const handleSendFollowUp = useCallback(
    (prompt: string) => {
      void composerProps.handleSendChat(false, prompt);
    },
    [composerProps.handleSendChat]
  );

  const handleOpenTerminal = useCallback(() => {
    openSidePanel('terminal');
  }, [openSidePanel]);

  const handleOpenDiffPanel = useCallback(() => {
    openSidePanel('diff');
  }, [openSidePanel]);

  return {
    activeSessionId,
    activeSessionTitle,
    messages,
    agents,
    goalMode,
    goalModeActive,
    diffFiles,
    showProjectPicker,
    setShowProjectPicker,
    mainSurface,
    setMainSurface,
    projectTick,
    setProjectTick,
    localMsgFilter,
    setLocalMsgFilter,
    showMsgFilter,
    setShowMsgFilter,
    msgFilterInputRef,
    engineModel,
    activeProfileId,
    showModelDropdown,
    setShowModelDropdown,
    engineHint,
    needsKeySetup,
    needsModelSetup,
    showModelPicker,
    displayMessages,
    messagesLoading,
    emptyKind,
    onEmptySurface,
    chatRegionAria,
    permissionMode,
    setPermissionMode,
    planApproved,
    setPlanApproved,
    inPlanMode,
    openSidePanel,
    isProcessing,
    openPathInFilesPanel,
    chatFlowRef,
    showScrollToBottom,
    scrollToBottom,
    composerProps,
    handleWithdraw,
    handleRegenerate,
    handleBranch,
    handleExportMarkdown,
    pendingWithdraw,
    confirmWithdraw,
    cancelWithdraw,
    approvalState,
    openDiffInRightPanel,
    isFiltering,
    firstRunOpen,
    engineOk,
    handleCreateSessionFromEmpty,
    handleProjectChanged,
    handleSendFollowUp,
    handleOpenTerminal,
    handleOpenDiffPanel,
    openSettings,
    patchSession,
    clearSessionMessages,
  };
}

export type ChatCardState = ReturnType<typeof useChatCardState>;
