/**
 * apps/crish-desktop/src/components/chat-message-list/chatTimeSeparatorLib.ts
 *
 * 时间分隔行口径（批 B ㉑）：消息流内相邻呈现间隔 ≥ 5 分钟才出一条居中
 * 时间分隔行。数据面现成（SessionMessage.timestamp，epoch ms），本模块
 * 只做「哪些消息挂分隔行」的纯函数裁决，呈现见 ChatTimeSeparator。
 *
 * 裁决规则：
 * - 首条带有效时间戳的消息挂一行（会话起点时间）；
 * - 其后一条消息与「上一条已挂分隔行」的消息间隔 ≥ 5 分钟时挂行，
 *   未达阈值不挂、也不更新基准——保证任意相邻两条分隔行之间 ≥ 5 分钟，
 *   且一条分隔行代表的静默期真实 ≥ 5 分钟；
 * - 上下文状态载体消息（isContextStateCarrierMessage）不挂行、也不入链
 *   （与 ChatMessageList 的呈现过滤同口径，避免双轨）；
 * - 时间戳缺失 / 非法 / 不递增（≤ 基准）的消息不挂行、不更新基准。
 *
 * 与既有日期呈现的关系：桌面消息流此前没有日界/日期分隔组件（仅入口
 * 动画以日期作 key），本行是唯一时间分隔呈现，不存在双轨。
 */

import type { SessionMessage } from '../../store/types';
// 判定唯一定义在 store/sessionInjectionMount（门禁 G-17：禁止平行实现）；
// 直引定义模块——storeAccess / contextStateUtils 均只是转出门面，且本模块
// 只需这一个纯函数，不拉起 store 图。
import { isContextStateCarrierMessage } from '../../store/sessionInjectionMount';

/** 相邻分隔行的最小间隔（5 分钟） */
export const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

/**
 * 计算挂分隔行的消息集合：messageId → 该消息时间戳（呈现层据此格式化）。
 */
export function computeTimeSeparatorHosts(
  messages: readonly SessionMessage[]
): Map<string, number> {
  const hosts = new Map<string, number>();
  let lastShownTs: number | null = null;
  for (const msg of messages) {
    if (isContextStateCarrierMessage(msg)) continue;
    const ts = msg.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
    if (lastShownTs === null) {
      hosts.set(msg.id, ts);
      lastShownTs = ts;
      continue;
    }
    if (ts - lastShownTs >= TIME_SEPARATOR_GAP_MS) {
      hosts.set(msg.id, ts);
      lastShownTs = ts;
    }
  }
  return hosts;
}
