/**
 * 时间线签名与缓存管理（timelineCache）。
 *
 * 核心能力：
 * 1. timelineSignature：计算流式 0 重排签名，避免纯文本流式帧破坏 React.memo；
 * 2. buildAssistantTimelineCached：带签名缓存的 timeline 构建，签名命中返回上次引用。
 */

import type { SessionMessage } from '../../store/layoutStore';
import type { AssistantTimelineItem } from './toolPresentationTypes';
import { buildAssistantTimeline } from './timelineNormalizer';

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
    t: tc.turnId,
    st: tc.startedAt,
  }));

  // 注入项投影：id:status:tokenEstimate 编入签名——注入状态跃迁（pending→injected）
  // 或 token 估算变化精确失效局部缓存；纯文本流式帧不含本字段，保持 memo 稳定命中。
  const injProj = (msg.injections || []).map((inj) => ({
    id: inj.id,
    s: inj.status,
    te: inj.tokenEstimate ?? 0,
  }));

  const hasExplicitText = blocks.some(
    (b) => b.type === 'text' && (b.content || '').trim().length > 0
  );

  if (blocks.length === 0 || !hasExplicitText) {
    return JSON.stringify({
      b: blocksProj,
      t: toolsProj,
      i: injProj,
      st: msg.status || 'unknown',
      hasText: Boolean((msg.text || '').trim()),
      txt: isLiveProcessing ? undefined : msg.text || '',
    });
  }

  return JSON.stringify({
    b: blocksProj,
    t: toolsProj,
    i: injProj,
    st: msg.status || 'unknown',
  });
}

/**
 * 带签名缓存的 timeline 构建。
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
