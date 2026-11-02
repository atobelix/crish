import React, { useCallback, useRef } from 'react';
import { useChatInput } from './useChatInput';
import { useSlashMenu } from './useSlashMenu';
import { useChatAttachments } from './useChatAttachments';
import { useChatSend } from './useChatSend';
import { settleStaleSessionProcessingMessages } from '../../hooks/chat-stream/staleSessionHealer';

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
    filteredCommands: rawFilteredCommands,
    loadSkillSlash,
    skillCommandsEnabled,
  } = useSlashMenu({ chatInput });

  // R1（打字解耦，性能 P0-2）：useSlashMenu 的 filteredCommands 是逐渲染
  // .filter() 产物——数组身份恒新，但元素对象出自其 useMemo 命令池、身份
  // 稳定。此处按元素逐项比对：内容未变时复用上一份数组引用，避免这份
  // 恒新引用击穿 ChatComposer 的 memo 与 ChatCard 主输入框的元素 memo。
  const filteredCommandsRef = useRef(rawFilteredCommands);
  if (
    filteredCommandsRef.current.length !== rawFilteredCommands.length ||
    filteredCommandsRef.current.some((cmd, i) => cmd !== rawFilteredCommands[i])
  ) {
    filteredCommandsRef.current = rawFilteredCommands;
  }
  const filteredCommands = filteredCommandsRef.current;

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
    handleSilentStopGeneration: send.handleSilentStopGeneration,
    handleForceCancelGeneration: send.handleForceCancelGeneration,
    onSend,
  };
}
