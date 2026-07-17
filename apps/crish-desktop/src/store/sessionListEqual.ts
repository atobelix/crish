/**
 * 侧栏列表 equality：流式改 message 正文时 sessions 数组引用会变，
 * 但侧栏只关心壳字段；无搜索时忽略 messages 正文抖动。
 *
 * 活动时间：纳入末条消息 / agent 起止的轻量 ms，保证排序与相对时间源更新，
 * 但不因 stream 改 text 触发重渲。
 */
import type { SessionState } from './types';
import { sessionActivityShellMs } from '../api/sessionTime';

/** 是否仍有 processing 消息（侧栏「处理中」角标） */
function hasProcessingMessage(s: SessionState): boolean {
  const messages = s.messages;
  if (!messages?.length) return false;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.status === 'processing') return true;
  }
  return false;
}

/** agents 轻量指纹：长度 + id/status/description（不含 agent 消息正文） */
function agentsShellFingerprint(s: SessionState): string {
  const agents = s.agents;
  if (!agents?.length) return '';
  let out = String(agents.length);
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    out += '\u0001' + (a?.id || '') + ':' + (a?.status || '') + ':' + (a?.description || '');
  }
  return out;
}

/** 列表壳字段是否一致（忽略 messages 正文 / tool 高频字段） */
export function sessionShellEqual(a: SessionState, b: SessionState): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.isPinned === b.isPinned &&
    a.isArchived === b.isArchived &&
    a.folder === b.folder &&
    // SessionState 用 timestamp（ISO/相对展示用），无独立 updatedAt
    a.timestamp === b.timestamp &&
    (a.branchParentId || '') === (b.branchParentId || '') &&
    (a.messages?.length ?? 0) === (b.messages?.length ?? 0) &&
    hasProcessingMessage(a) === hasProcessingMessage(b) &&
    agentsShellFingerprint(a) === agentsShellFingerprint(b) &&
    // 末条活动时间：排序键 / 相对时间源；stream 改 text 不改 timestamp
    sessionActivityShellMs(a) === sessionActivityShellMs(b)
  );
}

/**
 * 会话数组 equality。
 * @param needMessageBodies 搜索消息正文时为 true：退回引用比较（有引用变化就更新）
 */
export function sidebarSessionsEqual(
  a: SessionState[],
  b: SessionState[],
  needMessageBodies = false,
): boolean {
  if (a === b) return true;
  if (needMessageBodies) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sessionShellEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

// 兼容别名（worker / 文档中的命名）
export const sessionsShellEqual = (
  a: SessionState[] | undefined,
  b: SessionState[] | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return sidebarSessionsEqual(a, b, false);
};

export const sessionsSidebarEqual = (
  a: SessionState[] | undefined,
  b: SessionState[] | undefined,
  searching = false,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return sidebarSessionsEqual(a, b, searching);
};

export function sessionShellFingerprint(s: SessionState): string {
  return [
    s.id,
    s.title ?? '',
    s.folder ?? '',
    s.isPinned ? '1' : '0',
    s.isArchived ? '1' : '0',
    s.branchParentId ?? '',
    s.timestamp ?? '',
    String(s.messages?.length ?? 0),
    hasProcessingMessage(s) ? '1' : '0',
    agentsShellFingerprint(s),
    String(sessionActivityShellMs(s)),
  ].join('\u0001');
}
