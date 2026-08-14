/**
 * ChatSendToNoteEntry — 聊天气泡/完成态「发送到笔记」入口（B-05）
 *
 * - 仅 completed 渲染（非 completed 返回 null，不占位）
 * - 经 SendToNoteButton → bridges/send-to-note 显式 Intent
 * - 稳定 intentId：`stn-chat:<messageId>`（幂等不双插）
 * - **≠** EL-08 关闭；**≠** 产品链满关（无活动笔记选择器 / 跨进程幂等落盘等仍缺）
 *
 * agent-card 与主 chat 共用 ChatAssistantMessageRow → MessageActions 挂载本组件。
 */

import React, { useCallback } from 'react';
import { SendToNoteButton } from '../note-paper/SendToNoteButton';
import type {
  NoteTransport,
  SendToNoteResult,
  SendToNoteSink,
} from '../../bridges/send-to-note';
import {
  buildChatSendToNoteIntentId,
  DEFAULT_CHAT_NOTE_DOC_ID,
  shouldShowSendToNoteEntry,
} from './sendToNoteMount';

export type ChatSendToNoteEntryProps = {
  messageId: string;
  /** 消息流状态；仅 completed 挂载 */
  status: string | null | undefined;
  /** 发送瞬间 MD 字符串快照（禁止 lines[]） */
  markdown: string;
  /** 目标笔记；缺省 DEFAULT_CHAT_NOTE_DOC_ID */
  docId?: string;
  /** 单测 mock sink；与 transport 同时存在时 sink 优先 */
  sink?: SendToNoteSink;
  transport?: NoteTransport;
  origin?: 'user' | 'agent';
  onSuccess?: (result: Extract<SendToNoteResult, { ok: true }>) => void;
  onError?: (result: Extract<SendToNoteResult, { ok: false }>) => void;
  className?: string;
};

/**
 * 完成态消息旁的「发送到笔记」入口。
 * 非 completed：不渲染（B-05 仅 completed 显示）。
 */
export const ChatSendToNoteEntry: React.FC<ChatSendToNoteEntryProps> = ({
  messageId,
  status,
  markdown,
  docId = DEFAULT_CHAT_NOTE_DOC_ID,
  sink,
  transport,
  origin = 'user',
  onSuccess,
  onError,
  className,
}) => {
  const handleSuccess = useCallback(
    (result: Extract<SendToNoteResult, { ok: true }>) => {
      onSuccess?.(result);
    },
    [onSuccess]
  );

  const handleError = useCallback(
    (result: Extract<SendToNoteResult, { ok: false }>) => {
      onError?.(result);
    },
    [onError]
  );

  if (!shouldShowSendToNoteEntry(status)) {
    return null;
  }

  const intentId = buildChatSendToNoteIntentId(messageId);

  return (
    <div
      className={className}
      data-testid="chat-send-to-note-entry"
      data-message-id={messageId}
      data-intent-id={intentId}
      data-doc-id={docId}
    >
      <SendToNoteButton
        messageId={messageId}
        status={status}
        markdown={markdown}
        docId={docId}
        intentId={intentId}
        origin={origin}
        {...(sink !== undefined ? { sink } : {})}
        {...(transport !== undefined ? { transport } : {})}
        onSuccess={handleSuccess}
        onError={handleError}
      />
    </div>
  );
};

export default ChatSendToNoteEntry;
