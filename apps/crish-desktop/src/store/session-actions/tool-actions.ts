import { getSessionById } from '../sessionIndex';
import type { SessionActions, SessionImmerSet } from './types';
import { getSessionMessage, getSessionAgent, toolCallPatchHasChanges } from './_shared';
import type { MessageToolCall } from '../types';

export function createToolActions(
  set: SessionImmerSet,
): Pick<SessionActions, 'addMessageToolCall' | 'updateMessageToolCall' | 'respondToApproval' | 'patchAgentTool'> {
  return {

    addMessageToolCall: (sessionId, messageId, toolCall) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        if (!msg.toolCalls) msg.toolCalls = [];
        if (!msg.blocks) msg.blocks = [];

        const mergeInto = (target: typeof toolCall) => {
          if ((target.status === 'success' || target.status === 'error') && toolCall.status === 'running') {
            if (!target.arguments && toolCall.arguments) target.arguments = toolCall.arguments;
            if (!target.explanation && toolCall.explanation) target.explanation = toolCall.explanation;
            return;
          }
          const prevStatus = target.status;
          const prevOut = target.output;
          const prevArgs = target.arguments;
          target.id = toolCall.id;
          target.name = toolCall.name;
          target.arguments = toolCall.arguments;
          target.status = toolCall.status;
          if (toolCall.output !== undefined) target.output = toolCall.output;
          if (toolCall.diffs !== undefined) target.diffs = toolCall.diffs;
          if (toolCall.explanation !== undefined) target.explanation = toolCall.explanation;
          if (toolCall.approvalMeta !== undefined) target.approvalMeta = toolCall.approvalMeta;
          if (toolCall.startedAt !== undefined) target.startedAt = toolCall.startedAt;
          if (toolCall.completedAt !== undefined) target.completedAt = toolCall.completedAt;
          if (toolCall.turnId !== undefined) target.turnId = toolCall.turnId;
          if (!toolCall.arguments && prevArgs) target.arguments = prevArgs;
          if (!toolCall.output && prevOut) target.output = prevOut;
          if ((prevStatus === 'success' || prevStatus === 'error') && toolCall.status === 'running') {
            target.status = prevStatus;
          }
        };

        const existing = msg.toolCalls.find((t) => t.id === toolCall.id);
        if (existing) { mergeInto(existing); return; }

        if (!state.streamingRenderStates) state.streamingRenderStates = {};
        let rs = state.streamingRenderStates[messageId];
        if (!rs) {
          rs = { streamTextOffset: 0 };
          state.streamingRenderStates[messageId] = rs;
        }
        rs.streamTextOffset = (msg.text || '').length;
        const lastB = msg.blocks[msg.blocks.length - 1];
        if (lastB && lastB.type === 'text' && !(lastB.content || '').trim()) msg.blocks.pop();
        msg.toolCalls.push(toolCall);
        if (!msg.blocks.some((b) => b.type === 'tool_call' && b.id === toolCall.id)) {
          msg.blocks.push({ type: 'tool_call' as const, id: toolCall.id });
        }
      }),

    updateMessageToolCall: (sessionId, messageId, toolCallId, updates) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        if (!msg.toolCalls) return;
        const tc = msg.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        let effective: typeof updates = updates;
        if ((tc.status === 'success' || tc.status === 'error') && updates.status === 'running') {
          const rest = { ...updates };
          delete rest.status;
          effective = rest;
        }
        if (!toolCallPatchHasChanges(tc, effective)) return;
        for (const k of Object.keys(effective) as Array<keyof MessageToolCall>) {
          if (effective[k] !== undefined) (tc as unknown as Record<keyof MessageToolCall, unknown>)[k] = effective[k];
        }
      }),

    respondToApproval: (_wsId, sessionId, messageId, toolCallId, status) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit?.message.toolCalls) return;
        const tc = hit.message.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        if (status === 'success') {
          tc.status = 'success';
          tc.output = '已批准，正在执行\u2026';
        } else {
          tc.status = 'error';
          tc.output = '权限被拒绝。';
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
          if ((tc.status === 'success' || tc.status === 'error') && patch.status === 'running') {
            const rest = { ...patch };
            delete rest.status;
            for (const k of Object.keys(rest) as Array<keyof MessageToolCall>) {
              if (rest[k] !== undefined) (tc as unknown as Record<keyof MessageToolCall, unknown>)[k] = rest[k];
            }
          } else {
            for (const k of Object.keys(patch) as Array<keyof MessageToolCall>) {
              if (patch[k] !== undefined) (tc as unknown as Record<keyof MessageToolCall, unknown>)[k] = patch[k];
            }
          }
          return;
        }
      }),
  };
}
