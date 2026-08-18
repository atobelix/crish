/**
 * 从引擎 read-session-events 投影本地对话消息（hub re-export）。
 *
 * H2：打开空远程会话时补全文案 / 工具调用。
 * H3：可在此基础上挂 lastSequence 增量同步与 run snapshot usage。
 *
 * 纯结构性拆分（T4-11 R5）：
 * - 事件投影核心 → ./sessionEventProjection
 * - usage 解析 / 累计 → ./sessionEventUsage
 * 本文件保留分页拉取 / hydrate 编排与 SessionHydrateResult 类型，
 * 并 re-export 全部公开符号以保持 import 路径不变。
 */

import type { SessionMessage } from '../store/layoutStore';
import { getTransport } from './transport';
import { logInternalError } from './userFacingErrors';
import { projectEventsToMessages } from './sessionEventProjection';

// 公开符号 re-export（保持消费方 import 路径不变）
export {
  mergeMessagesById,
  projectEventsToMessages,
} from './sessionEventProjection';
export {
  applyUsageDelta,
  fetchRunSnapshotUsage,
  parseRunSnapshotUsage,
  type RunSnapshotUsage,
  type UsageDeltaState,
} from './sessionEventUsage';

export type SessionHydrateResult = {
  ok: boolean;
  messages: SessionMessage[];
  /** 引擎事件游标，供 H3 增量拉取 */
  nextAfterSequence: number;
  hasMore: boolean;
  error?: string;
  /**
   * 水合「未完整」截断标记（P1-D2）：分页拉全超过页数上限或游标停滞
   * （引擎异常 hasMore 恒真）时置位。消费方（store）据此刻画 SessionState
   * hydrateTruncated，persist 熔断禁止截断态正文回写 SQLite（不可逆）。
   */
  truncated?: boolean;
  /** 最近一次 runId（若可解析），供 H3 拉 usage */
  lastRunId?: string;
};

export async function fetchSessionEvents(
  sessionId: string,
  afterSequence = 0,
  maxEvents = 500
): Promise<{
  events: unknown[];
  nextAfterSequence: number;
  hasMore: boolean;
} | null> {
  const transport = getTransport();
  try {
    if (!transport.isReady()) {
      const ok = await transport.waitUntilConnected(10_000);
      if (!ok) return null;
    }
    const res = (await transport.request<Record<string, unknown>>(
      'core_read_session_events',
      { sessionId, afterSequence, maxEvents },
      { timeoutMs: 15_000 }
    )) as Record<string, unknown>;
    const events = Array.isArray(res.events) ? res.events : [];
    const nextAfterSequence =
      typeof res.nextAfterSequence === 'number'
        ? res.nextAfterSequence
        : afterSequence;
    const hasMore = Boolean(res.hasMore);
    return { events, nextAfterSequence, hasMore };
  } catch (e) {
    logInternalError('fetchSessionEvents', e);
    return null;
  }
}

/**
 * hydrate 分页页数上限：50 页 × 800 = 40000 事件。
 * 引擎异常（hasMore 恒真）时在此截止并按「未完整」截断态返回，
 * 防无限翻页拖死会话；截断态由持久化熔断拦截，不会固化回写 SQLite。
 */
export const MAX_HYDRATE_PAGES = 50;

/** hydrate 单页事件数（与 fetchSessionEvents 默认尺寸同源） */
export const HYDRATE_PAGE_SIZE = 800;

export async function hydrateSessionMessagesFromEngine(
  sessionId: string
): Promise<SessionHydrateResult> {
  // P1-D2：消费 hasMore 按 nextAfterSequence 循环翻页直至拉全——
  // 修复前只拉单页 800 事件（R2 §6：hasMore 全仓无消费方），长会话被截断。
  // 各页事件先合并、最后统一 projectEventsToMessages：跨页的同一 assistant
  // 消息（delta/end 分属两页）合并后投影才能正确组装，分页边界不撕裂消息。
  const allEvents: unknown[] = [];
  let cursor = 0;
  let hasMore = false;

  for (let page = 0; page < MAX_HYDRATE_PAGES; page++) {
    const res = await fetchSessionEvents(sessionId, cursor, HYDRATE_PAGE_SIZE);
    if (!res) {
      return {
        ok: false,
        messages: [],
        nextAfterSequence: cursor,
        hasMore,
        error: 'not_connected',
      };
    }
    allEvents.push(...res.events);
    hasMore = res.hasMore;
    if (!hasMore) {
      cursor = Math.max(res.nextAfterSequence, cursor);
      break;
    }
    const next = Math.max(res.nextAfterSequence, cursor);
    if (next <= cursor) {
      // 防御：hasMore=true 但游标不前进 → 引擎状态异常，终止翻页按截断态返回
      break;
    }
    cursor = next;
  }
  // 循环结束后仍 hasMore = 未拉全（页数上限截断或游标停滞）→ 打截断标记
  const truncated = hasMore;

  if (allEvents.length === 0) {
    return {
      ok: true,
      messages: [],
      nextAfterSequence: cursor,
      hasMore,
      ...(truncated ? { truncated } : {}),
    };
  }
  const { messages, lastRunId, maxSequence } =
    projectEventsToMessages(allEvents);
  return {
    ok: true,
    messages,
    nextAfterSequence: Math.max(cursor, maxSequence),
    hasMore,
    ...(truncated ? { truncated } : {}),
    ...(lastRunId !== undefined && { lastRunId }),
  };
}
