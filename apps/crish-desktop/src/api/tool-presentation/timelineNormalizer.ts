/**
 * 工具调用与交错多步骤 Timeline 块规范化门面（timelineNormalizer）。
 *
 * 聚合子模块：
 * - timelineReconciler：三元槽位合并、对齐与规范化；
 * - inlineTagParser：Markdown 栅栏保护与行内标签解析；
 * - timelineCache：时间线签名与缓存；
 * - toolRenderItems：工具渲染项构建与去重。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import type { AssistantTimelineItem } from './toolPresentationTypes';
import { buildToolRenderItems } from './toolRenderItems';
import { parseInlineThoughtAndTextSafely } from './inlineTagParser';

export { buildToolRenderItems, dedupeToolCalls } from './toolRenderItems';
export {
  alignToolCallBlocks,
  reconcileAssistantMessageBlocks,
  normalizeAssistantTimeline,
} from './timelineReconciler';
export {
  parseInlineThoughtAndTextSafely,
  parseInlineThoughtAndText,
  type ParsedInlineItem,
} from './inlineTagParser';
export {
  timelineSignature,
  buildAssistantTimelineCached,
} from './timelineCache';

function pushFallbackTurns(msg: SessionMessage, items: AssistantTimelineItem[]): void {
  if (msg.thinkingTurns && msg.thinkingTurns.length > 0) {
    for (const tt of msg.thinkingTurns) {
      if (tt.content?.trim() || tt.isStreaming) {
        items.push({
          kind: 'thought',
          content: tt.content,
          turnIndex: tt.turnIndex,
          durationMs: tt.durationMs,
          isStreaming: tt.isStreaming,
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
}

function pushParsedText(
  text: string,
  turnIndex: number | undefined,
  isStreaming: boolean,
  items: AssistantTimelineItem[],
  thi: { val: number },
  xi: { val: number }
): void {
  const parsed = parseInlineThoughtAndTextSafely(text, turnIndex, isStreaming);
  for (const p of parsed) {
    if (p.kind === 'thought') {
      items.push({
        kind: 'thought',
        content: p.content,
        turnIndex: p.turnIndex,
        isStreaming: p.isStreaming,
        key: `thought-${thi.val++}`,
      });
    } else {
      items.push({
        kind: 'text',
        content: p.content,
        turnIndex: p.turnIndex,
        key: `text-${xi.val++}`,
      });
    }
  }
}

/**
 * 构建交错式多步骤时间线（thought / tool_call / text 自然交错）。
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
    const xi = { val: 0 };
    const thi = { val: 0 };

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
      if (!blocks.some((b) => b.type === 'thought')) {
        pushFallbackTurns(msg, items);
      }

      for (const b of blocks) {
        if (b.type === 'thought') {
          flushTools();
          const thoughtContent = (b.content || '').trim();
          if (thoughtContent || b.isStreaming) {
            items.push({
              kind: 'thought',
              content: thoughtContent,
              id: b.id,
              turnIndex: b.turnIndex,
              durationMs: b.durationMs,
              isStreaming: b.isStreaming,
              isHistoricalCollapsed: b.isHistoricalCollapsed,
              key: `thought-${b.id || (b.turnIndex !== undefined ? `turn-${b.turnIndex}` : thi.val++)}`,
            });
          }
        } else if (b.type === 'text') {
          flushTools();
          const c = b.content || '';
          if (c.trim() || b.isStreaming) {
            pushParsedText(c, b.turnIndex, Boolean(b.isStreaming), items, thi, xi);
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
        pushParsedText(msg.text || '', undefined, msg.status === 'processing', items, thi, xi);
      }
      return items;
    }

    pushFallbackTurns(msg, items);
    if (tools.length) {
      const rendered = buildToolRenderItems(tools);
      if (rendered.length) {
        items.push({ kind: 'tools', items: rendered, key: 'tools-0' });
      }
    }
    if ((msg.text || '').trim()) {
      pushParsedText(msg.text || '', undefined, msg.status === 'processing', items, thi, xi);
    }
    return items;
  } catch {
    if ((msg.text || '').trim()) {
      return [{ kind: 'text', content: msg.text || '', key: 'text-fallback' }];
    }
    return [];
  }
}
