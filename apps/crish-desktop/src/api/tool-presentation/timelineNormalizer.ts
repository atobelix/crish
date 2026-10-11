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
import {
  isLegacyDomainNoticeThought,
  logInternalError,
} from '../userFacingErrors';
import { timelineSignature } from './timelineCache';
export { timelineSignature } from './timelineCache';

/**
 * S-2：非内容思考（流式占位 / 误写入 thinking 的域文案），不产出 thought 项。
 * 本文件全部 thought 入口统一经此判定。
 */
export function isNonContentThought(text: string | undefined | null): boolean {
  return isThoughtPlaceholder(text ?? '') || isLegacyDomainNoticeThought(text);
}

function pushFallbackTurns(msg: SessionMessage, items: AssistantTimelineItem[]): void {
  if (msg.thinkingTurns && msg.thinkingTurns.length > 0) {
    for (const tt of msg.thinkingTurns) {
      if (tt.content?.trim() && !isNonContentThought(tt.content)) {
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
  } else if ((msg.thinking || '').trim() && !isNonContentThought(msg.thinking)) {
    items.push({
      kind: 'thought',
      content: msg.thinking || '',
      durationMs: undefined,
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
      if (!p.isStreaming && isNonContentThought(p.content)) continue;
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
          const isPlaceholder = isNonContentThought(thoughtContent);
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
          const found = toolsById.get(b.id);
          if (found) {
            // 【只读铁律】store 里的消息对象经 immer auto-freeze 后为只读；
            // 渲染期严禁原地 mutate —— 否则 ES module 严格模式抛
            // `TypeError: Cannot add property ... object is not extensible`，
            // 被本函数 catch 吞掉后静默降级为「只渲染正文」，导致思考行与
            // 工具块整体消失（2026-09-19 真实宿主实证）。
            // 需要补齐时间戳时构造新对象，绝不改写入参。
            const needStartedAt = found.startedAt == null && b.startTime != null;
            const needDuration = found.durationMs == null && b.durationMs != null;
            const tc =
              needStartedAt || needDuration
                ? {
                    ...found,
                    ...(needStartedAt ? { startedAt: b.startTime } : {}),
                    ...(needDuration ? { durationMs: b.durationMs } : {}),
                  }
                : found;
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
  } catch (err) {
    // 静默降级 = 用户可见的内容丢失（最忌讳级）。必须留可观测痕迹，
    // 否则「思考行 / 工具块整体消失」会被长期误判为渲染层问题。
    logInternalError('timeline-build-degraded', err, { severity: 'warning' });
    if ((msg.text || '').trim()) {
      return [{ kind: 'text', content: msg.text || '', key: 'text-fallback' }];
    }
    return [];
  }
}

/** 带签名缓存的 timeline 构建。 */
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

/**
 * 时序与耗时校准：思考项耗时（durationMs）严格代表思考自身的内部耗时，
 * 严禁以整轮工作耗时（msg.thinkingTime）覆盖；整轮工作时间统一由 timelineSegmenter 在分段层呈现。
 *
 * 原生因果铁律：原生 blocks/items 到达顺序即为唯一真相源，严禁任何跨项跨轮重排。
 */
function applyDurationFallback(
  _msg: SessionMessage,
  items: AssistantTimelineItem[]
): AssistantTimelineItem[] {
  return items;
}
