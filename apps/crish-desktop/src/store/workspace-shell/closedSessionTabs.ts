/**
 * 记录用户手动关闭的会话标签，防止冷启动或刷新时布局树自动把已关标签复活重开。
 */

import { safeGetJson, safeSetJson } from '../../api/localStorageApi';

const CLOSED_SESSION_TABS_KEY = 'crish_closed_session_tabs_v1';
const MAX_CLOSED_RECORDS = 200;

function readClosedTabsSet(): Set<string> {
  const list = safeGetJson<unknown>(CLOSED_SESSION_TABS_KEY, []);
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((x): x is string => typeof x === 'string'));
}

function writeClosedTabsSet(set: Set<string>): void {
  safeSetJson(
    CLOSED_SESSION_TABS_KEY,
    Array.from(set).slice(-MAX_CLOSED_RECORDS)
  );
}

/** 用户手动关闭了该会话标签 */
export function recordClosedSessionTab(sessionId: string): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;
  const set = readClosedTabsSet();
  set.add(sid);
  writeClosedTabsSet(set);
}

/** 用户主动打开了该会话标签（撤销关闭标记） */
export function unrecordClosedSessionTab(sessionId: string): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;
  const set = readClosedTabsSet();
  if (set.delete(sid)) {
    writeClosedTabsSet(set);
  }
}

/** 判断该会话标签是否由用户显式关闭过 */
export function isSessionTabClosed(sessionId: string): boolean {
  const sid = (sessionId || '').trim();
  if (!sid) return false;
  return readClosedTabsSet().has(sid);
}
