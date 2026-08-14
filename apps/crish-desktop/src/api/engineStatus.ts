/**
 * get-status 投影：活动 run / 待审批（H2 运行条）。
 * H3 可扩展：把 activeRuns[].runId 接到 get-run-snapshot 用量。
 */

import { getTransport } from './transport';
import { logInternalError } from './userFacingErrors';

export type ActiveRunInfo = {
  runId: string;
  prompt?: string;
  status?: string;
  startedAt?: string | number;
  cwd?: string;
  sessionId?: string;
};

export type PendingApprovalInfo = {
  toolCallId?: string;
  toolName?: string;
  summary?: string;
  runId?: string;
};

export type EngineLiveStatus = {
  ok: boolean;
  connected: boolean;
  activeRuns: ActiveRunInfo[];
  pendingApprovals: PendingApprovalInfo[];
  /** 当前 run 的 trace_id（core_get_status.traceId 投影；S2 分布式追踪
   * 最小面——排障关联键，不进 UI 文案；无活动 run = undefined） */
  traceId?: string;
  error?: string;
  raw?: Record<string, unknown>;
};

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export async function fetchEngineLiveStatus(): Promise<EngineLiveStatus> {
  const transport = getTransport();
  if (!transport.isReady()) {
    const ready = await transport.waitUntilConnected(6_000);
    if (!ready) {
      return {
        ok: false,
        connected: false,
        activeRuns: [],
        pendingApprovals: [],
        error: 'not_connected',
      };
    }
  }

  try {
    const res = (await transport.request<Record<string, unknown>>(
      'core_get_status',
      {},
      { timeoutMs: 8_000 }
    )) as Record<string, unknown>;

    const activeRuns: ActiveRunInfo[] = asArr(res.activeRuns)
      .map((r) => {
        const o = asRec(r);
        if (!o) return null;
        const runId = String(o.runId ?? o.id ?? '');
        if (!runId) return null;
        return {
          runId,
          prompt: typeof o.prompt === 'string' ? o.prompt : undefined,
          status: typeof o.status === 'string' ? o.status : undefined,
          startedAt: (o.startedAt as string | number) ?? undefined,
          cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
        };
      })
      .filter(Boolean) as ActiveRunInfo[];

    const pendingApprovals: PendingApprovalInfo[] = asArr(res.pendingApprovals)
      .map((a) => {
        const o = asRec(a);
        if (!o) return null;
        return {
          toolCallId:
            typeof o.toolCallId === 'string'
              ? o.toolCallId
              : typeof o.id === 'string'
                ? o.id
                : undefined,
          toolName: typeof o.toolName === 'string' ? o.toolName : undefined,
          summary: typeof o.summary === 'string' ? o.summary : undefined,
          runId: typeof o.runId === 'string' ? o.runId : undefined,
        };
      })
      .filter(Boolean) as PendingApprovalInfo[];

    return {
      ok: true,
      connected: true,
      activeRuns,
      pendingApprovals,
      // S2：当前 run trace_id 投影（None/非字符串 → undefined 缺省）
      traceId: typeof res.traceId === 'string' ? res.traceId : undefined,
      raw: res,
    };
  } catch (e) {
    logInternalError('fetchEngineLiveStatus', e);
    return {
      ok: false,
      connected: transport.isReady(),
      activeRuns: [],
      pendingApprovals: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
