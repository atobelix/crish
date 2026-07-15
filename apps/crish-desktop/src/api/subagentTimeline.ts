/**
 * 将 daemon 广播的 subagent-event 投影到 SessionMessage 时间线。
 */

import type { SessionMessage } from '../store/layoutStore';

function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as Record<string, unknown>;
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  return '';
}

/**
 * 根据子 agent 事件更新其消息列表（不可变返回新数组）。
 */
export function applySubagentEventToMessages(
  messages: SessionMessage[],
  event: Record<string, unknown>,
): SessionMessage[] {
  const type = String(event.type ?? '');
  const next = [...messages];
  let asst = next.filter((m) => m.sender === 'assistant').pop();

  const ensureAsst = (): SessionMessage => {
    if (asst) return asst;
    asst = {
      id: `agent-asst-${Date.now().toString(36)}`,
      sender: 'assistant',
      text: '',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [],
      blocks: [],
    };
    next.push(asst);
    return asst;
  };

  if (type === 'message-delta') {
    const a = ensureAsst();
    const t = blockText(event.block);
    if (!t) return next;
    const b = (event.block && typeof event.block === 'object'
      ? event.block
      : {}) as Record<string, unknown>;
    if (b.type === 'thought' || b.kind === 'thought') {
      a.thinking = (a.thinking || '') + t;
    } else {
      a.text = (a.text || '') + t;
      a.status = 'processing';
    }
    return next;
  }

  if (type === 'message-end' && event.message && typeof event.message === 'object') {
    const msg = event.message as Record<string, unknown>;
    if (msg.role === 'assistant') {
      const a = ensureAsst();
      let text = '';
      let thought = '';
      if (typeof msg.content === 'string') text = msg.content;
      const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
      for (const bl of blocks) {
        if (!bl || typeof bl !== 'object') continue;
        const b = bl as Record<string, unknown>;
        if (b.type === 'thought' || b.kind === 'thought') thought += blockText(b);
        else if (b.type === 'text') text += blockText(b);
      }
      if (text.trim()) a.text = text.trim();
      if (thought.trim()) a.thinking = thought.trim();
      a.status = 'processing';
    }
    return next;
  }

  if (type === 'tool-start') {
    const a = ensureAsst();
    if (!a.toolCalls) a.toolCalls = [];
    if (!a.blocks) a.blocks = [];
    const call = (event.call && typeof event.call === 'object'
      ? event.call
      : {}) as Record<string, unknown>;
    const id = String(call.id ?? call.toolCallId ?? `tc-${Date.now()}`);
    const name = String(call.name ?? call.toolName ?? 'tool');
    let args = '';
    if (typeof call.arguments === 'string') args = call.arguments;
    else if (call.input !== undefined) {
      try {
        args = typeof call.input === 'string' ? call.input : JSON.stringify(call.input);
      } catch {
        args = String(call.input);
      }
    }
    const existing = a.toolCalls.find((t) => t.id === id);
    if (existing) {
      existing.name = name;
      existing.arguments = args || existing.arguments;
      existing.status = 'running';
    } else {
      a.toolCalls.push({
        id,
        name,
        arguments: args,
        explanation: String(call.summary ?? name),
        status: 'running',
      });
      if (!a.blocks.some((b) => b.type === 'tool_call' && b.id === id)) {
        a.blocks.push({ type: 'tool_call', id });
      }
    }
    return next;
  }

  if (type === 'tool-end') {
    const a = asst;
    if (!a?.toolCalls) return next;
    const result = (event.result && typeof event.result === 'object'
      ? event.result
      : {}) as Record<string, unknown>;
    const id = String(result.toolCallId ?? result.id ?? '');
    const isError = Boolean(result.isError ?? result.error);
    let text = '';
    if (typeof result.output === 'string') text = result.output;
    else if (result.output && typeof result.output === 'object') {
      const o = result.output as Record<string, unknown>;
      text = typeof o.text === 'string' ? o.text : JSON.stringify(o);
    } else if (typeof result.text === 'string') text = result.text;
    const tc =
      a.toolCalls.find((t) => t.id === id) || a.toolCalls[a.toolCalls.length - 1];
    if (tc) {
      tc.status = isError ? 'error' : 'success';
      tc.output = text || (isError ? 'failed' : '完成');
    }
    return next;
  }

  return next;
}
