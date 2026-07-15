/**
 * 会话侧栏相对时间：以用户输入 / 助手回复的最后时间戳为准。
 */

import type { SessionState } from '../store/layoutStore';

/** 会话最近活动毫秒（消息 + 协作 agent） */
export function sessionLastActivityMs(s: SessionState): number {
  let max = 0;
  for (const m of s.messages || []) {
    if (typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && m.timestamp > max) {
      max = m.timestamp;
    }
  }
  for (const a of s.agents || []) {
    if (typeof a.startedAt === 'number' && a.startedAt > max) max = a.startedAt;
    for (const m of a.messages || []) {
      if (typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && m.timestamp > max) {
        max = m.timestamp;
      }
    }
  }
  return max;
}

/** 相对时间文案 */
export function formatRelativeActivity(ms: number, now = Date.now()): string {
  if (!ms || ms <= 0) return '';
  const d = Math.max(0, now - ms);
  if (d < 45_000) return '刚刚';
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}分钟前`;
  if (d < 86_400_000) return `${Math.max(1, Math.floor(d / 3_600_000))}小时前`;
  if (d < 7 * 86_400_000) return `${Math.max(1, Math.floor(d / 86_400_000))}天前`;
  if (d < 30 * 86_400_000) return `${Math.max(1, Math.floor(d / (7 * 86_400_000)))}周前`;
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const day = date.getDate();
  const cy = new Date(now).getFullYear();
  if (y === cy) return `${m}/${day}`;
  return `${y}/${m}/${day}`;
}

/** 侧栏展示用：优先消息时间，否则解析旧的 timestamp 字符串 */
export function formatSessionListTime(s: SessionState, now = Date.now()): string {
  const ms = sessionLastActivityMs(s);
  if (ms > 0) return formatRelativeActivity(ms, now);
  const t = (s.timestamp || '').trim();
  if (!t || t === '远程') return t;
  // 历史字面量「刚刚」但无消息时间 → 仍显示空或字面量
  return t;
}
