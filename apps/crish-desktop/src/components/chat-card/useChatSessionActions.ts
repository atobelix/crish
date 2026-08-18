import { useCallback, useEffect } from 'react';
import { onUiEvent } from '../../api/uiEvents';
import { openFileInPanel } from '../../api/workspaceFsApi';
import { getCompositionRoot } from '../../app/compositionRoot';
import { getActiveProjectId } from '../../api/projectStore';
import { useChatHandlers } from './useChatHandlers';

interface ComposerPropsLike {
  handleStopGeneration: () => void;
  setChatInput: (textOrFn: React.SetStateAction<string>) => void;
  runStreamingAssistant: (
    text: string,
    msgId: string,
    sessionIdOverride?: string,
    streamOptions?: { clientMessageId?: string }
  ) => void;
  handleSendChat: (
    queued: boolean,
    prompt?: string
  ) => void;
}

export interface UseChatSessionActionsOptions {
  wsId: string;
  activeSessionId: string | null;
  activeSessionTitle: string | undefined;
  handleGlobalTabClick: (cardId: string) => void;
  setProjectTick: React.Dispatch<React.SetStateAction<number>>;
  composerProps: ComposerPropsLike;
}

export interface UseChatSessionActionsResult {
  openSidePanel: (
    panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files'
  ) => void;
  openPathInFilesPanel: (filePath: string) => void;
  handleRegenerate: (userText: string, assistantMsgId: string) => void;
  handleBranch: () => void;
  handleRetract: () => Promise<void>;
  handleExportMarkdown: () => void;
  handleCreateSessionFromEmpty: () => void;
  handleProjectChanged: () => void;
  handleSendFollowUp: (prompt: string) => void;
  handleOpenTerminal: () => void;
  handleOpenDiffPanel: () => void;
}

export function useChatSessionActions({
  wsId,
  activeSessionId,
  activeSessionTitle,
  handleGlobalTabClick,
  setProjectTick,
  composerProps,
}: UseChatSessionActionsOptions): UseChatSessionActionsResult {
  const openSidePanel = useCallback(
    (panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files') => {
      handleGlobalTabClick(panelId);
    },
    [handleGlobalTabClick]
  );

  const openPathInFilesPanel = useCallback(
    (filePath: string) => {
      openSidePanel('files');
      openFileInPanel(filePath);
    },
    [openSidePanel]
  );

  const {
    handleRegenerate,
    handleBranch,
    handleRetract,
    handleExportMarkdown,
  } = useChatHandlers({
    wsId,
    activeSessionId,
    activeSessionTitle,
    handleStopGeneration: composerProps.handleStopGeneration,
    setChatInput: composerProps.setChatInput,
    runStreamingAssistant: composerProps.runStreamingAssistant,
  });

  const handleCreateSessionFromEmpty = useCallback(() => {
    getCompositionRoot().shell.openNewDraftTab(
      getActiveProjectId() || undefined
    );
  }, []);

  const handleProjectChanged = useCallback(() => {
    setProjectTick((n) => n + 1);
  }, [setProjectTick]);

  const handleSendFollowUp = useCallback(
    (prompt: string) => {
      void composerProps.handleSendChat(false, prompt);
    },
    [composerProps]
  );

  const handleOpenTerminal = useCallback(() => {
    openSidePanel('terminal');
  }, [openSidePanel]);

  const handleOpenDiffPanel = useCallback(() => {
    openSidePanel('diff');
  }, [openSidePanel]);

  // stop-generation UI 事件桥接（原 useChatCardState 中的 useEffect）
  useEffect(() => {
    return onUiEvent('stop-generation', () => {
      composerProps.handleStopGeneration();
    });
  }, [composerProps]);

  return {
    openSidePanel,
    openPathInFilesPanel,
    handleRegenerate,
    handleBranch,
    handleRetract,
    handleExportMarkdown,
    handleCreateSessionFromEmpty,
    handleProjectChanged,
    handleSendFollowUp,
    handleOpenTerminal,
    handleOpenDiffPanel,
  };
}
