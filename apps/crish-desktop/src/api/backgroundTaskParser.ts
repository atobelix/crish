/**
 * 后台常驻任务：纯函数解析 / 规范化 / 过滤 / 排序域（T4-4b）。
 *
 * 从 `backgroundTasksApi.ts` 拆分而来；本模块仅含无 DOM / 无 invoke 依赖的纯函数，
 * 可直接单测。依赖仅限 `./backgroundTaskTypes` 的类型与常量。
 *
 * 实现按职责拆分到子模块，本文件作为 re-export hub 以保持消费方 import 路径不变：
 * - 状态规范化 / 判定：./backgroundTaskState
 * - 单任务解析 / 资源解析 / 时间：./backgroundTaskParse
 * - 列表提取 / 去重 / 过滤 / 排序 / 输出：./backgroundTaskList
 */

export {
  normalizeBackgroundTaskId,
  normalizeBackgroundTaskState,
  isBackgroundTaskState,
  isBackgroundTaskActive,
  isBackgroundTaskTerminal,
  backgroundTaskStateLabel,
} from './backgroundTaskState';

export {
  coerceText,
  parseBackgroundTaskStartedAt,
  parseBackgroundTask,
  parseBgTaskResourceSample,
} from './backgroundTaskParse';

export {
  extractBackgroundTaskArray,
  parseBackgroundTaskList,
  dedupeBackgroundTasksById,
  filterBackgroundTasks,
  filterActiveBackgroundTasks,
  filterTerminalBackgroundTasks,
  sortBackgroundTasksByStartedAt,
  parseBackgroundTaskOutput,
  buildBackgroundTaskTerminalLines,
  resolveBackgroundTaskDisplayOutput,
} from './backgroundTaskList';
