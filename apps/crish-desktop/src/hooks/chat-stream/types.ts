import type { Dispatch, SetStateAction } from 'react';
import type { StreamRequestOptions } from '../../api/chatApi';

export type ChatAttachment = {
  name: string;
  text?: string;
  dataUrl?: string;
  mime?: string;
};

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ChatAttachment[];
  createdAt: number;
}

export type RunNotice = {
  text: string;
  kind?: string | undefined;
  detail?: string | undefined;
  /** 持久条变体：无 TTL 计时，由外部 dismiss 驱动（恢复即消失）；network/恢复类错误专用 */
  persistent?: boolean | undefined;
};

export interface UseChatStreamOptions {
  wsId: string;
  onShowToast: (message: string) => void;
  handleGlobalTabClick: (cardId: string) => void;
  chatInput: string;
  setChatInput: (value: string) => void;
  setSlashMenuOpen: (open: boolean) => void;
  attachments: ChatAttachment[];
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  skillCommandsEnabled: boolean;
  needsKeySetup: boolean;
  needsModelSetup?: boolean;
  setPickerInlineError: (msg: string) => void;
  onOpenModelPicker?: () => void;
}

export interface UseChatStreamResult {
  runNotice: RunNotice | null;
  setRunNotice: Dispatch<SetStateAction<RunNotice | null>>;
  runStreamingAssistant: (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => void;
  handleSendChat: (
    isInsert?: boolean,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => Promise<void>;
  /** 默认 Stop = L2 cooperative_stop */
  handleStopGeneration: () => void;
  /** 强制取消 = L3 force_cancel（UI 二次确认后调用） */
  handleForceCancelGeneration: () => void;
}

export type TerminalToolReason = 'stop' | 'complete' | 'error';

export type TerminalToolPatch = {
  id: string;
  status: 'error';
  output: string;
};
