import { MAX_MESSAGES_PER_AGENT } from '@crish/shared-utils/browser';
import { getSessionById } from '../sessionIndex';
import type { SessionActions, SessionImmerSet } from './types';
import { getSessionAgent, getMessageById } from './_shared';

export function createAgentActions(
  set: SessionImmerSet,
): Pick<SessionActions, 'setActiveAgentId' | 'setPanelAgentId' | 'upsertSessionAgent' | 'patchSessionAgent' | 'appendSessionAgentMessage'> {
  return {

    setActiveAgentId: (id) =>
      set((state) => {
        if (id) {
          state.activeAgentId = null;
          state.panelAgentId = id;
        } else {
          state.activeAgentId = null;
        }
      }),

    setPanelAgentId: (id) =>
      set((state) => {
        state.panelAgentId = id;
      }),

    upsertSessionAgent: (sessionId, agent) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if (!sess.agents) sess.agents = [];
        const i = sess.agents.findIndex((a) => a.id === agent.id);
        if (i >= 0) {
          const existing = sess.agents[i]!;
          sess.agents[i] = {
            ...existing, ...agent,
            messages: agent.messages?.length ? agent.messages : existing.messages,
          };
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
        Object.entries(patch).forEach(([k, v]) => { (ag as unknown as Record<string, unknown>)[k] = v; });
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
          existing.id = message.id;
          existing.sender = message.sender;
          existing.timestamp = message.timestamp;
          if (message.text !== undefined) existing.text = message.text;
          if (message.thinking !== undefined) existing.thinking = message.thinking;
          if (message.toolCalls !== undefined) existing.toolCalls = message.toolCalls;
          if (message.status !== undefined) existing.status = message.status;
          if (message.blocks !== undefined) existing.blocks = message.blocks;
          if ((message as any).streamTextOffset !== undefined) (existing as any).streamTextOffset = (message as any).streamTextOffset;
          if (message.thinkingTime !== undefined) existing.thinkingTime = message.thinkingTime;
        } else {
          if (ag.messages.length >= MAX_MESSAGES_PER_AGENT) {
            const first = ag.messages[0]!;
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
            ag.messages.shift();
          }
          ag.messages.push(message);
        }
      }),
  };
}
