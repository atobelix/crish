import React, { useCallback } from 'react';
import { useChatInput } from './useChatInput';
import { useSlashMenu } from './useSlashMenu';
import { useChatAttachments } from './useChatAttachments';
import { useChatQueue } from './useChatQueue';
import { useChatSend } from './useChatSend';
import { settleStaleSessionProcessingMessages } from '../../hooks/chat-stream/helpers';
import { useStreamingStore } from '../../store/streamingStore';

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
  const { activeSessionId, wsId, needsKeySetup, needsModelSetup, isProcessing,
    handleGlobalTabClick, setShowModelDropdown, setPickerInlineError } = options;

  const { chatInput, setChatInput, isComposing, setIsComposing,
    hasUndo, handleUndoDraft, draftInjectionTick } =
    useChatInput({ activeSessionId });

  const { slashMenuOpen, setSlashMenuOpen, slashSelectedIndex,
    setSlashSelectedIndex, filteredCommands, loadSkillSlash,
    skillCommandsEnabled } = useSlashMenu({ chatInput });

  const { attachments, setAttachments, fileInputRef,
    handleFilesSelected, handlePathsSelected, handleDroppedFiles, handlePickFiles,
    handlePasteImage, handlePasteFiles } =
    useChatAttachments({ activeSessionId });

  const send = useChatSend({
    wsId, needsKeySetup, needsModelSetup, handleGlobalTabClick,
    setShowModelDropdown, setPickerInlineError,
    chatInput, setChatInput, setSlashMenuOpen, attachments, setAttachments,
    skillCommandsEnabled,
  });

  const { queueMode, queuedMessages, enqueueMessage, deleteQueuedMessage,
    editQueuedMessage, sendQueuedMessageNow } = useChatQueue({
    activeSessionId, setChatInput, setAttachments,
    handleSendChat: send.handleSendChat, isProcessing,
  });

  const onSend = useCallback(() => {
    const sid = (activeSessionId || '').trim();
    if (sid) {
      // 只要用户手动点击发送，先无条件清扫任何孤儿 processing / queued 状态
      settleStaleSessionProcessingMessages(sid, false);
    }
    // 检查是否有真实底层流在进行：若无活动流缓冲，绝不排队
    const hasLiveStream = sid
      ? Object.keys(useStreamingStore.getState().byKey).some((k) => k.startsWith(`${sid}::`))
      : false;

    if (queueMode && isProcessing && hasLiveStream) {
      const text = chatInput;
      enqueueMessage(text, attachments);
      void import('../../app/compositionRoot').then(
        ({ getCompositionRoot }) => {
          void getCompositionRoot().runControl.followUp({
            sessionId: activeSessionId || null,
            text: text.trim(),
            reason: 'ui-composer-queue-mode',
          });
        }
      );
    } else {
      void send.handleSendChat(false);
    }
  }, [queueMode, isProcessing, chatInput, attachments,
    enqueueMessage, send.handleSendChat, activeSessionId]);

  return {
    chatInput, setChatInput, isComposing, setIsComposing,
    hasUndo, handleUndoDraft, draftInjectionTick,
    slashMenuOpen, setSlashMenuOpen, slashSelectedIndex,
    setSlashSelectedIndex, filteredCommands, loadSkillSlash,
    attachments, setAttachments, fileInputRef, handleFilesSelected,
    handlePathsSelected, handleDroppedFiles, handlePickFiles,
    handlePasteImage, handlePasteFiles,
    canSend: send.canSend, showPlusMenu: send.showPlusMenu,
    setShowPlusMenu: send.setShowPlusMenu,
    runNotice: send.runNotice, setRunNotice: send.setRunNotice,
    runStreamingAssistant: send.runStreamingAssistant,
    handleSendChat: send.handleSendChat,
    handleStopGeneration: send.handleStopGeneration,
    handleForceCancelGeneration: send.handleForceCancelGeneration,
    onSend, queueMode, queuedMessages, enqueueMessage,
    deleteQueuedMessage, editQueuedMessage, sendQueuedMessageNow,
  };
}
