/**
 * 消息域 handler（T7 分派表）：message-start / message-delta / message-end。
 *
 * message-delta 同时承接 text-delta 别名（解析层已归一为 message-delta 信封），
 * 时序重组语义与原 16 分支实现完全等价：delta 增量拼接、thought 单独累积、
 * message-end 终态整段合并（mergeAssistantTextPiece）。
 */
import { blockText, mergeAssistantTextPiece } from './eventUtils';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

export function onMessageStart(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'message-start'>
): void {
  // message-start 无 UI 语义：显式空实现，保证分派表全键覆盖
}

export function onMessageDelta(
  env: HandlerEnv,
  envelope: EngineEnvelope<'message-delta'>
): void {
  const { state, callbacks } = env;
  const { event, raw } = envelope;
  const block = event.block;
  const t = blockText(block);
  if (!t) return;
  if (block.type === 'thought') {
    state.assistantThought += t;
    callbacks.onThought(state.assistantThought);
    return;
  }
  let deltaToSend = t;
  if (raw.message && typeof raw.message === 'object') {
    const msg = raw.message as Record<string, unknown>;
    if (
      typeof msg.content === 'string' &&
      msg.content.length >= state.assistantText.length
    ) {
      deltaToSend = msg.content.slice(state.assistantText.length);
      state.assistantText = msg.content;
    } else {
      state.assistantText += t;
    }
  } else {
    state.assistantText += t;
  }
  if (deltaToSend) {
    callbacks.onChunk(deltaToSend);
  }
}

export function onMessageEnd(
  env: HandlerEnv,
  envelope: EngineEnvelope<'message-end'>
): void {
  const { state, callbacks } = env;
  const msg = envelope.event.message;
  if (msg.role !== 'assistant') return;
  const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
  let text = '';
  let thought = '';
  for (const bl of blocks) {
    const b = bl as unknown as Record<string, unknown>;
    if (b.type === 'thought' || b.kind === 'thought') thought += blockText(b);
    else if (b.type === 'text') text += blockText(b);
  }
  if (typeof msg.content === 'string' && msg.content && !text) text = msg.content;
  if (thought.trim()) {
    if (
      state.assistantThought &&
      !state.assistantThought.includes(thought.trim())
    ) {
      state.assistantThought = `${state.assistantThought}\n${thought.trim()}`;
    } else {
      state.assistantThought = thought.trim();
    }
    callbacks.onThought(state.assistantThought);
  }
  if (text.trim()) {
    const piece = text.trim();
    const prevLen = state.assistantText.length;
    state.assistantText = mergeAssistantTextPiece(state.assistantText, piece);
    if (state.assistantText.length > prevLen) {
      const addedDelta = state.assistantText.slice(prevLen);
      callbacks.onChunk(addedDelta);
    }
  }
}
