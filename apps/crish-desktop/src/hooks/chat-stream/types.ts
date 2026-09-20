import type { Dispatch, SetStateAction } from 'react';
import type { StreamRequestOptions } from '../../api/chatApi';

export interface ImageMeta {
  width: number;
  height: number;
  size: number;
  mime: string;
}

export type ChatAttachment = {
  id?: string;
  name: string;
  path?: string;
  text?: string;
  dataUrl?: string;
  thumbnailUrl?: string;
  mime?: string;
  isImage?: boolean;
  imageMeta?: ImageMeta;
  status?: 'parsing' | 'ready' | 'error';
  progress?: number;
  annotation?: {
    id: string;
    selectedText: string;
    comment: string;
  };
};

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ChatAttachment[];
  createdAt: number;
}

export interface UseChatStreamOptions {
  wsId: string;
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
  /**
   * 软收口固化的真实挂钟耗时（毫秒）。
   * 仅当工具缺失 `durationMs`（后端未回报）且存在 `startedAt` 时才产出，
   * 用于锚定终态「工作 xx 时间」的物理终点，杜绝耗时归零假象。
   */
  durationMs?: number;
};
