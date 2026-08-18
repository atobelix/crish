/**
 * 后台常驻任务：hub re-export 入口（T4-11 R5 基线清零）。
 *
 * 历史背景：T4-4 已将本文件的内联实现按职责域拆分为四个子模块
 *（types / parser / cancelLogic / client），但 hub 本身仍保留了与子模块
 * 逐字重复的内联实现，导致有效行数达 669（>400 业务逻辑上限）。
 * R5 将 hub 收敛为纯 re-export，消费方 import 路径保持不变。
 *
 * 子模块职责：
 * - `./backgroundTaskTypes`：类型契约 + 冻结常量（无函数实现）
 * - `./backgroundTaskParser`：纯函数解析 / 规范化 / 过滤 / 排序 / 输出
 * - `./backgroundTaskCancelLogic`：取消语义纯函数（决策 / 响应投影）
 * - `./backgroundTaskClient`：Tauri IPC 薄封装（list / output / cancel / kill / send_input / terminal）
 *
 * 命令返回形状（对齐 F1 冻结的 Rust 契约，background.rs）：
 * - workbench_list_background_tasks → `{ tasks: [...] }`，条目为 camelCase wire
 *   （taskId / command / status / startedAt / ...），无 label / summary 字段，
 *   label 由解析层回退到 command 前 64 字符；status 为 kebab-case 四态
 *   （running / completed / failed / killed）；
 * - workbench_get_background_task_output → `{ output, ...status 全字段 }`，
 *   `output` 即 status.tail（最近 20 行），前端 parseBackgroundTaskOutput 直读；
 * - workbench_cancel_background_task → KillResult 三态（serde external tagging）：
 *   `{ killed: { taskId, viaForce } }` / `{ alreadyExited: { taskId, exitCode } }`
 *   / `{ failed: { taskId, reason } }`。
 *
 * T-AB-20 新增（Rust 命令面尚未注册，invokeResult missing 时返回失败态）：
 * - workbench_send_input → `{ taskId, text, appendNewline }`（默认追加换行），
 *   成功与否经 invokeResult 的 ok/missing/error 三态区分，不用 null 判断。
 */

// ── 类型与常量 ────────────────────────────────────────────────────────
export {
  ACTIVE_BACKGROUND_TASK_STATES,
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  BACKGROUND_TASK_STATE_LABELS,
  BACKGROUND_TASK_STATES,
  BACKGROUND_TASK_TERMINAL_MAX_LINES,
  TERMINAL_BACKGROUND_TASK_STATES,
  type BackgroundTaskInfo,
  type BackgroundTaskResourceSample,
  type BackgroundTaskState,
  type CancelBackgroundTaskDecision,
  type FilterBackgroundTasksOpts,
  type KillBackgroundTaskResult,
  type SendBackgroundTaskInputResult,
} from './backgroundTaskTypes';

// ── 纯函数：解析 / 规范化 / 过滤 / 排序 / 输出 ─────────────────────────
export {
  backgroundTaskStateLabel,
  buildBackgroundTaskTerminalLines,
  dedupeBackgroundTasksById,
  extractBackgroundTaskArray,
  filterActiveBackgroundTasks,
  filterBackgroundTasks,
  filterTerminalBackgroundTasks,
  isBackgroundTaskActive,
  isBackgroundTaskState,
  isBackgroundTaskTerminal,
  normalizeBackgroundTaskId,
  normalizeBackgroundTaskState,
  parseBackgroundTask,
  parseBackgroundTaskList,
  parseBackgroundTaskOutput,
  parseBackgroundTaskStartedAt,
  resolveBackgroundTaskDisplayOutput,
  sortBackgroundTasksByStartedAt,
} from './backgroundTaskParser';

// ── 纯函数：取消语义（决策 / 响应投影） ──────────────────────────────
export {
  canCancelBackgroundTask,
  decideCancelBackgroundTask,
  parseCancelBackgroundTaskResult,
} from './backgroundTaskCancelLogic';

// ── Tauri IPC 薄封装（list / output / cancel / kill / send_input / terminal） ──
export {
  cancelBackgroundTask,
  getBackgroundTaskOutput,
  killBackgroundTask,
  listBackgroundTasks,
  openBackgroundTaskInTerminal,
  sendBackgroundTaskInput,
} from './backgroundTaskClient';
