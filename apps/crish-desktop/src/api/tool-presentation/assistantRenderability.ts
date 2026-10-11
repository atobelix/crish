/**
 * S-3（FINAL-PLAN §2）：助手消息「可渲染性」唯一谓词。
 *
 * 与 MessageContent 的渲染分支同源：timeline（buildAssistantTimeline，已经
 * S-2 过滤占位 / 误写入的域文案思考）→ partitionTimelineSegments（非活跃轮）
 * 非空，或降级正文 stripThoughtPlaceholders(text) 非空 ⇒ 可渲染。
 * processing / queued（活跃轮，WorkingStatusIndicator 占位）恒为可渲染。
 * 非 assistant 消息恒为可渲染。
 *
 * 调用方（全部共用本谓词，禁止再写平行判空）：
 * ① 列表展示投影（useChatMessages.projectDisplayMessages）；
 * ② MessageContent 分支 α 的判空；
 * ③ ChatAssistantMessageRow 是否渲染 MessageActions；
 * ④ 间接：lastAssistantId、空态计数（均基于投影后的列表）。
 */
import type { SessionMessage } from '../../store/types';
import { stripThoughtPlaceholders } from '../markdownRenderLite';
import { logInternalError } from '../userFacingErrors';
import { buildAssistantTimeline } from './timelineNormalizer';
import { partitionTimelineSegments } from './timelineSegmenter';

/** 消息对象不可变（store immer 更新换引用）→ 以对象为键缓存判定 */
const cache = new WeakMap<SessionMessage, boolean>();

function computeRenderable(msg: SessionMessage): boolean {
  if (stripThoughtPlaceholders(msg.text || '').trim().length > 0) return true;
  try {
    const timeline = buildAssistantTimeline(msg);
    if (timeline.length === 0) return false;
    const segments = partitionTimelineSegments(msg.id, timeline, false, false, {
      msgTimestamp: msg.timestamp,
      totalTurnDurationSec: msg.thinkingTime,
    });
    return segments.length > 0;
  } catch (err) {
    // 判定失败按可渲染处理（宁可多留一行，不可吞掉内容），并留可观测痕迹
    logInternalError('assistant-renderability', err, { severity: 'warning' });
    return true;
  }
}

export function isRenderableAssistantMessage(msg: SessionMessage): boolean {
  if (msg.sender !== 'assistant') return true;
  if (msg.status === 'processing' || msg.status === 'queued') return true;
  const hit = cache.get(msg);
  if (hit !== undefined) return hit;
  const v = computeRenderable(msg);
  cache.set(msg, v);
  return v;
}
