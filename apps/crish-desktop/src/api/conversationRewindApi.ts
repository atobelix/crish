/**
 * Conversation Rewind desktop bridge.
 *
 * T03.7：preview/apply-conversation-rewind 为幽灵命令（Rust 侧无，已从 commandMap 删除），
 * 本模块显式不可用（返回 ok:false + error 文案），不发起任何 transport 请求。
 */
export interface ConversationRewindPreview {
  ok: boolean;
  raw: Record<string, unknown>;
  error?: string;
}

/**
 * Preview rewind to a target leaf / message boundary.
 * T03.7：显式不可用。
 */
export async function previewConversationRewind(_input: {
  sessionId: string;
  targetLeafId?: string;
  targetEventId?: string;
  targetMessageId?: string;
}): Promise<ConversationRewindPreview> {
  return {
    ok: false,
    raw: {},
    error: '引擎不支持对话回退预览（preview-conversation-rewind 不可用）',
  };
}
