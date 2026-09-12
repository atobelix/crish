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
import { isThoughtPlaceholder } from '../markdownRenderLite';
export {
  timelineSignature,
  buildAssistantTimelineCached,
} from './timelineCache';

function pushFallbackTurns(msg: SessionMessage, items: AssistantTimelineItem[]): void {
  if (msg.thinkingTurns && msg.thinkingTurns.length > 0) {
    for (const tt of msg.thinkingTurns) {
      if (tt.content?.trim() && !isThoughtPlaceholder(tt.content)) {
        items.push({
          kind: 'thought',
          content: tt.content,
          turnIndex: tt.turnIndex,
          durationMs: tt.durationMs,
          isStreaming: tt.isStreaming,
          key: `thought-turn-${tt.turnIndex}`,
          startTime: (tt as { startTime?: number }).startTime || msg.timestamp,
        });
      }
    }
  } else if ((msg.thinking || '').trim() && !isThoughtPlaceholder(msg.thinking)) {
    items.push({
      kind: 'thought',
      content: msg.thinking || '',
      durationMs: msg.thinkingTime ? msg.thinkingTime * 1000 : undefined,
      key: 'thought-legacy',
      startTime: msg.timestamp,
    });
  }
}

function pushParsedText(
  text: string,
  turnIndex: number | undefined,
  isStreaming: boolean,
  items: AssistantTimelineItem[],
  thi: { val: number },
  xi: { val: number },
  startTime?: number,
  durationMs?: number
): void {
  const parsed = parseInlineThoughtAndTextSafely(text, turnIndex, isStreaming);
  for (const p of parsed) {
    if (p.kind === 'thought') {
      items.push({
        kind: 'thought',
        content: p.content,
        turnIndex: p.turnIndex,
        isStreaming: p.isStreaming,
        startTime,
        durationMs,
        key: `thought-${thi.val++}`,
      });
    } else {
      items.push({
        kind: 'text',
        content: p.content,
        turnIndex: p.turnIndex,
        startTime,
        durationMs,
        key: `text-${xi.val++}`,
      });
    }
  }
}

/**
 * 构建交错式多步骤时间线（thought / tool_call / context_injection / text 自然交错）。
 */
export function buildAssistantTimeline(
  msg: SessionMessage
): AssistantTimelineItem[] {
  try {
    const tools = msg.toolCalls || [];
    const toolsById = new Map(tools.map((t) => [t.id, t]));
    const injections = msg.injections || [];
    const injectionsById = new Map(injections.map((inj) => [inj.id, inj]));
    let blocks = msg.blocks || [];
    const items: AssistantTimelineItem[] = [];
    let toolBuf: MessageToolCall[] = [];
    let ti = 0;
    const xi = { val: 0 };
    const thi = { val: 0 };

    const flushTools = () => {
      if (!toolBuf.length) return;
      const rendered = buildToolRenderItems(toolBuf);
      if (rendered.length) {
        const firstStartedAt =
          toolBuf.find((t) => t.startedAt != null)?.startedAt ?? msg.timestamp;
        const totalDuration = toolBuf.reduce((acc, t) => {
          const d =
            t.durationMs ??
            (t.finishedAt && t.startedAt && t.finishedAt >= t.startedAt
              ? t.finishedAt - t.startedAt
              : 0);
          return acc + (d > 0 ? d : 0);
        }, 0);
        items.push({
          kind: 'tools',
          items: rendered,
          key: `tools-${ti++}`,
          startTime: firstStartedAt,
          durationMs: totalDuration > 0 ? totalDuration : undefined,
        });
      }
      toolBuf = [];
    };

    if (blocks.length > 0) {
      // 历史误置 thought-legacy 自愈：若存在旧版缺陷生成的 thought-legacy 且落在工具调用之后，移回首位
      const legacyIdx = blocks.findIndex(
        (b) => b.type === 'thought' && b.id === 'thought-legacy'
      );
      if (legacyIdx > 0) {
        blocks = blocks.slice();
        const [legacy] = blocks.splice(legacyIdx, 1);
        blocks.unshift(legacy!);
      }

      const usedTools = new Set<string>();
      const usedInjections = new Set<string>();
      if (!blocks.some((b) => b.type === 'thought')) {
        pushFallbackTurns(msg, items);
      }

      for (const b of blocks) {
        if (b.type === 'context_injection') {
          flushTools();
          const inj = (b.id ? injectionsById.get(b.id) : undefined) || b.injection;
          if (inj) {
            items.push({
              kind: 'injection',
              key: `injection-${inj.id}`,
              injection: inj,
              turnIndex: b.turnIndex,
              startTime: b.startTime,
              durationMs: b.durationMs,
            });
            usedInjections.add(inj.id);
          }
        } else if (b.type === 'thought') {
          flushTools();
          const thoughtContent = (b.content || '').trim();
          const isPlaceholder = isThoughtPlaceholder(thoughtContent);
          if (!isPlaceholder && (thoughtContent || b.isStreaming)) {
            items.push({
              kind: 'thought',
              content: thoughtContent,
              id: b.id,
              turnIndex: b.turnIndex,
              startTime: b.startTime ?? msg.timestamp,
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
            pushParsedText(
              c,
              b.turnIndex,
              Boolean(b.isStreaming),
              items,
              thi,
              xi,
              b.startTime,
              b.durationMs
            );
          }
        } else if (b.type === 'tool_call' && b.id) {
          const tc = toolsById.get(b.id);
          if (tc) {
            if (tc.startedAt == null && b.startTime != null) tc.startedAt = b.startTime;
            if (tc.durationMs == null && b.durationMs != null) tc.durationMs = b.durationMs;
            toolBuf.push(tc);
            usedTools.add(b.id);
          }
        }
      }
      flushTools();

      // 孤儿注入兜底：injections 存在但 blocks 未声明的项，置顶挂载
      const orphanInjections = injections.filter(
        (inj) => !usedInjections.has(inj.id)
      );
      for (const inj of orphanInjections) {
        items.unshift({
          kind: 'injection',
          key: `injection-orphan-${inj.id}`,
          injection: inj,
        });
      }

      const orphan = tools.filter((t) => !usedTools.has(t.id));
      if (orphan.length) {
        const rendered = buildToolRenderItems(orphan);
        if (rendered.length) {
          const firstStartedAt =
            orphan.find((t) => t.startedAt != null)?.startedAt ?? msg.timestamp;
          const totalDuration = orphan.reduce((acc, t) => {
            const d =
              t.durationMs ??
              (t.finishedAt && t.startedAt && t.finishedAt >= t.startedAt
                ? t.finishedAt - t.startedAt
                : 0);
            return acc + (d > 0 ? d : 0);
          }, 0);
          items.push({
            kind: 'tools',
            items: rendered,
            key: 'tools-orphan',
            startTime: firstStartedAt,
            durationMs: totalDuration > 0 ? totalDuration : undefined,
          });
        }
      }
      return applyDurationFallback(msg, items);
    }

    // 历史无 blocks 消息兼容降级：按 injections -> thoughts -> tools -> text 顺序列出
    for (const inj of injections) {
      items.push({ kind: 'injection', key: `injection-${inj.id}`, injection: inj });
    }
    pushFallbackTurns(msg, items);
    if (tools.length) {
      const rendered = buildToolRenderItems(tools);
      if (rendered.length) {
        const firstStartedAt =
          tools.find((t) => t.startedAt != null)?.startedAt ?? msg.timestamp;
        const totalDuration = tools.reduce((acc, t) => {
          const d =
            t.durationMs ??
            (t.finishedAt && t.startedAt && t.finishedAt >= t.startedAt
              ? t.finishedAt - t.startedAt
              : 0);
          return acc + (d > 0 ? d : 0);
        }, 0);
        items.push({
          kind: 'tools',
          items: rendered,
          key: 'tools-0',
          startTime: firstStartedAt,
          durationMs: totalDuration > 0 ? totalDuration : undefined,
        });
      }
    }
    if ((msg.text || '').trim()) {
      pushParsedText(msg.text || '', undefined, msg.status === 'processing', items, thi, xi);
    }
    return applyDurationFallback(msg, items);
  } catch {
    if ((msg.text || '').trim()) {
      return [{ kind: 'text', content: msg.text || '', key: 'text-fallback' }];
    }
    return [];
  }
}

/**
 * 历史/无打点耗时兜底：若全段子项耗时均为 0/undefined，但消息级记录了 thinkingTime（秒），
 * 自动回填给首个过程项，杜绝终态「已完成 0.0 秒」虚假定格。
 */
function applyDurationFallback(
  msg: SessionMessage,
  items: AssistantTimelineItem[]
): AssistantTimelineItem[] {
  const totalRecordedDuration = items.reduce(
    (acc, it) => acc + (it.durationMs || 0),
    0
  );
  if (
    totalRecordedDuration === 0 &&
    typeof msg.thinkingTime === 'number' &&
    msg.thinkingTime > 0
  ) {
    const fallbackMs = Math.round(msg.thinkingTime * 1000);
    const firstProc = items.find(
      (it) => it.kind === 'tools' || it.kind === 'thought'
    );
    if (firstProc) {
      firstProc.durationMs = fallbackMs;
    }
  }
  return enforceThoughtBeforeText(items);
}

/**
 * 物理因果时序守卫：同一轮次内（或未指定轮次时），思考（thought）必定先于正文（text）产生，
 * 严禁因底层 blocks 乱序将同轮次 thought 排在 text 之后。
 */
function enforceThoughtBeforeText(
  items: AssistantTimelineItem[]
): AssistantTimelineItem[] {
  const result = [...items];
  for (let i = 0; i < result.length; i++) {
    const cur = result[i]!;
    if (cur.kind !== 'thought') continue;
    const curTurn = cur.turnIndex;
    // 只有在两块明确指定且处于同一显式轮次时才校准时序；绝不跨步越界重排
    if (curTurn == null) continue;
    const misplacedTextIdx = result.findIndex(
      (it, idx) =>
        idx < i && it.kind === 'text' && it.turnIndex === curTurn
    );
    if (misplacedTextIdx !== -1) {
      // 将此 thought 移到该 text 块之前
      result.splice(i, 1);
      result.splice(misplacedTextIdx, 0, cur);
    }
  }
  return result;
}
