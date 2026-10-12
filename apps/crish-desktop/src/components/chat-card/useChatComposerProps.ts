import React, { useCallback } from 'react';
import { useChatInput } from './useChatInput';
import { useSlashMenu } from './useSlashMenu';
import { useChatAttachments } from './useChatAttachments';
import { useChatSend } from './useChatSend';
import { settleStaleSessionProcessingMessages } from '../../hooks/chat-stream/helpers';

export interface UseChatComposerPropsOptions {
  wsId: string;
  activeSessionId: string | null;
  needsKeySetup: boolean;
  needsModelSetup: boolean;
  isProcessing: boolean;
  handleGlobalTabClick: (cardId: string) => void;
  setShowModelDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  setPickerInlineError: React.Dispatch<React.SetStateAction<string>>;
}

export function useChatComposerProps(options: UseChatComposerPropsOptions) {
  const {
    activeSessionId,
    wsId,
    needsKeySetup,
    needsModelSetup,
    isProcessing: _isProcessing,
    handleGlobalTabClick,
    setShowModelDropdown,
    setPickerInlineError,
  } = options;

  const {
    chatInput,
    setChatInput,
    isComposing,
    setIsComposing,
    hasUndo,
    handleUndoDraft,
    draftInjectionTick,
  } = useChatInput({ activeSessionId });

  const {
    slashMenuOpen,
    setSlashMenuOpen,
    slashSelectedIndex,
    setSlashSelectedIndex,
    filteredCommands,
    loadSkillSlash,
    skillCommandsEnabled,
  } = useSlashMenu({ chatInput });

  const {
    attachments,
    setAttachments,
    fileInputRef,
    handleFilesSelected,
    handlePathsSelected,
    handleDroppedFiles,
    handlePickFiles,
    handlePasteImage,
    handlePasteFiles,
  } = useChatAttachments({ activeSessionId });

  const send = useChatSend({
    wsId,
    needsKeySetup,
    needsModelSetup,
    handleGlobalTabClick,
    setShowModelDropdown,
    setPickerInlineError,
    chatInput,
    setChatInput,
    setSlashMenuOpen,
    attachments,
    setAttachments,
    skillCommandsEnabled,
    sessionId: activeSessionId,
  });

  const onSend = useCallback(() => {
    const sid = (activeSessionId || '').trim();
    if (sid) {
      // 只要用户手动点击发送，先无条件清扫任何孤儿 processing / queued 状态
      settleStaleSessionProcessingMessages(sid, false);
    }
    void send.handleSendChat(false);
  }, [send.handleSendChat, activeSessionId]);

  return {
    chatInput,
    setChatInput,
    isComposing,
    setIsComposing,
    hasUndo,
    handleUndoDraft,
    draftInjectionTick,
    slashMenuOpen,
    setSlashMenuOpen,
    slashSelectedIndex,
    setSlashSelectedIndex,
    filteredCommands,
    loadSkillSlash,
    attachments,
    setAttachments,
    fileInputRef,
    handleFilesSelected,
    handlePathsSelected,
    handleDroppedFiles,
    handlePickFiles,
    handlePasteImage,
    handlePasteFiles,
    handlePastePath: handlePathsSelected,
    canSend: send.canSend,
    showPlusMenu: send.showPlusMenu,
    setShowPlusMenu: send.setShowPlusMenu,
    runStreamingAssistant: send.runStreamingAssistant,
    handleSendChat: send.handleSendChat,
    handleStopGeneration: send.handleStopGeneration,
    handleForceCancelGeneration: send.handleForceCancelGeneration,
    onSend,
  };
}
