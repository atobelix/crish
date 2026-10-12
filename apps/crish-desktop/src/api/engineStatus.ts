/**
 * get-status 投影：活动 run / 待审批（H2 运行条）+ T5-1 引擎崩溃感知。
 *
 * T5-1（决策 6 承载点）：`fetchEngineLiveStatus` 既是数据轮询也是**心跳
 * 底座**——当 `transport.isReady()`（命令面已建立）且 `core_get_status`
 * 在既定超时（8s）内**连续 [ENGINE_CRASH_PROBE_THRESHOLD] 次失败/超时**，
 * 即判定「引擎探活失败」→ `errorStore.connectionStatus` 迁移到
 * `engine_crashed`（「引擎无响应/已崩溃」呈现 + 自动重连入口）。
 * - 防误报：仅 transport 已就绪才升高警戒；瞬时抖动沿用 TauriTransport
 *   内部「error 视为暂态重试一次」；连续 N 次才判死。
 * - 恢复：探活成功且当前为 `engine_crashed` → 回 `connected`（心跳本身
 *   即证明引擎存活；eventBus `ready` 相位覆盖其余恢复路径）。
 * - 崩溃台账（T5-1b）：一并读取 `core_get_status.lastCrash`，发现较上次
 *   查询**新增**崩溃文件 → errorStore 记录「检测到一次引擎崩溃
 *   （crash-xxx.log）」（进程内 panic 后进程仍活的形态；进程挂形态由
 *   心跳判死兜底）。
 * - engineReady 不再被当作崩溃真源（假就绪：仅 provider 配置三件套
 *   齐备，非运行时健康探针——Rust 侧注释同步修正）。
 */

import { getTransport } from './transport';
import { logInternalError, isEngineCrashishError } from './userFacingErrors';
import { errorStore } from '../services/ErrorStore';

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

/** T5-1b：崩溃台账条目（core_get_status.lastCrash 投影） */
export type EngineCrashInfo = {
  /** 崩溃文件名（`crash-YYYYMMDD-HHMMSS-<thread>.log`） */
  fileName?: string;
  /** 崩溃时刻（epoch ms） */
  timestampMs?: number;
};

export type EngineLiveStatus = {
  ok: boolean;
  connected: boolean;
  activeRuns: ActiveRunInfo[];
  pendingApprovals: PendingApprovalInfo[];
  /** 当前 run 的 trace_id（core_get_status.traceId 投影；S2 分布式追踪
   * 最小面——排障关联键，不进 UI 文案；无活动 run = undefined） */
  traceId?: string;
  /** T5-1b：进程内最近崩溃标记（无崩溃 = undefined） */
  crash?: EngineCrashInfo;
  error?: string;
  raw?: Record<string, unknown>;
};

/** T5-1：心跳判死阈值（连续失败/超时 N 次 → 引擎探活失败；从 2 提升至 5，防本地模型推理/高负载暂态超时误判崩溃） */
export const ENGINE_CRASH_PROBE_THRESHOLD = 5;

/** T5-1：心跳失败连续计数（模块级；成功归零） */
const heartbeatFailStreak = { count: 0 };

/** T5-1b：上次已上报的崩溃文件（模块级；发现新增崩溃文件才上报） */
const lastReportedCrash = { fileName: '' };

/**
 * T5-1：心跳判定状态复位（测试隔离用；生产路径不调用——失败计数与
 * 崩溃台账是累积事实源，复位只应在测试 beforeEach 中执行）。
 */
export function resetEngineHeartbeatForTests(): void {
  heartbeatFailStreak.count = 0;
  lastReportedCrash.fileName = '';
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** T5-1b：lastCrash wire → EngineCrashInfo 投影（形状漂移 → undefined 缺省） */
function projectCrash(
  res: Record<string, unknown>
): EngineCrashInfo | undefined {
  const raw = asRec(res.lastCrash);
  if (!raw) return undefined;
  return {
    fileName: typeof raw.fileName === 'string' ? raw.fileName : undefined,
    timestampMs:
      typeof raw.timestampMs === 'number' ? raw.timestampMs : undefined,
  };
}

/** T5-1b：崩溃台账上报（较上次查询新增崩溃文件 → errorStore 记录；
 * 崩溃现场可访问 = logDir + 文件名，technical 带完整路径） */
function recordNewCrash(crash: EngineCrashInfo, logDir: string): void {
  const fileName = crash.fileName;
  if (!fileName || fileName === lastReportedCrash.fileName) return;
  lastReportedCrash.fileName = fileName;
  try {
    const logPath = logDir ? `${logDir}/${fileName}` : fileName;
    errorStore.push({
      code: 'ENGINE_CRASH_PROBED',
      module: 'engine-status',
      severity: 'critical',
      message: '检测到一次引擎崩溃',
      technical: `崩溃文件：${logPath}`,
      autoResolve: true,
    });
  } catch {
    /* 上报失败不阻断心跳 */
  }
}

export async function fetchEngineLiveStatus(): Promise<EngineLiveStatus> {
  const transport = getTransport();
  if (!transport.isReady()) {
    const ready = await transport.waitUntilConnected(6_000);
    if (!ready) {
      // 命令面未建立：无法探活，清零失败计数（不算「引擎崩溃」）
      heartbeatFailStreak.count = 0;
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

    // T5-1：探活成功 → 清零失败计数；若此前已判死（engine_crashed），
    // 心跳本身即证明引擎存活 → 恢复 connected（与 eventBus ready 相位
    // 同值，幂等）
    heartbeatFailStreak.count = 0;
    if (errorStore.getState().connectionStatus === 'engine_crashed') {
      errorStore.setConnectionStatus('connected');
      errorStore.resolveByCode('ENGINE_CRASH_PROBED');
      errorStore.resolveByCode('ENGINE_HEARTBEAT_FAILED');
    }

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

    // T5-1b：崩溃台账读出面（lastCrash 较上次新增 → 记录「检测到一次
    // 引擎崩溃」；进程内 panic 后进程仍活的形态）
    const crash = projectCrash(res);
    if (crash) {
      const logDir = typeof res.logDir === 'string' ? res.logDir : '';
      recordNewCrash(crash, logDir);
    }

    return {
      ok: true,
      connected: true,
      activeRuns,
      pendingApprovals,
      // S2：当前 run trace_id 投影（None/非字符串 → undefined 缺省）
      traceId: typeof res.traceId === 'string' ? res.traceId : undefined,
      crash,
      raw: res,
    };
  } catch (e) {
    logInternalError('fetchEngineLiveStatus', e);
    // T5-1：心跳失败连续计数——仅 transport 已就绪（命令面已建立）才
    // 升高警戒；瞬时抖动沿用 transport 内部 error 暂态重试一次语义，
    // 连续 N 次才判死（防 keep-alive 短暂断连误报）
    if (transport.isReady()) {
      heartbeatFailStreak.count += 1;
      if (heartbeatFailStreak.count >= ENGINE_CRASH_PROBE_THRESHOLD) {
        errorStore.setConnectionStatus('engine_crashed');
        try {
          const detail = e instanceof Error ? e.message : String(e);
          errorStore.push({
            code: 'ENGINE_HEARTBEAT_FAILED',
            module: 'engine-status',
            severity: 'critical',
            message: '引擎无响应，可能已崩溃',
            ...(isEngineCrashishError(detail) ? { technical: detail } : {}),
            autoResolve: true,
          });
        } catch {
          /* 上报失败不阻断心跳 */
        }
      }
    } else {
      heartbeatFailStreak.count = 0;
    }
    return {
      ok: false,
      connected: transport.isReady(),
      activeRuns: [],
      pendingApprovals: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
