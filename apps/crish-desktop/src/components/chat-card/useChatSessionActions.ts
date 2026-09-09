import { isBlockedExecutablePath } from '../../api/blockedExecutableExtensions';
import { useCallback, useEffect } from 'react';
import { onUiEvent } from '../../api/uiEvents';
import {
  openFileInPanel,
  resolveWorkspacePath,
  isAbsoluteFsPath,
  readTextFile,
  openPathDefault,
} from '../../api/workspaceFsApi';
import {
  openToolInActiveTab,
  openFileViewerInSession,
} from '../../store/workspace-shell';
import { toast } from '../../services/toast/ToastContext';
import { getCompositionRoot } from '../../app/compositionRoot';
import { getActiveProjectId } from '../../api/projectStore';
import type { ChatAttachment } from '../../hooks/useChatStream';
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
    isInsert?: boolean,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => Promise<void>;
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
  handleEditMessageAndResend: (
    targetMsgId: string,
    newText: string,
    newAttachments: ChatAttachment[]
  ) => Promise<void>;
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

  const openPathInFilesPanel = useCallback((filePath: string) => {
    if (!filePath?.trim()) {
      toast.show('文件不存在');
      return;
    }
    const trimmed = filePath.trim();
    if (/^(note|notebook)(:|$)/i.test(trimmed)) {
      openFileInPanel(filePath);
      return;
    }

    // 安全红线：可执行后缀拦截 SSOT（§4.3）
    if (isBlockedExecutablePath(trimmed)) {
      toast.show('出于安全保护，禁止直接运行可执行文件');
      return;
    }

    // 剥离代码行号/列号锚点（如 src/main.rs:42 或 index.ts:15:3），避免文件系统路径校验失败
    const cleanPath = trimmed.replace(/:\d+(:\d+)?$/, '');

    const isOfficeOrBinary =
      /\.(pptx?|docx?|xlsx?|pdf|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|bmp|ico|tiff?|mp4|mov|webm|mp3|wav)$/i.test(
        cleanPath
      );

    const resolved = resolveWorkspacePath(cleanPath);
    if (resolved) {
      // 项目内文件：在右侧文件管理器打开
      readTextFile(resolved, 1)
        .then(() => {
          openToolInActiveTab('files');
          window.dispatchEvent(
            new CustomEvent('crish-open-file', { detail: { path: resolved } })
          );
          if (isOfficeOrBinary) {
            void openPathDefault(resolved).catch(() => {});
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes('not_found') ||
            msg.includes('Path does not exist') ||
            msg.includes('No such file')
          ) {
            toast.show('文件不存在');
            return;
          }
          // 二进制或非文本文件：在右侧文件管理器打开，同时若是 Office/PPT 则拉起系统关联
          openToolInActiveTab('files');
          window.dispatchEvent(
            new CustomEvent('crish-open-file', { detail: { path: resolved } })
          );
          if (isOfficeOrBinary) {
            void openPathDefault(resolved).catch(() => {});
          }
        });
      return;
    }

    // 项目外文件：检查是否为绝对路径
    if (isAbsoluteFsPath(trimmed)) {
      if (isOfficeOrBinary) {
        // Office/PPT/二进制外部文件：通过系统默认程序打开
        void openPathDefault(trimmed).catch(() => {
          toast.show('文件不存在');
        });
        return;
      }
      // 文本代码类：新建标签页（代码预览）打开
      openFileViewerInSession(trimmed, 'plain');
      return;
    }

    // 无法解析且非绝对路径：回落 openFileInPanel；若返回 null，提示文件不存在
    const host = openFileInPanel(filePath);
    if (!host) {
      toast.show('文件不存在');
    }
  }, []);

  const {
    handleRegenerate,
    handleBranch,
    handleRetract,
    handleEditMessageAndResend,
    handleExportMarkdown,
  } = useChatHandlers({
    wsId,
    activeSessionId,
    activeSessionTitle,
    handleStopGeneration: composerProps.handleStopGeneration,
    setChatInput: composerProps.setChatInput,
    runStreamingAssistant: composerProps.runStreamingAssistant,
    handleSendChat: composerProps.handleSendChat,
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
    handleEditMessageAndResend,
    handleExportMarkdown,
    handleCreateSessionFromEmpty,
    handleProjectChanged,
    handleSendFollowUp,
    handleOpenTerminal,
    handleOpenDiffPanel,
  };
}
