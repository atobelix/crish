/**
 * 将 daemon 广播的 subagent-event 投影到 SessionMessage 时间线。
 * 纯函数：不依赖 DOM / store，便于单测与主对话 hydrate 对齐。
 */

import type { MessageToolCall, SessionMessage } from '../store/types';
import { blockText } from './chat-bridge/handlers/eventUtils';
import {
  applyStreamedTextToBlocks,
  TEXT_SEGMENT_ID_PREFIX,
} from './tool-presentation/timelineReconciler';

type AnyRec = Record<string, unknown>;

function asRec(v: unknown): AnyRec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : null;
}

/** 与 chatBridge / sessionEventHydrate 对齐：兼容 id|toolCallId、name|toolName、input|arguments|parameters */
function toolCallFields(call: unknown): {
  id: string;
  name: string;
  args: string;
  intent?: string;
  group?: string;
  groupId?: string;
  isInternal?: boolean;
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
        typeof c.parameters === 'string'
          ? c.parameters
          : JSON.stringify(c.parameters);
    } catch {
      args = String(c.parameters);
    }
  }
  const intent = typeof c.intent === 'string' && c.intent.trim() ? c.intent.trim() : undefined;
  const group = typeof c.group === 'string' && c.group.trim() ? c.group.trim() : undefined;
  const rawGroupId = c.groupId ?? c.group_id;
  const groupId = typeof rawGroupId === 'string' && rawGroupId.trim() ? rawGroupId.trim() : undefined;
  const isInternal = typeof c.isInternal === 'boolean' ? c.isInternal : undefined;
  return {
    id: id || `tc-${Date.now().toString(36)}`,
    name,
    args,
    intent,
    group,
    groupId,
    isInternal,
  };
}

/** 引擎 ToolBatchResult 主字段为 id + output.text；亦兼容 toolCallId / 扁平 text / error */
function toolResultFields(result: unknown): {
  id: string;
  name: string;
  text: string;
  isError: boolean;
  /** 引擎 ToolBatchResult.durationMs（契约必填）；宽松载荷缺失/非法时为 undefined */
  durationMs?: number;
} {
  const r = asRec(result) || {};
  const id = String(r.toolCallId ?? r.id ?? '');
  const name = String(r.toolName ?? r.name ?? 'tool');
  const durationMs =
    typeof r.durationMs === 'number' &&
    Number.isFinite(r.durationMs) &&
    r.durationMs >= 0
      ? r.durationMs
      : undefined;
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
  return { id, name, text, isError, durationMs };
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
  event: Record<string, unknown>
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
      // 正文 delta 同步分段建块（与主流路径同一实现）：此前只累积
      // a.text、从不建 text 块，面板渲染只能靠已删除的归拢兜底拼凑。
      const prev = a.text || '';
      a.text = prev + t;
      a.status = 'processing';
      if (!a.blocks) a.blocks = [];
      applyStreamedTextToBlocks(a.blocks, prev, a.text);
    }
    return next;
  }

  if (
    type === 'message-end' &&
    event.message &&
    typeof event.message === 'object'
  ) {
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
        if (b.type === 'thought' || b.kind === 'thought')
          thought += blockText(b);
        else if (b.type === 'text') text += blockText(b);
      }
      if (text.trim()) {
        // 本轮权威正文落段：delta 已建活跃段（内容与权威正文前缀重叠）
        // 时就地替换为权威版；否则（快照式整段到达）另起新段追加到
        // blocks 末尾——位置即事件序（本轮工具块在此之后才到达）。
        // 【旧行为】a.text 被本轮正文整段覆写、blocks 从不建 text 块，
        // 多轮正文在面板里只剩最后一轮、且顺序靠归拢兜底虚构。
        const segText = text.trim();
        if (!a.blocks) a.blocks = [];
        const blocks = a.blocks;
        let lastDelimiterIdx = -1;
        let lastTextIdx = -1;
        blocks.forEach((bl, i) => {
          if (bl.type === 'text') lastTextIdx = i;
          else if (bl.type === 'tool_call' || bl.type === 'thought')
            lastDelimiterIdx = i;
        });
        const activeBlock =
          lastTextIdx > lastDelimiterIdx ? blocks[lastTextIdx] : undefined;
        const activeContent = (activeBlock?.content || '').trim();
        if (
          activeBlock &&
          activeContent &&
          (segText.startsWith(activeContent) ||
            activeContent.startsWith(segText))
        ) {
          activeBlock.content = segText;
        } else {
          const ordinal = blocks.filter((bl) => bl.type === 'text').length;
          blocks.push({
            type: 'text',
            id: `${TEXT_SEGMENT_ID_PREFIX}${ordinal}`,
            content: segText,
          });
        }
        // a.text 以段块为唯一真相源重建（各段按序以空行连接）
        a.text = blocks
          .filter((bl) => bl.type === 'text')
          .map((bl) => (bl.content || '').trim())
          .filter(Boolean)
          .join('\n\n');
      }
      if (thought.trim()) a.thinking = thought.trim();
      a.status = 'processing';
    }
    return next;
  }

  if (type === 'tool-start') {
    const a = ensureAsst();
    if (!a.toolCalls) a.toolCalls = [];
    if (!a.blocks) a.blocks = [];
    const { id, name, args, intent, group, groupId, isInternal } = toolCallFields(event.call);
    // 分段记账下无需偏移固化：ensureToolBlock 把 tool_call 块按事件序
    // 追加，其位置本身即封口前一段正文（旧 streamTextOffset 已删除）。
    a.status = 'processing';

    const existing = a.toolCalls.find((t) => t.id === id);
    if (existing) {
      existing.name = name || existing.name;
      existing.arguments = args || existing.arguments;
      if (intent !== undefined) existing.intent = intent;
      if (group !== undefined) existing.group = group;
      if (groupId !== undefined) existing.groupId = groupId;
      if (isInternal !== undefined) existing.isInternal = isInternal;
      // 已终态的不因重放 tool-start 回退为 running；待审批同理——桥接层
      // R7b 镜像可能先于 tool-start 投影落下 pending 条目（携带
      // approvalMeta），迟到的 tool-start 只补 startedAt，状态与元数据
      // 保持不动，待审批由 approval-resolved / tool-end 收口
      if (existing.status !== 'success' && existing.status !== 'error') {
        if (existing.status !== 'pending_approval') {
          existing.status = 'running';
        }
        // 工具时刻补写（R4a）：仅补缺，不覆盖已有值（重放幂等）
        if (existing.startedAt == null) existing.startedAt = Date.now();
      }
    } else {
      a.toolCalls.push({
        id,
        name,
        arguments: args,
        status: 'running',
        // 工具时刻补写（R4a）：引擎 ToolBatchCall 不带时刻字段，startedAt
        // 以前端接收 tool-start 的本地时刻近似（与主对话工具行同为本地钟口径；
        // 此前子 agent 工具调用从不写此字段，侧栏详情无耗时可显示）
        startedAt: Date.now(),
        ...(intent !== undefined ? { intent } : {}),
        ...(group !== undefined ? { group } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(isInternal !== undefined ? { isInternal } : {}),
      });
      ensureToolBlock(a, id);
    }
    return next;
  }

  if (type === 'tool-end') {
    const a = ensureAsst();
    if (!a.toolCalls) a.toolCalls = [];
    if (!a.blocks) a.blocks = [];
    const {
      id,
      name,
      text,
      isError,
      durationMs: engineDurationMs,
    } = toolResultFields(event.result);
    const status: MessageToolCall['status'] = isError ? 'error' : 'success';
    const output = text || (isError ? 'failed' : '完成');

    let tc: MessageToolCall | undefined;
    if (id) {
      tc = a.toolCalls.find((t) => t.id === id);
    } else {
      // 无 id：优先收口仍在 running 的最后一条，避免误改已完成的工具
      tc =
        a.toolCalls.findLast((t) => t.status === 'running') ||
        a.toolCalls[a.toolCalls.length - 1];
    }

    if (tc) {
      tc.status = status;
      tc.output = output;
      if (name && name !== 'tool' && (!tc.name || tc.name === 'tool')) {
        tc.name = name;
      }
      // 工具时刻补写（R4a）：durationMs 优先引擎 ToolBatchResult 的实测值，
      // 缺失时以本地接收时刻差（tool-end − startedAt）近似；仅补缺防重放覆盖
      if (tc.durationMs == null) {
        const derived =
          engineDurationMs ??
          (tc.startedAt != null
            ? Math.max(0, Date.now() - tc.startedAt)
            : undefined);
        if (derived !== undefined) tc.durationMs = derived;
      }
    } else {
      // 漏收 tool-start 时仍落一条终态，避免子 agent 时间线空白
      const newId = id || `tc-${Date.now().toString(36)}`;
      tc = {
        id: newId,
        name,
        arguments: '',
        
        status,
        output,
        // 漏收 tool-start 的终态：startedAt 无从得知（不伪造），
        // 引擎实测 durationMs 在场时照实落数
        ...(engineDurationMs !== undefined
          ? { durationMs: engineDurationMs }
          : {}),
      };
      a.toolCalls.push(tc);
      ensureToolBlock(a, newId);
    }
    return next;
  }

  return next;
}
