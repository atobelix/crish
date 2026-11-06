/**
 * apps/crish-desktop/src/components/chat-tool-call/headerTickerUtils.ts
 *
 * 组标题行意图 Ticker 纯逻辑工具函数（F3 任务 B & J9 零统计裁决）。
 * 职责：
 * 1. 提取宏观组标题与组内各工具的微观意图；
 * 2. 剥离 Markdown 引用链接语法（cleanIntent）；
 * 3. 执行严格去重：若组标题与首个工具意图相同，不重复展示；
 * 4. 缺失 intent 时按 D4 规范回退至 toolDisplayName。
 */

import type { MessageToolCall } from '../../store/types';
import { cleanIntent, toolDisplayName } from '../../api/toolPresentation';

export interface TickerItem {
  readonly id: string;
  readonly text: string;
  /** thought = 运行时当前思考行（2026-11-06 裁决第 9 条：思考与工具活动共用 ticker 一条动态面） */
  readonly kind: 'title' | 'intent' | 'thought';
  readonly status: 'running' | 'success' | 'error' | 'pending';
  readonly toolId?: string;
}

export type HeaderTickerItem = TickerItem;

/**
 * 构建组标题行轮播条目列表（SSOT 纯函数）。
 * @param groupTitle 宏观组标题
 * @param tools 组内工具列表
 */
export function buildTickerItems(
  groupTitle?: string | null,
  tools?: readonly MessageToolCall[] | null
): TickerItem[] {
  const list = tools || [];
  const cleanedTitle = cleanIntent(groupTitle || '').trim();

  // 单工具组或空组：单项直出，零复读
  if (list.length <= 1) {
    const single = list[0];
    if (!single) {
      return [
        {
          id: 'macro-title',
          text: cleanedTitle || '处理过程',
          kind: 'title',
          status: 'success',
        },
      ];
    }
    const singleIntent =
      cleanIntent(single.intent) || toolDisplayName(single.name);
    const text = cleanedTitle || singleIntent || '处理过程';
    const status =
      single.status === 'pending_approval'
        ? 'pending'
        : (single.status as 'running' | 'success' | 'error' | 'pending') ||
          'success';
    return [
      {
        id: single.id || 'single-title',
        text,
        kind: 'title',
        status,
        toolId: single.id,
      },
    ];
  }

  const items: TickerItem[] = [];

  // 1. 首项：宏观组标题
  if (cleanedTitle) {
    items.push({
      id: 'macro-title',
      text: cleanedTitle,
      kind: 'title',
      status: 'success',
    });
  }

  // 2. 后续项：微观意图序列（过滤与首项组标题字面相同的首个工具）
  list.forEach((t, idx) => {
    const rawIntent = cleanIntent(t.intent) || toolDisplayName(t.name);
    if (!rawIntent) return;
    if (rawIntent === cleanedTitle && idx === 0) return;
    const status =
      t.status === 'pending_approval'
        ? 'pending'
        : (t.status as 'running' | 'success' | 'error' | 'pending') ||
          'success';
    items.push({
      id: t.id,
      text: rawIntent,
      kind: 'intent',
      status,
      toolId: t.id,
    });
  });

  return items.length > 0
    ? items
    : [
        {
          id: 'fallback',
          text: cleanedTitle || '处理过程',
          kind: 'title',
          status: 'success',
        },
      ];
}

export const extractHeaderTickerItems = buildTickerItems;
