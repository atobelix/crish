/**
 * 工具后台轨前端客户端（BG5）：引擎工具后台注册表（conex-run
 * `ToolBackgroundRegistry`）的 UI 查询 / 取消口。
 *
 * 与 `./backgroundTasksApi`（shell 进程任务域：`workbench_*` 命令 /
 * BackgroundTaskManager）是**两条轨**——命名、命令面、数据源都分开，
 * 呈现不合并（方案 BG5 定案）。本面对象是「工具调用超时转后台」的
 * 进程内工具调用（callId 寻址），命令面为引擎面 `core_*`：
 * - `core_list_tool_background_tasks`：会话未落定条目快照；
 * - `core_cancel_tool_background_task`：单条取消（BG1 子令牌取消口）。
 *
 * 形态与 backgroundTasksApi 对齐：Tauri 边界走 `invokeTyped` 三态，
 * 解析为纯函数、永不抛错；missing / error 归一为「空 / 未生效」并记
 * 内部错误日志，不让指示面与卡面因 IPC 故障崩坏。
 */

import { invokeTyped } from './tauriInvoke';
import { logInternalError } from './userFacingErrors';

// ── 类型契约（对齐 Rust ToolTaskStatus 的 camelCase wire）────────────

/** 未落定两态（注册表快照只回这两态；终态由 settled 回注驱动呈现） */
export type ToolBackgroundTaskState = 'queued' | 'running';

export interface ToolBackgroundTaskInfo {
  callId: string;
  toolName: string;
  state: ToolBackgroundTaskState;
  /** 登记时刻（ms epoch） */
  queuedAtMs: number;
  /** 获槽开始执行时刻（排队中为 null——排队不计时） */
  startedAtMs: number | null;
}

/** BG2 占位信封（转后台瞬间随本批落盘的非错误 tool_result） */
export interface ToolBackgroundPlaceholder {
  callId: string;
  toolName: string;
  /** detach 时刻的已运行时长（ms；与 tool-backgrounded 事件同值同源） */
  elapsedMs: number;
}

// ── 纯函数：解析 ────────────────────────────────────────────────────

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 单条快照解析：非未落定态 / 缺 callId → null（永不抛）。 */
export function parseToolBackgroundTask(
  data: unknown
): ToolBackgroundTaskInfo | null {
  const r = asRec(data);
  if (!r) return null;
  const callId =
    typeof r.callId === 'string' && r.callId.trim() ? r.callId.trim() : '';
  if (!callId) return null;
  if (r.state !== 'queued' && r.state !== 'running') return null;
  return {
    callId,
    toolName: typeof r.toolName === 'string' ? r.toolName : '',
    state: r.state,
    queuedAtMs: numOrNull(r.queuedAtMs) ?? 0,
    startedAtMs: numOrNull(r.startedAtMs),
  };
}

/** 列表解析：接受裸数组或 `{ tasks: [...] }` 两形（永不抛）。 */
export function parseToolBackgroundTaskList(
  data: unknown
): ToolBackgroundTaskInfo[] {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(asRec(data)?.tasks)
      ? (asRec(data)!.tasks as unknown[])
      : [];
  const out: ToolBackgroundTaskInfo[] = [];
  for (const item of arr) {
    const parsed = parseToolBackgroundTask(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * 占位信封识别：工具转后台后，其 MessageToolCall.output 即信封 JSON
 * （§3.3 冻结形状 `{mode:'background', callId, toolName, elapsedMs,
 * note}`）。卡面据此呈后台态；BG3 的 settled 回注把 output 原位替换
 * 为终态结果后，信封消失、卡面自动回常规终态呈现——单一判据、无
 * 第二状态源。callId 须与卡片自身 id 一致才算数（调用方校验）。
 */
export function parseToolBackgroundPlaceholder(
  output: string | undefined | null
): ToolBackgroundPlaceholder | null {
  if (!output) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const r = asRec(parsed);
  if (!r || r.mode !== 'background') return null;
  const callId =
    typeof r.callId === 'string' && r.callId.trim() ? r.callId.trim() : '';
  const elapsedMs = numOrNull(r.elapsedMs);
  if (!callId || elapsedMs === null) return null;
  return {
    callId,
    toolName: typeof r.toolName === 'string' ? r.toolName : '',
    elapsedMs,
  };
}

/**
 * 卡面已运行时长（ms）：detach 前已运行（信封 elapsedMs）+ 占位落到
 * 卡面后的墙钟。锚点 = 占位结果落盘时刻（completedAt）；缺失时以
 * startedAt + elapsedMs 近似（同为 detach 时刻口径）。
 */
export function toolBackgroundElapsedMs(
  placeholder: ToolBackgroundPlaceholder,
  anchors: { startedAt?: number | undefined; completedAt?: number | undefined },
  nowMs: number
): number {
  const anchor =
    anchors.completedAt ??
    (anchors.startedAt !== undefined
      ? anchors.startedAt + placeholder.elapsedMs
      : undefined);
  if (anchor === undefined || !Number.isFinite(anchor)) {
    return placeholder.elapsedMs;
  }
  return placeholder.elapsedMs + Math.max(0, nowMs - anchor);
}

// ── Tauri 边界（薄封装，解析走纯函数） ───────────────────────────────

/** 会话未落定后台工具快照：缺 sessionId / 命令缺失 / 失败 → 空数组。 */
export async function listToolBackgroundTasks(
  sessionId: string
): Promise<ToolBackgroundTaskInfo[]> {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return [];
  const res = await invokeTyped<unknown>('core_list_tool_background_tasks', {
    sessionId: id,
  });
  if (res.status === 'error')
    logInternalError('listToolBackgroundTasks', res.message);
  if (res.status !== 'ok') return [];
  return parseToolBackgroundTaskList(res.data);
}

/**
 * 取消单个后台工具：true = 在途且已取消收口；false = 不存在 / 已
 * 终态 / 命令缺失 / 失败（呈现层据此决定是否先行收口）。
 */
export async function cancelToolBackgroundTask(
  callId: string
): Promise<boolean> {
  const id = typeof callId === 'string' ? callId.trim() : '';
  if (!id) return false;
  const res = await invokeTyped<unknown>('core_cancel_tool_background_task', {
    callId: id,
  });
  if (res.status === 'error')
    logInternalError('cancelToolBackgroundTask', res.message);
  if (res.status !== 'ok') return false;
  return res.data === true;
}
