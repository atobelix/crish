import { useState } from 'react';
import {
  useChatStream,
  type ChatAttachment,
} from '../../hooks/chat-stream/useChatStream';

export interface UseChatSendOptions {
  sessionId?: string | null;
  wsId: string;
  needsKeySetup: boolean;
  needsModelSetup: boolean;
  handleGlobalTabClick: (cardId: string) => void;
  setShowModelDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  setPickerInlineError: React.Dispatch<React.SetStateAction<string>>;
  chatInput: string;
  setChatInput: (value: string) => void;
  setSlashMenuOpen: (open: boolean) => void;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  skillCommandsEnabled: boolean;
}

export interface UseChatSendResult {
  canSend: boolean;
  showPlusMenu: boolean;
  setShowPlusMenu: React.Dispatch<React.SetStateAction<boolean>>;
  runStreamingAssistant: ReturnType<
    typeof useChatStream
  >['runStreamingAssistant'];
  handleSendChat: ReturnType<typeof useChatStream>['handleSendChat'];
  handleStopGeneration: ReturnType<
    typeof useChatStream
  >['handleStopGeneration'];
  handleSilentStopGeneration: ReturnType<
    typeof useChatStream
  >['handleSilentStopGeneration'];
  handleForceCancelGeneration: ReturnType<
    typeof useChatStream
  >['handleForceCancelGeneration'];
}

export function useChatSend(options: UseChatSendOptions): UseChatSendResult {
  const [showPlusMenu, setShowPlusMenu] = useState(false);

  const {
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
    handleSilentStopGeneration,
    handleForceCancelGeneration,
  } = useChatStream({
    sessionId: options.sessionId,
    wsId: options.wsId,
    handleGlobalTabClick: options.handleGlobalTabClick,
    chatInput: options.chatInput,
    setChatInput: options.setChatInput,
    setSlashMenuOpen: options.setSlashMenuOpen,
    attachments: options.attachments,
    setAttachments: options.setAttachments,
    skillCommandsEnabled: options.skillCommandsEnabled,
    needsKeySetup: options.needsKeySetup,
    needsModelSetup: options.needsModelSetup,
    setPickerInlineError: options.setPickerInlineError,
    onOpenModelPicker: () => options.setShowModelDropdown(true),
  });

  const canSend = Boolean(
    options.chatInput.trim() || options.attachments.length > 0
  );

  return {
    canSend,
    showPlusMenu,
    setShowPlusMenu,
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
    handleSilentStopGeneration,
    handleForceCancelGeneration,
  };
}
