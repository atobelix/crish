/**
 * 后台常驻任务：Tauri IPC 调用域（T4-4d）。
 *
 * 从 `backgroundTasksApi.ts` 拆分而来；本模块是 Tauri 边界的薄封装，
 * 解析走纯函数模块。依赖：
 * - `./backgroundTaskTypes`：类型契约
 * - `./backgroundTaskParser`：输出 / 列表纯解析
 * - `./backgroundTaskCancelLogic`：cancel 纯决策与响应投影
 * - `./tauriInvoke`：invokeTyped / invokeResult 三态封装
 * - `./userFacingErrors`：错误日志
 */

import { invokeResult, invokeTyped } from './tauriInvoke';
import { logInternalError } from './userFacingErrors';
import {
  type BackgroundTaskInfo,
  type KillBackgroundTaskResult,
  type SendBackgroundTaskInputResult,
} from './backgroundTaskTypes';
import {
  buildBackgroundTaskTerminalLines,
  parseBackgroundTaskList,
  parseBackgroundTaskOutput,
} from './backgroundTaskParser';
import {
  decideCancelBackgroundTask,
  parseCancelBackgroundTaskResult,
} from './backgroundTaskCancelLogic';
import {
  isBackgroundTaskActive,
  normalizeBackgroundTaskId,
} from './backgroundTaskParser';

// ── 内部工具 ──────────────────────────────────────────────────────────

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// ── Tauri 边界（薄封装，解析走纯函数） ───────────────────────────────

/** 列表：`{ tasks: [...] }`（Rust camelCase wire，无 label / summary 字段）。 */
export async function listBackgroundTasks(): Promise<BackgroundTaskInfo[]> {
  // T-F 06 T6.1 / T5-5：invokeTyped 三态化（missing → []，error → 日志 + []）
  const res = await invokeTyped<unknown>('workbench_list_background_tasks');
  if (res.status === 'error')
    logInternalError('listBackgroundTasks', res.message);
  if (res.status !== 'ok') return [];
  return parseBackgroundTaskList(res.data);
}

/**
 * 输出：`{ output, ...status 全字段 }`——`output` 即 status.tail。
 * 容错：任务不存在（NotFound）或命令失败 → 空串，由展示层回退
 * （summary / command / 占位文案），不抛错、不打断面板。
 */
export async function getBackgroundTaskOutput(taskId: string): Promise<string> {
  const id = normalizeBackgroundTaskId(taskId);
  if (!id) return '';
  try {
    const res = await invokeTyped<unknown>(
      'workbench_get_background_task_output',
      {
        taskId: id,
      }
    );
    if (res.status === 'error')
      logInternalError('getBackgroundTaskOutput', res.message);
    if (res.status !== 'ok') return '';
    return parseBackgroundTaskOutput(res.data);
  } catch {
    return '';
  }
}

/**
 * 取消后台任务（纯语义校验 + invoke）。
 * - 缺 id → null
 * - 若传入 knownTasks 且决策不可 cancel → null（不打 invoke）
 * - invoke 失败 / 缺命令 → null
 * - 响应为 KillResult：killed → cancelled；alreadyExited → 终态；
 *   failed → unknown（取消未生效，reason 进 summary）
 */
export async function cancelBackgroundTask(
  taskId: string,
  knownTasks?: readonly BackgroundTaskInfo[] | null
): Promise<BackgroundTaskInfo | null> {
  const decision = decideCancelBackgroundTask(taskId, knownTasks);
  if (!decision.ok) return null;
  const res = await invokeTyped<unknown>('workbench_cancel_background_task', {
    taskId: decision.taskId,
  });
  if (res.status === 'error')
    logInternalError('cancelBackgroundTask', res.message);
  if (res.status !== 'ok') return null;
  return parseCancelBackgroundTaskResult(res.data);
}

// ── T-AB-20：KillResult 三态（操作面反馈保留变体语义） ──────────────

/**
 * 解析 KillResult wire 形状（serde external tagging，camelCase / snake_case 兼容）：
 * `{ killed: { taskId, viaForce } }` / `{ alreadyExited: { taskId, exitCode } }`
 * / `{ failed: { taskId, reason } }`；畸形 / 缺 id → null（永不抛）。
 */
function parseKillResultPayload(
  data: unknown
): KillBackgroundTaskResult | null {
  const root = asRec(data);
  if (!root) return null;

  const killed = asRec(root.killed);
  if (killed) {
    const id = normalizeBackgroundTaskId(killed.taskId ?? killed.task_id);
    if (!id) return null;
    return {
      kind: 'killed',
      taskId: id,
      viaForce: killed.viaForce === true || killed.via_force === true,
    };
  }

  const exited = asRec(root.alreadyExited);
  if (exited) {
    const id = normalizeBackgroundTaskId(exited.taskId ?? exited.task_id);
    if (!id) return null;
    const codeRaw = exited.exitCode ?? exited.exit_code;
    const code =
      typeof codeRaw === 'number' && Number.isFinite(codeRaw) ? codeRaw : null;
    return { kind: 'alreadyExited', taskId: id, exitCode: code };
  }

  const failed = asRec(root.failed);
  if (failed) {
    const id = normalizeBackgroundTaskId(failed.taskId ?? failed.task_id);
    if (!id) return null;
    const reason =
      typeof failed.reason === 'string' && failed.reason.trim()
        ? failed.reason.trim()
        : null;
    return { kind: 'failed', taskId: id, reason };
  }

  return null;
}

/**
 * 终止后台任务（kill 按钮用）：语义校验（同 cancel）+ invoke + 三态解析。
 * 纯语义决策失败 / invoke 失败 / 缺命令 → null（调用方按「终止失败」呈现）。
 */
export async function killBackgroundTask(
  taskId: string,
  knownTasks?: readonly BackgroundTaskInfo[] | null
): Promise<KillBackgroundTaskResult | null> {
  const decision = decideCancelBackgroundTask(taskId, knownTasks);
  if (!decision.ok) return null;
  const res = await invokeTyped<unknown>('workbench_cancel_background_task', {
    taskId: decision.taskId,
  });
  if (res.status === 'error')
    logInternalError('killBackgroundTask', res.message);
  if (res.status !== 'ok') return null;
  return parseKillResultPayload(res.data);
}

// ── T-AB-20：send_input（stdin 注入，默认追加换行） ─────────────────

/**
 * 纯 send_input 决策：缺 id / 空文本 / 非活跃任务 → 失败（不 invoke）。
 * 无任务上下文时仅校验 id 与文本（调用方自行负责任务态）。
 */
function decideSendBackgroundTaskInput(
  taskId: unknown,
  text: unknown,
  task?: Pick<BackgroundTaskInfo, 'id' | 'state'> | null
):
  | { ok: false; reason: 'missing_id' | 'empty_text' | 'not_active' }
  | { ok: true; taskId: string } {
  const id = normalizeBackgroundTaskId(taskId);
  if (!id) return { ok: false, reason: 'missing_id' };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty_text' };
  }
  if (task != null) {
    const tid = normalizeBackgroundTaskId(task.id);
    if (tid !== id || !isBackgroundTaskActive(task.state)) {
      return { ok: false, reason: 'not_active' };
    }
  }
  return { ok: true, taskId: id };
}

/**
 * 向任务 stdin 写入输入（T-AB-20 操作面；Rust 命令面尚未注册——
 * workbench_send_input 缺命令 / 失败时经 invokeResult 三态归类为 invoke_failed）。
 * appendNewline 缺省 true，与 Rust send_input 语义一致（末尾追加 \n）。
 */
export async function sendBackgroundTaskInput(
  taskId: string,
  text: string,
  appendNewline: boolean = true,
  task?: Pick<BackgroundTaskInfo, 'id' | 'state'> | null
): Promise<SendBackgroundTaskInputResult> {
  const decision = decideSendBackgroundTaskInput(taskId, text, task);
  if (!decision.ok) return decision;
  const res = await invokeResult<unknown>('workbench_send_input', {
    taskId: decision.taskId,
    text,
    appendNewline,
  });
  if (res.status !== 'ok') return { ok: false, reason: 'invoke_failed' };
  return { ok: true, taskId: decision.taskId, appendedNewline: appendNewline };
}

/**
 * 将任务输出推到终端面板并打开终端侧栏。
 * 成功路径不 toast（由调用方保证）；打开面板即反馈。
 */
export function openBackgroundTaskInTerminal(
  title: string,
  output: string
): void {
  const lines = buildBackgroundTaskTerminalLines(output);
  window.dispatchEvent(
    new CustomEvent('crish-terminal-append', {
      detail: { title, lines },
    })
  );
  // 仅切终端标签；不发「已打开」类 toast
  window.dispatchEvent(new CustomEvent('crish-open-terminal'));
}
