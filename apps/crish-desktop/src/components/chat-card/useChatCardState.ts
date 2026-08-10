import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useReducer,
} from 'react';
import {
  useLayoutStore,
  useSessionField,
  selectActiveSessionId,
} from '../../api/store-access/componentAccess';
import type { FileDiff, SessionState } from '../../store/types';
import {
  useTerminalField,
  usePermissionField,
  useSettingsField,
  selectDiffFiles,
  selectAppSettings,
  selectPermissionMode,
  selectPlanModeEnabled,
  selectPlanApproved,
} from '../../store/storeAccess';
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

type SessionStoreStateShape = {
  activeSessionId: string;
  sessionsById: Record<string, SessionState | undefined>;
};

/**
 * 会话级订阅短路（T4.2，R-05，08-detail 4.1-②）。
 *
 * 任何 session 域变更（工具快照/审批/subagent 事件 immer patch）都会触发
 * zustand 订阅——普通 selector 路径每次变更都要重求值 + Object.is 比较。
 * 本 hook 用 vanilla subscribe((state, prev) => ...) 在监听器层短路：
 * 本会话引用未变（immer 结构共享保证未变会话引用不变）且 activeSessionId
 * 未变 → 不重求值、不触发渲染。
 *
 * 语义边界：短路仅省求值与渲染，不改变渲染结果（依赖「activeSessionId
 * 恒与渲染中的 ChatCard 一致」的既有假设；多会话多 Tab 现状已在 R-05
 * 判定为浪费面，短路后视觉无变化——07 方案风险 7）。
 */
export function useScopedSessionField<T>(
  resolveSid: (state: SessionStoreStateShape) => string,
  selector: (session: SessionState | undefined) => T
): T {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const resolveSidRef = useRef(resolveSid);
  resolveSidRef.current = resolveSid;
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{
    sid: string;
    session: SessionState | undefined;
    value: T;
  } | null>(null);

  useEffect(() => {
    return useLayoutStore.subscribe((state, prev) => {
      const st = state as SessionStoreStateShape;
      const sid = resolveSidRef.current(st);
      const prevSid = resolveSidRef.current(prev as SessionStoreStateShape);
      const session = st.sessionsById[sid];
      const cached = cacheRef.current;
      // 会话级订阅短路：本会话引用未变 + activeSessionId 未变 → 直接短路
      if (
        cached &&
        cached.sid === prevSid &&
        cached.session === session &&
        (prev as SessionStoreStateShape).activeSessionId === st.activeSessionId
      ) {
        return;
      }
      cacheRef.current = { sid, session, value: selectorRef.current(session) };
      forceUpdate();
    });
  }, []);

  // 渲染期求值（首次挂载 / forceUpdate 后）：缓存命中直接复用
  const st = useLayoutStore.getState() as SessionStoreStateShape;
  const sid = resolveSid(st);
  const session = st.sessionsById[sid];
  const cached = cacheRef.current;
  if (!cached || cached.sid !== sid || cached.session !== session) {
    cacheRef.current = { sid, session, value: selector(session) };
  }
  return cacheRef.current!.value;
}

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
  // T4.2（R-05）：会话级订阅短路——非活跃会话变更不再触发本会话 7 个
  // selector 重求值；sid 解析（prop ?? activeSessionId）经 ref 桥接
  const resolveSessionId = useCallback(
    (s: SessionStoreStateShape) => sessionIdProp ?? s.activeSessionId ?? '',
    [sessionIdProp]
  );
  const messages = useScopedSessionField(
    resolveSessionId,
    useCallback(
      (session) => session?.messages || EMPTY_ARRAY,
      []
    )
  );
  const agents = useScopedSessionField(
    resolveSessionId,
    useCallback(
      (session) => session?.agents || EMPTY_ARRAY,
      []
    )
  );
  const goalMode = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.goalMode, [])
  );
  const hydratedFromEngine = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.hydratedFromEngine, [])
  );
  const engineCursor = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.engineCursor, [])
  );
  const engineLastRunId = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.engineLastRunId, [])
  );
  const activeSessionTitle = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.title, [])
  );

  const appSettings = useSettingsField(selectAppSettings);
  const diffFiles = useTerminalField(selectDiffFiles);

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

  const permissionMode = usePermissionField(selectPermissionMode);
  const setPermissionMode = usePermissionField((s) => s.setPermissionMode);
  const planModeEnabled = usePermissionField(selectPlanModeEnabled);
  const planApproved = usePermissionField(selectPlanApproved);
  const setPlanApproved = usePermissionField((s) => s.setPlanApproved);
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

  const { handleStopGeneration, handleSendChat } = composerProps;

  useEffect(() => {
    return onUiEvent('stop-generation', () => {
      handleStopGeneration();
    });
  }, [handleStopGeneration]);

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
      void handleSendChat(false, prompt);
    },
    [handleSendChat]
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
