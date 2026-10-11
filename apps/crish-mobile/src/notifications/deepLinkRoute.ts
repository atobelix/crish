import type { PushTarget } from './types';

/** 深链主 id 优先序（sessionId 锚点优先，其次按事件定位参数） */
const DEEP_LINK_ID_PRIORITY = [
  'toolCallId',
  'runId',
  'taskId',
  'subagentId',
  'timerId',
  'cronId',
] as const;

/** screen → 主定位参数键 */
const SCREEN_PRIMARY_PARAM: Record<string, string> = {
  approval: 'toolCallId',
  session: 'sessionId',
  run: 'runId',
  terminal: 'runId',
  task: 'taskId',
  subagent: 'subagentId',
  timer: 'timerId',
};

/** 深链主 id：按 screen 语义取主定位参数，其次 sessionId 锚点，再次 params 兜底 */
function primaryIdOf(target: PushTarget): string | null {
  const primaryKey = SCREEN_PRIMARY_PARAM[target.screen];
  if (primaryKey) {
    if (primaryKey === 'sessionId' && target.sessionId) return target.sessionId;
    const value = target.params[primaryKey];
    if (value) return value;
  }
  if (target.sessionId) return target.sessionId;
  for (const key of DEEP_LINK_ID_PRIORITY) {
    const value = target.params[key];
    if (value) return value;
  }
  return null;
}

/** target → 深链（crish://<screen>/<id>?<params>，M8 §4.1.2 形态） */
export function buildDeepLinkRoute(target: PushTarget): string | null {
  const screen = target.screen;
  if (!screen) return null;
  const id = primaryIdOf(target);
  // 查询串仅带定位非主 id（如 session 页附带 runId：crish://session/s-7?runId=run-42）
  const runId = target.params.runId;
  const query = runId && runId !== id ? `?runId=${runId}` : '';
  return `crish://${screen}${id ? `/${id}` : ''}${query}`;
}
