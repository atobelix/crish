import React, { useCallback } from 'react';
import { useChatInput } from './useChatInput';
import { useSlashMenu } from './useSlashMenu';
import { useChatAttachments } from './useChatAttachments';
import { useChatQueue } from './useChatQueue';
import { useChatSend } from './useChatSend';

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

  const { chatInput, setChatInput, isComposing, setIsComposing } =
    useChatInput({ activeSessionId });

  const { slashMenuOpen, setSlashMenuOpen, slashSelectedIndex,
    setSlashSelectedIndex, filteredCommands, loadSkillSlash,
    skillCommandsEnabled } = useSlashMenu({ chatInput });

  const { attachments, setAttachments, fileInputRef,
    handleFilesSelected, handlePasteImage } =
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
    if (queueMode && isProcessing) {
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
    slashMenuOpen, setSlashMenuOpen, slashSelectedIndex,
    setSlashSelectedIndex, filteredCommands, loadSkillSlash,
    attachments, setAttachments, fileInputRef, handleFilesSelected,
    handlePasteImage,
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
