/**
 * 工具调用与交错多步骤 Timeline 块规范化纯函数（timelineNormalizer）。
 *
 * 核心设计：
 * - 确立 [步骤 1: 思考 ➔ 工具调用 ➔ 观察结果] ➔ [步骤 2: 思考 ➔ 工具调用 ➔ 观察结果] ➔ [最终 Markdown 回复] 真实有序结构；
 * - 流式期间保持 0 重排签名（timelineSignature 针对活跃增量块只投影标记，不破坏 memo）；
 * - 规范化助手消息时间线，对齐 blocks / toolCalls / thinkingTurns。
 *
 * V1（统一输入流收敛战役）单源化：
 * - **折叠单源**：buildToolRenderItems 为唯一产出 ToolRenderItem[] 的裁决点，
 *   连续 inspect 折叠 + 同轮并行分组两类语义均收进投影层；渲染端不再展平/重分组，
 *   group.label 由死字段复活为折叠头文案（`${toolHumanLabel(last)} · ${n} 步`）。
 * - **对齐单源**：alignToolCallBlocks 为 tool_call 块 ↔ toolCalls 唯一对齐纯函数，
 *   normalizeAssistantTimeline 与流式 view model（applyStreamToolsToMessage）共用，
 *   消除双实现（V1-δ）。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import type { MessageTimelineBlock } from '../../store/types';
import type {
  AssistantTimelineItem,
} from './toolPresentationTypes';
import { buildToolRenderItems } from './toolRenderItems';

// 渲染项构建（dedupeToolCalls / buildToolRenderItems）拆分到 toolRenderItems.ts
// （V1-γ 折叠单源），hub 经 re-export 保持对外契约不变
export { buildToolRenderItems, dedupeToolCalls } from './toolRenderItems';

/**
 * tool_call 块 ↔ toolCalls 对齐（单一对齐源，V1-δ）。
 *
 * 规则（text 感知插位）：
 * 1. 剔除悬空 tool_call 块（id 不在 tools 中）；
 * 2. 注入缺失 tool_call 块：仅 text/空块时置前，否则插到最后 text 块之前。
 *
 * normalizeAssistantTimeline（持久化/水合/选择器）与流式 view model
 * （applyStreamToolsToMessage）共用本函数，消除重复实现。
 */
export function alignToolCallBlocks(
  blocks: MessageTimelineBlock[] | undefined,
  tools: MessageToolCall[]
): MessageTimelineBlock[] {
  const toolIds = new Set(tools.map((t) => t.id));
  const next = (blocks || []).filter(
    (b) => b.type !== 'tool_call' || (b.id != null && toolIds.has(b.id))
  );
  const inBlocks = new Set(
    next
      .filter((b) => b.type === 'tool_call' && b.id)
      .map((b) => b.id as string)
  );
  const missing = tools.filter((t) => !inBlocks.has(t.id));
  if (missing.length === 0) return next;

  const onlyTextOrEmpty =
    next.length === 0 || next.every((b) => b.type === 'text');
  if (onlyTextOrEmpty) {
    return [
      ...missing.map((t) => ({ type: 'tool_call' as const, id: t.id })),
      ...next,
    ];
  }

  let insertAt = next.length;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.type === 'text') {
      insertAt = i;
      break;
    }
  }
  const inject = missing.map((t) => ({
    type: 'tool_call' as const,
    id: t.id,
  }));
  return [...next.slice(0, insertAt), ...inject, ...next.slice(insertAt)];
}

/**
 * 规范化助手消息时间线：blocks 与 toolCalls 对齐，保证可交错渲染。
 * live / hydrate / 持久化共用，避免各写一套顺序。
 * V1-δ：tool_call 块对齐走单一对齐源 alignToolCallBlocks。
 */
export function normalizeAssistantTimeline(
  msg: SessionMessage
): SessionMessage {
  if (msg.sender !== 'assistant') return msg;
  const tools = [...(msg.toolCalls || [])];
  const blocks = alignToolCallBlocks(msg.blocks, tools);

  // 有正文但无 text 块时补偿
  if ((msg.text || '').trim() && !blocks.some((b) => b.type === 'text')) {
    blocks.push({ type: 'text', content: msg.text || '' });
  }

  return {
    ...msg,
    toolCalls: tools,
    blocks,
  };
}

function parseInlineThoughtAndText(
  raw: string,
  turnIndex?: number
): Array<{ kind: 'thought' | 'text'; content: string; turnIndex?: number }> {
  if (!raw || !raw.trim()) return [];
  const tagRegex = /<(?:think|thought)>([\s\S]*?)<\/(?:think|thought)>/gi;
  if (!tagRegex.test(raw)) {
    return [{ kind: 'text', content: raw, turnIndex }];
  }
  tagRegex.lastIndex = 0;
  const out: Array<{ kind: 'thought' | 'text'; content: string; turnIndex?: number }> = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(raw)) !== null) {
    const textBefore = raw.slice(lastIdx, match.index);
    if (textBefore.trim()) {
      out.push({ kind: 'text', content: textBefore, turnIndex });
    }
    const thoughtContent = match[1]?.trim();
    if (thoughtContent) {
      out.push({ kind: 'thought', content: thoughtContent, turnIndex });
    }
    lastIdx = match.index + match[0].length;
  }
  const textAfter = raw.slice(lastIdx);
  if (textAfter.trim()) {
    out.push({ kind: 'text', content: textAfter, turnIndex });
  }
  return out;
}

/**
 * 构建交错式多步骤时间线（thought / tool_call / text 自然交错）。
 * blocks 可用时严格按 blocks 顺序；否则平滑降级。
 */
export function buildAssistantTimeline(
  msg: SessionMessage
): AssistantTimelineItem[] {
  try {
    const tools = msg.toolCalls || [];
    const toolsById = new Map(tools.map((t) => [t.id, t]));
    const blocks = msg.blocks || [];
    const items: AssistantTimelineItem[] = [];
    let toolBuf: MessageToolCall[] = [];
    let ti = 0;
    let xi = 0;
    let thi = 0;

    const flushTools = () => {
      if (!toolBuf.length) return;
      const rendered = buildToolRenderItems(toolBuf);
      if (rendered.length) {
        items.push({ kind: 'tools', items: rendered, key: `tools-${ti++}` });
      }
      toolBuf = [];
    };

    if (blocks.length > 0) {
      const used = new Set<string>();
      for (const b of blocks) {
        if (b.type === 'thought') {
          flushTools();
          const thoughtContent = (b.content || '').trim();
          if (thoughtContent) {
            items.push({
              kind: 'thought',
              content: thoughtContent,
              id: b.id,
              turnIndex: b.turnIndex,
              durationMs: b.durationMs,
              isStreaming: b.isStreaming,
              isHistoricalCollapsed: b.isHistoricalCollapsed,
              key: `thought-${b.id || (b.turnIndex !== undefined ? `turn-${b.turnIndex}` : thi++)}`,
            });
          }
        } else if (b.type === 'text') {
          flushTools();
          const c = b.content || '';
          if (c.trim()) {
            const parsed = parseInlineThoughtAndText(c, b.turnIndex);
            for (const p of parsed) {
              if (p.kind === 'thought') {
                items.push({
                  kind: 'thought',
                  content: p.content,
                  turnIndex: p.turnIndex,
                  key: `thought-${thi++}`,
                });
              } else {
                items.push({
                  kind: 'text',
                  content: p.content,
                  turnIndex: p.turnIndex,
                  key: `text-${xi++}`,
                });
              }
            }
          }
        } else if (b.type === 'tool_call' && b.id) {
          const tc = toolsById.get(b.id);
          if (tc) {
            toolBuf.push(tc);
            used.add(b.id);
          }
        }
      }
      flushTools();
      const orphan = tools.filter((t) => !used.has(t.id));
      if (orphan.length) {
        const rendered = buildToolRenderItems(orphan);
        if (rendered.length) {
          items.push({ kind: 'tools', items: rendered, key: 'tools-orphan' });
        }
      }
      if (!items.some((i) => i.kind === 'text') && (msg.text || '').trim()) {
        const parsed = parseInlineThoughtAndText(msg.text || '');
        for (const p of parsed) {
          if (p.kind === 'thought') {
            items.push({
              kind: 'thought',
              content: p.content,
              key: `thought-${thi++}`,
            });
          } else {
            items.push({
              kind: 'text',
              content: p.content,
              key: `text-${xi++}`,
            });
          }
        }
      }
      return items;
    }

    // 降级回退（无 blocks 时）
    if (msg.thinkingTurns && msg.thinkingTurns.length > 0) {
      for (const tt of msg.thinkingTurns) {
        if (tt.content?.trim()) {
          items.push({
            kind: 'thought',
            content: tt.content,
            turnIndex: tt.turnIndex,
            durationMs: tt.durationMs,
            key: `thought-turn-${tt.turnIndex}`,
          });
        }
      }
    } else if ((msg.thinking || '').trim()) {
      items.push({
        kind: 'thought',
        content: msg.thinking || '',
        durationMs: msg.thinkingTime ? msg.thinkingTime * 1000 : undefined,
        key: 'thought-legacy',
      });
    }
    if (tools.length) {
      const rendered = buildToolRenderItems(tools);
      if (rendered.length) {
        items.push({ kind: 'tools', items: rendered, key: `tools-0` });
      }
    }
    if ((msg.text || '').trim()) {
      const parsed = parseInlineThoughtAndText(msg.text || '');
      for (const p of parsed) {
        if (p.kind === 'thought') {
          items.push({
            kind: 'thought',
            content: p.content,
            key: `thought-${thi++}`,
          });
        } else {
          items.push({
            kind: 'text',
            content: p.content,
            key: `text-${xi++}`,
          });
        }
      }
    }
    return items;
  } catch {
    if ((msg.text || '').trim()) {
      return [{ kind: 'text', content: msg.text || '', key: 'text-fallback' }];
    }
    return [];
  }
}

/**
 * 助手消息渲染时间线签名（流式 0 重排与状态跃迁缓存击穿）。
 */
export function timelineSignature(msg: SessionMessage): string {
  const isLiveProcessing = msg.status === 'processing';
  const blocks = msg.blocks || [];
  let lastTextIdx = -1;
  let lastThoughtIdx = -1;

  for (let i = blocks.length - 1; i >= 0; i--) {
    if (lastTextIdx === -1 && blocks[i]?.type === 'text') lastTextIdx = i;
    if (lastThoughtIdx === -1 && blocks[i]?.type === 'thought')
      lastThoughtIdx = i;
  }

  const blocksProj = blocks.map((b, i) => {
    if (b.type === 'text') {
      if (i === lastTextIdx) {
        return isLiveProcessing
          ? { t: 'text', last: 1, e: (b.content || '') === '' ? 1 : 0 }
          : { t: 'text', last: 1, c: b.content || '' };
      }
      return { t: 'text', c: b.content || '' };
    }
    if (b.type === 'thought') {
      if (i === lastThoughtIdx && isLiveProcessing) {
        return { t: 'thought', last: 1, e: (b.content || '') === '' ? 1 : 0 };
      }
      return { t: 'thought', c: b.content || '', turn: b.turnIndex };
    }
    return { t: b.type, id: b.id };
  });

  const toolsProj = (msg.toolCalls || []).map((tc) => ({
    id: tc.id,
    n: tc.name,
    s: tc.status,
    o: tc.output,
    a: tc.arguments,
    e: tc.explanation,
    // V1-γ：turnId/startedAt 进签名——同轮并行折叠（≤200ms 判组）依赖这两字段，
    // 不进签名会导致组结构变化被缓存击穿（折叠闭合滞后一帧）。
    t: tc.turnId,
    st: tc.startedAt,
  }));

  const hasExplicitText = blocks.some(
    (b) => b.type === 'text' && (b.content || '').trim().length > 0
  );

  if (blocks.length === 0 || !hasExplicitText) {
    return JSON.stringify({
      b: blocksProj,
      t: toolsProj,
      st: msg.status || 'unknown',
      hasText: Boolean((msg.text || '').trim()),
      txt: isLiveProcessing ? undefined : msg.text || '',
    });
  }

  return JSON.stringify({
    b: blocksProj,
    t: toolsProj,
    st: msg.status || 'unknown',
  });
}

/**
 * 带签名缓存的 timeline 构建。
 * 签名命中（纯文本流式帧）→ 返回上次 timeline 引用（零重建）；
 * 签名失效（工具事件/块结构变化）→ 全量重建。
 */
export function buildAssistantTimelineCached(
  msg: SessionMessage,
  prevSig: string | null,
  prevTimeline: AssistantTimelineItem[] | null
): { sig: string; timeline: AssistantTimelineItem[] } {
  const sig = timelineSignature(msg);
  if (sig === prevSig && prevTimeline) {
    return { sig, timeline: prevTimeline };
  }
  return { sig, timeline: buildAssistantTimeline(msg) };
}
