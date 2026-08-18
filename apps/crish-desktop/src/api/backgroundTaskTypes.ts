/**
 * 后台常驻任务：类型与常量定义域（T4-4a）。
 *
 * 从 `backgroundTasksApi.ts` 拆分而来；本模块只承载类型契约与冻结常量，
 * 无函数实现、无 DOM / invoke 依赖，便于被任意子模块静态依赖。
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

// ── 状态契约（与 workbench BackgroundTaskState 对齐 + unknown） ─────────

/** 规范化后的任务状态（含 unknown 安全回落） */
export type BackgroundTaskState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'killed'
  | 'unknown';

/** 仍可取消 / 视为活跃的状态 */
export const ACTIVE_BACKGROUND_TASK_STATES: readonly BackgroundTaskState[] = [
  'queued',
  'running',
] as const;

/** 终态（不可再 cancel） */
export const TERMINAL_BACKGROUND_TASK_STATES: readonly BackgroundTaskState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
  'killed',
] as const;

/** 全部合法规范化状态（含 unknown） */
export const BACKGROUND_TASK_STATES: readonly BackgroundTaskState[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
  'killed',
  'unknown',
] as const;

/** 中文短标签（Runtime 行 meta / 测试共用） */
export const BACKGROUND_TASK_STATE_LABELS: Readonly<
  Record<BackgroundTaskState, string>
> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  'timed-out': '已超时',
  killed: '已终止',
  unknown: '未知',
};

/** 终端面板单次推送最大行数 */
export const BACKGROUND_TASK_TERMINAL_MAX_LINES = 400;

/** 终端空输出占位 */
export const BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER = '（无输出）';

export type BackgroundTaskInfo = {
  id: string;
  label: string;
  /** 所属会话 ID（可选；wire sessionId / session_id） */
  sessionId?: string;
  /** 已 normalize 的状态字符串 */
  state: BackgroundTaskState;
  command?: string;
  startedAt?: number;
  summary?: string;
  /** 退出码（终态可读；未知 / 未提供时省略） */
  exitCode?: number;
  /** 任务时长（毫秒；wire durationMs / duration） */
  durationMs?: number;
  /** 终态时间戳（毫秒；归档计时起点） */
  finishedAtMs?: number;
  /** 已累积日志行数 */
  lineCount?: number;
  /** 最近输出时间戳（毫秒） */
  lastOutputAtMs?: number;
  /** 最新资源采样快照（wire resource；未启用 resourceMonitor 时为 null / 省略） */
  resource?: BackgroundTaskResourceSample | null;
  /** 检测到的交互提示（send_input 场景；wire prompt） */
  prompt?: string;
  /** 疑似卡死标记（task-suspicious 事件 / 轮询快照字段） */
  suspicious?: boolean;
};

/** 单次资源采样快照（REQ-A04：CPU / RSS / 最近输出时间） */
export type BackgroundTaskResourceSample = {
  /** 采样时间戳（毫秒） */
  sampledAtMs?: number;
  /** 进程树 CPU 使用率（周期差值 / 墙钟差值，0~100） */
  cpuPercent?: number;
  /** RSS / 工作集内存（字节） */
  rssBytes?: number;
  /** 最近输出时间戳（毫秒，事件驱动刷新） */
  lastOutputAtMs?: number;
};

export type FilterBackgroundTasksOpts = {
  /** 仅保留这些状态（normalize 后比较） */
  states?: readonly BackgroundTaskState[];
  /** true = 仅 queued|running；false = 仅终态；缺省不过滤活跃性 */
  activeOnly?: boolean;
  /** 子串匹配 label / command / id（不区分大小写） */
  query?: string;
};

/** cancel 纯语义结果：调用方决定是否 invoke */
export type CancelBackgroundTaskDecision =
  | { ok: true; taskId: string }
  | {
      ok: false;
      reason: 'missing_id' | 'not_found' | 'not_cancellable';
      state?: BackgroundTaskState;
    };

// ── T-AB-20：KillResult 三态（操作面反馈保留变体语义） ──────────────

/**
 * KillResult 三态结构化结果（UI 反馈层使用；与 parseCancelBackgroundTaskResult
 * 的「投影为任务信息」互补——本类型保留 killed / alreadyExited / failed 语义）。
 */
export type KillBackgroundTaskResult =
  | { kind: 'killed'; taskId: string; viaForce: boolean }
  | { kind: 'alreadyExited'; taskId: string; exitCode: number | null }
  | { kind: 'failed'; taskId: string; reason: string | null };

/** send_input 调用结果：成功带 appendNewline 实参；失败按原因分类 */
export type SendBackgroundTaskInputResult =
  | { ok: true; taskId: string; appendedNewline: boolean }
  | {
      ok: false;
      reason: 'missing_id' | 'empty_text' | 'not_active' | 'invoke_failed';
    };
