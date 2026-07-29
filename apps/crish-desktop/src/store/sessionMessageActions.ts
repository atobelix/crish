import { MAX_MESSAGES_PER_SESSION } from '@crish/shared-utils/browser';
import { nowIsoTimestamp } from '../api/sessionTime';
import type {
  MessageToolCall,
} from './types';
import { getSessionForWrite, rebindSessionById } from './sessionIndex';
import { validateStatusTransition } from '../utils/StatusTransitionGuard';
import { saveMessageSnapshot } from './messageSnapshotsBridge';
import type { SessionActions, SessionStoreSlice, SessionImmerSet } from './sessionActions';
import {
  applyMessageToolCallPatch,
  getMessageById,
  getSessionMessage,
  maybeAutoTitleSession,
  sanitizeToolCallUpdates,
  toolCallPatchHasChanges,
  truncateMessagesForAppend,
  upsertMessageById,
} from './sessionSharedHelpers';

export function createSessionMessageActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<
  SessionActions,
  | 'addMessage'
  | 'withdrawMessage'
  | 'respondToApproval'
  | 'updateMessageText'
  | 'updateMessageThinking'
  | 'addMessageToolCall'
  | 'updateMessageToolCall'
  | 'setSessionMessageStatus'
  | 'pinMessage'
  | 'unpinMessage'
> {
  return {
    addMessage: (_wsId, sessionId, message) =>
      set((state) => {
        // getSessionForWrite：经 sessions[] 写，避免 immer 只 fork sessionsById
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if (!sess.messages) sess.messages = [];

        const newMsg = {
          ...message,
          blocks: message.blocks || [],
        };
        if (newMsg.blocks.length === 0) {
          if (newMsg.text) {
            newMsg.blocks.push({ type: 'text' as const, content: newMsg.text });
          }
          if (newMsg.toolCalls) {
            newMsg.toolCalls.forEach((tc) => {
              newMsg.blocks.push({ type: 'tool_call' as const, id: tc.id });
            });
          }
        }

        // 同 id 已存在 → 原地 update，不 push（幂等 / 防 daemon 回显双写）
        const existing = getMessageById(sess.messages, newMsg.id);
        if (!existing) {
          truncateMessagesForAppend(
            sess.messages,
            MAX_MESSAGES_PER_SESSION,
            sess,
            sess.pinnedMessageIds
          );
        }
        upsertMessageById(sess.messages, newMsg);
        const ts =
          typeof message.timestamp === 'number' &&
          Number.isFinite(message.timestamp)
            ? new Date(message.timestamp).toISOString()
            : nowIsoTimestamp();
        sess.timestamp = ts;
        if (sess.timestampSource !== 'local') {
          sess.timestampSource = 'local';
        }
        if (message.sender === 'user') {
          maybeAutoTitleSession(state, sess);
        }
        rebindSessionById(state, sessionId, sess);
      }),

    withdrawMessage: (_wsId, sessionId, messageId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (sess?.messages) {
          const idx = sess.messages.findIndex((m) => m.id === messageId);
          if (idx !== -1) {
            const prevMessages = sess.messages.slice();
            const prevPinned = sess.pinnedMessageIds
              ? sess.pinnedMessageIds.slice()
              : undefined;
            // 收集被撤回消息影响的文件路径（轻量：仅取 toolCalls[].diffs[].filePath）
            const pathSet = new Set<string>();
            for (const m of prevMessages.slice(idx)) {
              for (const tc of m.toolCalls || []) {
                for (const d of tc.diffs || []) {
                  if (d.filePath) pathSet.add(d.filePath);
                }
              }
            }
            sess.messages = sess.messages.slice(0, idx);
            if (sess.pinnedMessageIds?.length) {
              const keep = new Set(sess.messages.map((m) => m.id));
              sess.pinnedMessageIds = sess.pinnedMessageIds.filter((id) =>
                keep.has(id)
              );
              if (sess.pinnedMessageIds.length === 0)
                delete sess.pinnedMessageIds;
            }
            saveMessageSnapshot(
              sessionId,
              {
                sessionId,
                operation: 'withdraw',
                messages: prevMessages,
                ...(prevPinned !== undefined ? { pinnedMessageIds: prevPinned } : {}),
                diffFilePaths: [...pathSet],
                timestamp: Date.now(),
                description: '撤回消息',
              },
              { afterMessages: sess.messages }
            );
            rebindSessionById(state, sessionId, sess);
          }
        }
      }),

    respondToApproval: (sessionId, messageId, toolCallId, decision) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit?.message.toolCalls) return;
        const tc = hit.message.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        if (tc.approvalDecision !== decision) {
          tc.approvalDecision = decision;
          rebindSessionById(state, sessionId, hit.session);
        }
      }),

    updateMessageText: (sessionId, messageId, text, precomputedHtml) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        const htmlChanged =
          precomputedHtml !== undefined &&
          msg.precomputedHtml !== precomputedHtml;
        if (htmlChanged) {
          msg.precomputedHtml = precomputedHtml;
        }
        if (msg.text === text && !htmlChanged) return;
        const prev = msg.text || '';
        msg.text = text;
        if (!msg.blocks) msg.blocks = [];
        let offset =
          typeof msg.streamTextOffset === 'number' ? msg.streamTextOffset : 0;
        if (
          text.length < offset ||
          (prev &&
            text.length < prev.length &&
            !prev.startsWith(text) &&
            !text.startsWith(prev.slice(0, Math.min(prev.length, text.length))))
        ) {
          offset = 0;
          msg.streamTextOffset = 0;
          msg.blocks = msg.blocks.filter((b) => b.type === 'tool_call');
        }
        const segment = text.length >= offset ? text.slice(offset) : text;
        const lastBlock = msg.blocks[msg.blocks.length - 1];
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.content = segment;
        } else if (segment.length > 0) {
          msg.blocks.push({ type: 'text' as const, content: segment });
        }
        rebindSessionById(state, sessionId, hit.session);
      }),

    updateMessageThinking: (sessionId, messageId, thinking) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        if (hit.message.thinking === thinking) return;
        hit.message.thinking = thinking;
        rebindSessionById(state, sessionId, hit.session);
      }),

    addMessageToolCall: (sessionId, messageId, toolCall) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        if (!msg.toolCalls) msg.toolCalls = [];
        if (!msg.blocks) msg.blocks = [];

        const mergeInto = (target: MessageToolCall) => {
          if (
            (target.status === 'success' || target.status === 'error') &&
            toolCall.status === 'running'
          ) {
            if (!target.arguments && toolCall.arguments)
              target.arguments = toolCall.arguments;
            if (!target.explanation && toolCall.explanation)
              target.explanation = toolCall.explanation;
            return;
          }
          const prevStatus = target.status;
          const prevOut = target.output;
          const prevArgs = target.arguments;
          Object.assign(target, toolCall);
          if (!toolCall.arguments && prevArgs) target.arguments = prevArgs;
          if (!toolCall.output && prevOut) target.output = prevOut;
          if (
            (prevStatus === 'success' || prevStatus === 'error') &&
            toolCall.status === 'running'
          ) {
            target.status = prevStatus;
          }
        };

        const existing = msg.toolCalls.find((t) => t.id === toolCall.id);
        if (existing) {
          mergeInto(existing);
          rebindSessionById(state, sessionId, hit.session);
          return;
        }

        msg.streamTextOffset = (msg.text || '').length;
        const lastB = msg.blocks[msg.blocks.length - 1];
        if (lastB && lastB.type === 'text' && !(lastB.content || '').trim()) {
          msg.blocks.pop();
        }
        msg.toolCalls.push(toolCall);
        if (
          !msg.blocks.some(
            (b) => b.type === 'tool_call' && b.id === toolCall.id
          )
        ) {
          msg.blocks.push({ type: 'tool_call' as const, id: toolCall.id });
        }
        rebindSessionById(state, sessionId, hit.session);
      }),

    updateMessageToolCall: (sessionId, messageId, toolCallId, updates) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        if (!msg.toolCalls) return;
        const tc = msg.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        const effective = sanitizeToolCallUpdates(tc, updates);
        if (!toolCallPatchHasChanges(tc, effective)) return;
        applyMessageToolCallPatch(tc, effective);
        rebindSessionById(state, sessionId, hit.session);
      }),

    setSessionMessageStatus: (
      sessionId,
      messageId,
      status,
      thinkingTime,
      opts
    ) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        if (
          hit.message.status === status &&
          (thinkingTime === undefined ||
            hit.message.thinkingTime === thinkingTime) &&
          !opts?.errorDetail
        ) {
          return;
        }
        try {
          validateStatusTransition(
            hit.message.status || '',
            status,
            opts?.force
          );
        } catch (e) {
          console.warn(
            '[StatusTransition] 消息状态非法转换:',
            (e as Error).message
          );
          return;
        }
        hit.message.status = status;
        if (thinkingTime !== undefined) {
          hit.message.thinkingTime = thinkingTime;
        }
        if (opts?.errorDetail) {
          hit.message.errorDetail = opts.errorDetail;
        }
        rebindSessionById(state, sessionId, hit.session);
      }),

    pinMessage: (sessionId, messageId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if (!getMessageById(sess.messages, messageId)) return;
        if (!sess.pinnedMessageIds) sess.pinnedMessageIds = [];
        if (
          !sess.pinnedMessageIds.includes(messageId) &&
          sess.pinnedMessageIds.length < MAX_MESSAGES_PER_SESSION
        ) {
          sess.pinnedMessageIds.push(messageId);
          rebindSessionById(state, sessionId, sess);
        }
      }),

    unpinMessage: (sessionId, messageId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess?.pinnedMessageIds?.length) return;
        const next = sess.pinnedMessageIds.filter((id) => id !== messageId);
        if (next.length === sess.pinnedMessageIds.length) return;
        sess.pinnedMessageIds = next;
        if (sess.pinnedMessageIds.length === 0) delete sess.pinnedMessageIds;
        rebindSessionById(state, sessionId, sess);
      }),
  };
}
