import { isBlockedExecutablePath } from '../../api/blockedExecutableExtensions';
import { useCallback, useEffect, useRef } from 'react';
import { onScopedUiEvent } from '../../hooks/useLeafUiEvent';
import { useLeafScope } from '../../contexts/LeafScopeContext';
import {
  openFileInPanel,
  resolveWorkspacePath,
  isAbsoluteFsPath,
  readTextFile,
  openPathDefault,
} from '../../api/workspaceFsApi';
import {
  openToolInActiveTab,
  openToolInSession,
  openFileViewerInSession,
} from '../../store/storeAccess';
import { toast } from '../../services/toast/ToastContext';
import { getCompositionRoot } from '../../app/compositionRoot';
import { getActiveProjectId } from '../../api/projectStore';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { useChatHandlers } from './useChatHandlers';

interface ComposerPropsLike {
  handleStopGeneration: () => void;
  handleSilentStopGeneration?: () => void;
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
    panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files',
    targetSessionId?: string | null
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
  const scope = useLeafScope();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const getScopeTarget = useCallback(
    () => ({
      sessionId: activeSessionIdRef.current,
      leafId: scopeRef.current.leafId,
      isActive: scopeRef.current.inLeafScope
        ? scopeRef.current.isActive
        : undefined,
    }),
    []
  );

  const openSidePanel = useCallback(
    (
      panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files',
      targetSessionId?: string | null
    ) => {
      if (targetSessionId) {
        openToolInSession(targetSessionId, panelId);
      } else {
        handleGlobalTabClick(panelId);
      }
    },
    [handleGlobalTabClick]
  );

  const openPathInFilesPanel = useCallback(
    (filePath: string) => {
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
        // 项目内文件：在右侧文件管理器打开（定址优先）
        readTextFile(resolved, 1)
          .then(() => {
            if (activeSessionId) {
              openToolInSession(activeSessionId, 'files');
            } else {
              openToolInActiveTab('files');
            }
            window.dispatchEvent(
              new CustomEvent('crish-open-file', {
                detail: {
                  path: resolved,
                  sessionId: activeSessionId ?? undefined,
                  leafId: scopeRef.current.leafId ?? undefined,
                },
              })
            );
            if (isOfficeOrBinary) {
              void openPathDefault(resolved).catch(() => {
                /* swallow-ok: 文件面板已打开；系统关联拉起失败不打断主路径 */
              });
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
            if (activeSessionId) {
              openToolInSession(activeSessionId, 'files');
            } else {
              openToolInActiveTab('files');
            }
            window.dispatchEvent(
              new CustomEvent('crish-open-file', {
                detail: {
                  path: resolved,
                  sessionId: activeSessionId ?? undefined,
                  leafId: scopeRef.current.leafId ?? undefined,
                },
              })
            );
            if (isOfficeOrBinary) {
              void openPathDefault(resolved).catch(() => {
                /* swallow-ok: 文件面板已打开；系统关联拉起失败不打断主路径 */
              });
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
        if (activeSessionId) {
          openFileViewerInSession(activeSessionId, trimmed, 'plain');
        } else {
          openFileViewerInSession(trimmed, 'plain');
        }
        return;
      }

      // 无法解析且非绝对路径：回落 openFileInPanel；若返回 null，提示文件不存在
      const host = openFileInPanel(filePath);
      if (!host) {
        toast.show('文件不存在');
      }
    },
    [activeSessionId]
  );

  const {
    handleRegenerate,
    handleBranch,
    handleRetract,
    handleEditMessageAndResend,
    handleExportMarkdown,
    handleOpenConversationRewind,
    handleClearSession,
  } = useChatHandlers({
    wsId,
    activeSessionId,
    activeSessionTitle,
    handleStopGeneration: composerProps.handleStopGeneration,
    handleSilentStopGeneration: composerProps.handleSilentStopGeneration,
    setChatInput: composerProps.setChatInput,
    runStreamingAssistant: composerProps.runStreamingAssistant,
    handleSendChat: composerProps.handleSendChat,
    openSidePanel,
    subscribeLifecycleEvents: false,
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

  // 定址化会话级 UI 事件统一订阅（防止跨分屏串扰）
  useEffect(() => {
    return onScopedUiEvent(
      'clear-current-session',
      () => handleClearSession(),
      getScopeTarget
    );
  }, [handleClearSession, getScopeTarget]);

  useEffect(() => {
    return onScopedUiEvent(
      'export-session-md',
      () => handleExportMarkdown(),
      getScopeTarget
    );
  }, [handleExportMarkdown, getScopeTarget]);

  useEffect(() => {
    return onScopedUiEvent(
      'open-conversation-rewind',
      () => handleOpenConversationRewind(),
      getScopeTarget
    );
  }, [handleOpenConversationRewind, getScopeTarget]);

  useEffect(() => {
    return onScopedUiEvent(
      'thinking-title-changed',
      () => {
        setProjectTick((n) => n + 1);
      },
      getScopeTarget
    );
  }, [setProjectTick, getScopeTarget]);

  useEffect(() => {
    return onScopedUiEvent(
      'stop-generation',
      () => {
        composerProps.handleStopGeneration();
      },
      getScopeTarget
    );
  }, [composerProps, getScopeTarget]);

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
