import { MAX_MESSAGES_PER_SESSION } from '@crish/shared-utils/browser';
import { nowIsoTimestamp } from '../../api/sessionTime';
import { getSessionById } from '../sessionIndex';
import { validateStatusTransition } from '../../utils/StatusTransitionGuard';
import { saveMessageSnapshot } from '../messageSnapshotsBridge';
import type { SessionActions, SessionImmerSet } from './types';
import { getMessageById, getSessionMessage, maybeAutoTitleSession } from './_shared';

export function createMessageActions(
  set: SessionImmerSet,
): Pick<SessionActions, 'addMessage' | 'updateMessageText' | 'updateMessageThinking' | 'withdrawMessage' | 'setSessionMessageStatus' | 'pinMessage' | 'unpinMessage'> {
  return {

    addMessage: (_wsId, sessionId, message) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if (!sess.messages) sess.messages = [];
        const newMsg = { ...message, blocks: message.blocks || [] };
        if (newMsg.blocks.length === 0) {
          if (newMsg.text) newMsg.blocks.push({ type: 'text' as const, content: newMsg.text });
          if (newMsg.toolCalls) newMsg.toolCalls.forEach((tc) => {
            newMsg.blocks.push({ type: 'tool_call' as const, id: tc.id });
          });
        }
        if (sess.messages.length >= MAX_MESSAGES_PER_SESSION) {
          const first = sess.messages[0]!;
          if (first.toolCalls?.length) {
            const ids = first.toolCalls
              .filter((tc) => tc.status === 'success' || tc.status === 'error')
              .map((tc) => tc.id);
            if (ids.length) {
              if (!sess.truncatedToolChainIds) sess.truncatedToolChainIds = [];
              for (const id of ids) {
                if (!sess.truncatedToolChainIds.includes(id)) sess.truncatedToolChainIds.push(id);
              }
            }
          }
          if (sess.messages.length > 1 && first.toolCalls?.length) {
            const second = sess.messages[1]!;
            if (second.toolCallResults?.some(r => (first.toolCalls || []).some(tc => tc.id === r.id))) {
              sess.messages.splice(0, 2);
            } else {
              sess.messages.shift();
            }
          } else {
            sess.messages.shift();
          }
        }
        sess.messages.push(newMsg);
        const ts = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
          ? new Date(message.timestamp).toISOString() : nowIsoTimestamp();
        sess.timestamp = ts;
        if (message.sender === 'user') maybeAutoTitleSession(state, sess);
      }),

    updateMessageText: (sessionId, messageId, text) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        const prev = msg.text || '';
        if (msg.text === text) return;
        msg.text = text;
        if (!msg.blocks) msg.blocks = [];
        if (!state.streamingRenderStates) state.streamingRenderStates = {};
        let rs = state.streamingRenderStates[messageId];
        if (!rs) {
          rs = { streamTextOffset: 0 };
          state.streamingRenderStates[messageId] = rs;
        }
        let offset = rs.streamTextOffset;
        if (text.length < offset || (prev && text.length < prev.length && !prev.startsWith(text) && !text.startsWith(prev.slice(0, Math.min(prev.length, text.length))))) {
          offset = 0;
          rs.streamTextOffset = 0;
          msg.blocks = msg.blocks.filter((b) => b.type === 'tool_call');
        }
        const segment = text.length >= offset ? text.slice(offset) : text;
        const lastBlock = msg.blocks[msg.blocks.length - 1];
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.content = segment;
        } else if (segment.length > 0) {
          msg.blocks.push({ type: 'text' as const, content: segment });
        }
      }),

    updateMessageThinking: (sessionId, messageId, thinking) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        if (hit.message.thinking === thinking) return;
        hit.message.thinking = thinking;
      }),

    withdrawMessage: (_wsId, sessionId, messageId) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (sess?.messages) {
          const idx = sess.messages.findIndex((m) => m.id === messageId);
          if (idx !== -1) {
            const prevMessages = sess.messages.slice();
            const prevPinned = sess.pinnedMessageIds ? sess.pinnedMessageIds.slice() : undefined;
            sess.messages = sess.messages.slice(0, idx);
            if (sess.pinnedMessageIds?.length) {
              const keep = new Set(sess.messages.map((m) => m.id));
              sess.pinnedMessageIds = sess.pinnedMessageIds.filter((id) => keep.has(id));
              if (sess.pinnedMessageIds.length === 0) delete sess.pinnedMessageIds;
            }
            saveMessageSnapshot(sessionId, {
              sessionId, operation: 'withdraw' as const, messages: prevMessages,
              ...(prevPinned !== undefined ? { pinnedMessageIds: prevPinned } : {}),
              diffFilePaths: [], timestamp: Date.now(), description: '撤回消息',
            } as any, { afterMessages: sess.messages } as any);
          }
        }
      }),

    setSessionMessageStatus: (sessionId, messageId, status, thinkingTime, opts) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        if (hit.message.status === status && (thinkingTime === undefined || hit.message.thinkingTime === thinkingTime)) return;
        try {
          validateStatusTransition(hit.message.status || '', status, opts?.force);
        } catch (e) {
          console.warn('[StatusTransition] 消息状态非法转换:', (e as Error).message);
          return;
        }
        hit.message.status = status;
        if (thinkingTime !== undefined) hit.message.thinkingTime = thinkingTime;
      }),

    pinMessage: (sessionId, messageId) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if (!getMessageById(sess.messages, messageId)) return;
        if (!sess.pinnedMessageIds) sess.pinnedMessageIds = [];
        if (!sess.pinnedMessageIds.includes(messageId) && sess.pinnedMessageIds.length < MAX_MESSAGES_PER_SESSION) {
          sess.pinnedMessageIds.push(messageId);
        }
      }),

    unpinMessage: (sessionId, messageId) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess?.pinnedMessageIds?.length) return;
        sess.pinnedMessageIds = sess.pinnedMessageIds.filter((id) => id !== messageId);
        if (sess.pinnedMessageIds.length === 0) delete sess.pinnedMessageIds;
      }),
  };
}
