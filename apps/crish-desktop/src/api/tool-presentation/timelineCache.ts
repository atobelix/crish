/**
 * 时间线签名与缓存管理（timelineCache）。
 *
 * 核心能力：
 * 1. timelineSignature：计算流式 0 重排签名，避免纯文本流式帧破坏 React.memo；
 * 2. buildAssistantTimelineCached：带签名缓存的 timeline 构建，签名命中返回上次引用；
 * 3. D7.5 子块签名缓存：历史 text/thought 块的投影摘要按内容引用缓存，
 *    尾块变更时不重算历史块——O(delta) 而非 O(全文)。
 */

import type { SessionMessage } from '../../store/layoutStore';
import type { AssistantTimelineItem } from './toolPresentationTypes';
import { buildAssistantTimeline } from './timelineNormalizer';

/**
 * 历史块投影摘要缓存（cacheKey → 投影 JSON 片段）。
 * 流式帧只重算尾块；历史块命中缓存。
 * 有界：超限时整 clear（与 thought stripper 整 clear 同法，禁无界增长）。
 */
const HIST_PROJ_CACHE_LIMIT = 4096;
const histProjCache = new Map<string, string>();

function histTextProj(content: string): string {
  const cached = histProjCache.get(content);
  if (cached !== undefined) return cached;
  const proj = JSON.stringify({ t: 'text', c: content });
  if (histProjCache.size >= HIST_PROJ_CACHE_LIMIT) {
    histProjCache.clear();
  }
  histProjCache.set(content, proj);
  return proj;
}

function histThoughtProj(content: string, turnIndex: number | undefined): string {
  const cacheKey = 'thought|' + String(turnIndex ?? '') + '|' + content;
  const cached = histProjCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const proj = JSON.stringify({ t: 'thought', c: content, turn: turnIndex });
  if (histProjCache.size >= HIST_PROJ_CACHE_LIMIT) {
    histProjCache.clear();
  }
  histProjCache.set(cacheKey, proj);
  return proj;
}

/**
 * 助手消息渲染时间线签名（流式 0 重排与状态跃迁缓存击穿）。
 *
 * D7.5：历史 text/thought 块走子块摘要缓存；尾块（last）瞬时投影。
 * 纯文本流式帧（仅尾块增长、status 保持 processing）签名恒等 → timeline 引用稳定。
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

  // 历史块投影走子块缓存（避免每帧 stringify 全文内容）
  const blockParts: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]!;
    if (b.type === 'text') {
      if (i === lastTextIdx) {
        blockParts.push(
          isLiveProcessing
            ? JSON.stringify({
                t: 'text',
                last: 1,
                e: (b.content || '') === '' ? 1 : 0,
              })
            : JSON.stringify({ t: 'text', last: 1, c: b.content || '' })
        );
      } else {
        blockParts.push(histTextProj(b.content || ''));
      }
      continue;
    }
    if (b.type === 'thought') {
      if (i === lastThoughtIdx && isLiveProcessing) {
        blockParts.push(
          JSON.stringify({
            t: 'thought',
            last: 1,
            e: (b.content || '') === '' ? 1 : 0,
          })
        );
      } else {
        blockParts.push(histThoughtProj(b.content || '', b.turnIndex));
      }
      continue;
    }
    if (b.type === 'context_injection') {
      const inj = b.injection;
      blockParts.push(
        JSON.stringify({
          t: b.type,
          id: b.id,
          s: inj?.status,
          m: (inj?.metadata?.mode as string) || '',
          mod: (inj?.metadata?.model as string) || '',
          th: (inj?.metadata?.thinking as string) || '',
          ti: inj?.title || '',
          su: inj?.summary || '',
        })
      );
      continue;
    }
    blockParts.push(JSON.stringify({ t: b.type, id: b.id }));
  }

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

  // 注入项投影：id:status:tokenEstimate 及 metadata 编入签名——注入状态跃迁或原地更新精确失效局部缓存
  const injProj = (msg.injections || []).map((inj) => ({
    id: inj.id,
    s: inj.status,
    te: inj.tokenEstimate ?? 0,
    m: (inj.metadata?.mode as string) || '',
    mod: (inj.metadata?.model as string) || '',
    th: (inj.metadata?.thinking as string) || '',
    ti: inj.title || '',
    su: inj.summary || '',
  }));

  const hasExplicitText = blocks.some(
    (b) => b.type === 'text' && (b.content || '').trim().length > 0
  );

  // 历史块走子块缓存后，签名尾部统一用数组 join（O(块数) 而非 O(全文)）
  const blocksSig = '[' + blockParts.join(',') + ']';

  if (blocks.length === 0 || !hasExplicitText) {
    return JSON.stringify({
      b: blocksSig,
      t: toolsProj,
      i: injProj,
      st: msg.status || 'unknown',
      hasText: Boolean((msg.text || '').trim()),
      txt: isLiveProcessing ? undefined : msg.text || '',
    });
  }

  return JSON.stringify({
    b: blocksSig,
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