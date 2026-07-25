import { MAX_MESSAGES_PER_AGENT } from '@crish/shared-utils/browser';
import type { MessageToolCall, SessionAgent, SessionAgentPatch, SessionMessage } from './types';
import { getSessionById } from './sessionIndex';
import type { SessionActions, SessionStoreSlice, SessionImmerSet } from './sessionActions';
import {
  applyMessageToolCallPatch,
  applySessionAgentPatch,
  getMessageById,
  getSessionAgent,
  mergeSessionMessageFields,
  sanitizeToolCallUpdates,
  toolCallPatchHasChanges,
  truncateMessagesForAppend,
} from './sessionSharedHelpers';

export function createSessionAgentActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<
  SessionActions,
  | 'upsertSessionAgent'
  | 'patchSessionAgent'
  | 'appendSessionAgentMessage'
  | 'patchAgentTool'
> {
  return {
    upsertSessionAgent: (sessionId, agent) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if (!sess.agents) sess.agents = [];
        const i = sess.agents.findIndex((a) => a.id === agent.id);
        if (i >= 0) {
          const existingAgent = sess.agents[i];
          if (!existingAgent) {
            sess.agents.unshift(agent);
          } else {
            sess.agents[i] = {
              ...existingAgent,
              ...agent,
              messages: agent.messages?.length
                ? agent.messages
                : existingAgent.messages,
            };
          }
        } else {
          sess.agents.unshift(agent);
          if (sess.agents.length > 40) sess.agents.length = 40;
        }
      }),

    patchSessionAgent: (sessionId, agentId, patch) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag) return;
        applySessionAgentPatch(ag, patch);
      }),

    appendSessionAgentMessage: (sessionId, agentId, message) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag) return;
        if (!ag.messages) ag.messages = [];
        const existing = getMessageById(ag.messages, message.id);
        if (existing) {
          mergeSessionMessageFields(existing, message);
        } else {
          truncateMessagesForAppend(
            ag.messages,
            MAX_MESSAGES_PER_AGENT,
            sess,
            undefined
          );
          ag.messages.push(message);
        }
      }),

    patchAgentTool: (sessionId, agentId, toolCallId, patch) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag?.messages) return;
        for (const msg of ag.messages) {
          if (!msg.toolCalls) continue;
          const tc = msg.toolCalls.find((t) => t.id === toolCallId);
          if (!tc) continue;
          const effective = sanitizeToolCallUpdates(tc, patch);
          if (!toolCallPatchHasChanges(tc, effective)) return;
          applyMessageToolCallPatch(tc, effective);
          return;
        }
      }),
  };
}
