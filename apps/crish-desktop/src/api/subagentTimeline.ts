/**
 * 将 daemon 广播的 subagent-event 投影到 SessionMessage 时间线。
 * 纯函数：不依赖 DOM / store，便于单测与主对话 hydrate 对齐。
 */

import type { MessageToolCall, SessionMessage } from '../store/types';

type AnyRec = Record<string, unknown>;

function asRec(v: unknown): AnyRec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : null;
}

function blockText(block: unknown): string {
  const b = asRec(block);
  if (!b) return '';
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  return '';
}

/** 与 daemonChatBridge / sessionEventHydrate 对齐：兼容 id|toolCallId、name|toolName、input|arguments|parameters */
function toolCallFields(call: unknown): {
  id: string;
  name: string;
  args: string;
  explanation: string;
} {
  const c = asRec(call) || {};
  const id = String(c.id ?? c.toolCallId ?? '');
  const name = String(c.name ?? c.toolName ?? 'tool');
  let args = '';
  if (typeof c.arguments === 'string') {
    args = c.arguments;
  } else if (c.input !== undefined) {
    try {
      args = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
    } catch {
      args = String(c.input);
    }
  } else if (c.parameters !== undefined) {
    try {
      args =
        typeof c.parameters === 'string' ? c.parameters : JSON.stringify(c.parameters);
    } catch {
      args = String(c.parameters);
    }
  }
  const explanation = String(c.summary ?? c.description ?? name);
  return {
    id: id || `tc-${Date.now().toString(36)}`,
    name,
    args,
    explanation,
  };
}

/** 引擎 ToolBatchResult 主字段为 id + output.text；亦兼容 toolCallId / 扁平 text / error */
function toolResultFields(result: unknown): {
  id: string;
  name: string;
  text: string;
  isError: boolean;
} {
  const r = asRec(result) || {};
  const id = String(r.toolCallId ?? r.id ?? '');
  const name = String(r.toolName ?? r.name ?? 'tool');
  const isError = Boolean(r.isError ?? r.error);
  let text = '';
  if (typeof r.output === 'string') {
    text = r.output;
  } else if (r.output && typeof r.output === 'object') {
    const o = r.output as AnyRec;
    if (typeof o.text === 'string') text = o.text;
    else if (o.json !== undefined) {
      try {
        text = typeof o.json === 'string' ? o.json : JSON.stringify(o.json);
      } catch {
        text = String(o.json);
      }
    } else {
      try {
        text = JSON.stringify(o);
      } catch {
        text = String(o);
      }
    }
  } else if (typeof r.text === 'string') {
    text = r.text;
  } else if (r.error != null && r.error !== false) {
    text = typeof r.error === 'string' ? r.error : String(r.error);
  }
  return { id, name, text, isError };
}

function ensureToolBlock(a: SessionMessage, id: string): void {
  if (!a.blocks) a.blocks = [];
  if (!a.blocks.some((b) => b.type === 'tool_call' && b.id === id)) {
    a.blocks.push({ type: 'tool_call', id });
  }
}

/**
 * 根据子 agent 事件更新其消息列表（返回新数组；消息对象就地更新，与 live store 用法一致）。
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
    const b = asRec(event.block) || {};
    if (b.type === 'thought' || b.kind === 'thought') {
      a.thinking = (a.thinking || '') + t;
    } else {
      a.text = (a.text || '') + t;
      a.status = 'processing';
    }
    return next;
  }

  if (type === 'message-end' && event.message && typeof event.message === 'object') {
    const msg = event.message as AnyRec;
    if (msg.role === 'assistant') {
      const a = ensureAsst();
      let text = '';
      let thought = '';
      if (typeof msg.content === 'string') text = msg.content;
      const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
      for (const bl of blocks) {
        if (!bl || typeof bl !== 'object') continue;
        const b = bl as AnyRec;
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
    const { id, name, args, explanation } = toolCallFields(event.call);
    // 工具前固化正文偏移，便于 text / tool_call 交错时间线
    a.streamTextOffset = (a.text || '').length;
    a.status = 'processing';

    const existing = a.toolCalls.find((t) => t.id === id);
    if (existing) {
      existing.name = name || existing.name;
      existing.arguments = args || existing.arguments;
      existing.explanation = explanation || existing.explanation;
      // 已终态的不因重放 tool-start 回退为 running
      if (existing.status !== 'success' && existing.status !== 'error') {
        existing.status = 'running';
      }
    } else {
      a.toolCalls.push({
        id,
        name,
        arguments: args,
        explanation,
        status: 'running',
      });
      ensureToolBlock(a, id);
    }
    return next;
  }

  if (type === 'tool-end') {
    const a = ensureAsst();
    if (!a.toolCalls) a.toolCalls = [];
    if (!a.blocks) a.blocks = [];
    const { id, name, text, isError } = toolResultFields(event.result);
    const status: MessageToolCall['status'] = isError ? 'error' : 'success';
    const output = text || (isError ? 'failed' : '完成');

    let tc: MessageToolCall | undefined;
    if (id) {
      tc = a.toolCalls.find((t) => t.id === id);
    } else {
      // 无 id：优先收口仍在 running 的最后一条，避免误改已完成的工具
      tc =
        [...a.toolCalls].reverse().find((t) => t.status === 'running') ||
        a.toolCalls[a.toolCalls.length - 1];
    }

    if (tc) {
      tc.status = status;
      tc.output = output;
      if (name && name !== 'tool' && (!tc.name || tc.name === 'tool')) {
        tc.name = name;
      }
    } else {
      // 漏收 tool-start 时仍落一条终态，避免子 agent 时间线空白
      const newId = id || `tc-${Date.now().toString(36)}`;
      tc = {
        id: newId,
        name,
        arguments: '',
        explanation: name,
        status,
        output,
      };
      a.toolCalls.push(tc);
      ensureToolBlock(a, newId);
    }
    return next;
  }

  return next;
}
