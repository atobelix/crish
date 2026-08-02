/**
 * 撤回范围聚合：从目标用户消息开始，收集后续所有消息及其 FileDiff。
 *
 * 撤回语义：撤回某条用户消息 = 删除该消息及之后所有消息（与 withdrawMessage 截断一致）。
 * 文件还原：对范围内每条助手消息调用 collectMessageDiffs，聚合 FileDiff（按时间正序）。
 *
 * 输出供 UI（WithdrawConfirmDialog）展示 + reverseFileDiffsToDisk 还原。
 *
 * @see collectMessageDiffs 单消息 diff 聚合
 * @see reverseFileDiffsToDisk 反向应用
 * @see withdrawMessage 截断消息
 */

import type { FileDiff, SessionMessage, SessionState } from '../store/types';
import { collectMessageDiffs } from '../components/diff/ChangeOverviewCard';
import { filterPublishableDiffs } from './publishToolDiffs';

export type RewindScopeSummary = {
  /** 触发撤回的用户消息 id */
  targetMessageId: string;
  /** 将被删除的消息总数（含目标用户消息本身） */
  messageCount: number;
  /** 将被删除的用户消息数 */
  userMessageCount: number;
  /** 将被删除的助手消息数 */
  assistantMessageCount: number;
  /** 最后一条被撤回的用户消息文本（用于回填输入框） */
  lastUserMessageText: string;
  /** 受影响的 FileDiff 列表（按消息时间正序） */
  fileDiffs: FileDiff[];
  /** 受影响的文件路径去重列表 */
  filePaths: string[];
};

/**
 * 从 targetMessageId 开始到会话末尾，聚合撤回范围。
 *
 * @param session 会话状态
 * @param targetMessageId 用户点击撤回的消息 id
 * @returns 范围摘要；找不到目标消息返回 null
 */
export function collectRewindScope(
  session: SessionState | undefined | null,
  targetMessageId: string
): RewindScopeSummary | null {
  if (!session?.messages?.length) return null;
  const idx = session.messages.findIndex((m) => m.id === targetMessageId);
  if (idx === -1) return null;

  const affected = session.messages.slice(idx);
  if (!affected.length) return null;

  let userCount = 0;
  let assistantCount = 0;
  let lastUserText = '';
  const diffs: FileDiff[] = [];

  for (const msg of affected) {
    if (msg.sender === 'user') {
      userCount++;
      if (msg.text) lastUserText = msg.text;
    } else if (msg.sender === 'assistant') {
      assistantCount++;
      // 仅助手消息可能含工具调用 → FileDiff
      const msgDiffs = collectMessageDiffs(msg);
      if (msgDiffs.length) diffs.push(...msgDiffs);
    }
  }

  // 过滤可发布 diff（与变更面板一致门槛），去重同 path
  const publishable = filterPublishableDiffs(diffs);
  const pathSet = new Set<string>();
  for (const d of publishable) {
    if (d.filePath) pathSet.add(d.filePath);
  }

  return {
    targetMessageId,
    messageCount: affected.length,
    userMessageCount: userCount,
    assistantMessageCount: assistantCount,
    lastUserMessageText: lastUserText,
    fileDiffs: publishable,
    filePaths: [...pathSet],
  };
}

/**
 * 从 SessionMessage 列表直接聚合（供测试与无 session 引用时使用）。
 */
export function collectRewindScopeFromMessages(
  messages: SessionMessage[],
  targetMessageId: string
): RewindScopeSummary | null {
  if (!messages?.length) return null;
  const idx = messages.findIndex((m) => m.id === targetMessageId);
  if (idx === -1) return null;
  const affected = messages.slice(idx);
  let userCount = 0;
  let assistantCount = 0;
  let lastUserText = '';
  const diffs: FileDiff[] = [];
  for (const msg of affected) {
    if (msg.sender === 'user') {
      userCount++;
      if (msg.text) lastUserText = msg.text;
    } else if (msg.sender === 'assistant') {
      assistantCount++;
      const msgDiffs = collectMessageDiffs(msg);
      if (msgDiffs.length) diffs.push(...msgDiffs);
    }
  }
  const publishable = filterPublishableDiffs(diffs);
  const pathSet = new Set<string>();
  for (const d of publishable) {
    if (d.filePath) pathSet.add(d.filePath);
  }
  return {
    targetMessageId,
    messageCount: affected.length,
    userMessageCount: userCount,
    assistantMessageCount: assistantCount,
    lastUserMessageText: lastUserText,
    fileDiffs: publishable,
    filePaths: [...pathSet],
  };
}
