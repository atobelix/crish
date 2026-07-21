/**
 * 目标模式（/goal）续写与任务清单 — 从 useChatStream 抽出的可测逻辑。
 * checklist 解析规则与 TasksCard 共用本模块，保证进度一致。
 */

import type {
  SessionGoalMode,
  SessionGoalTask,
  SessionState,
} from '../store/types';

/**
 * 桌面 goalMode 默认上限；与引擎 `DEFAULT_GOAL_MAX_ROUNDS`（12）对齐。
 * run-task.maxRounds 默认取此值。
 */
export const GOAL_DEFAULT_MAX_ITERATIONS = 12;

/** 引擎 stall 上限（与 orchestrator DEFAULT_GOAL_MAX_STALLED_ROUNDS 一致） */
export const GOAL_DEFAULT_MAX_STALLED_ROUNDS = 2;

/** 伪任务噪音：进度源应丢弃（与 TasksCard 一致） */
const PSEUDO_TASK_RE = /^本轮(总结|小结|回顾)/;

/**
 * 构造 run-task 的 goal 字段（mode/visibleGoal/maxRounds/maxStalledRounds）。
 * 供 createStreamSession 透传，触发 daemon startGoalRun / driveGoalRun。
 */
export function buildGoalRunTaskFields(input: {
  goal: string;
  maxIterations?: number;
}): {
  mode: 'goal';
  visibleGoal: string;
  maxRounds: number;
  maxStalledRounds: number;
} {
  const goal = (input.goal || '').trim();
  const maxRounds =
    typeof input.maxIterations === 'number' &&
    Number.isFinite(input.maxIterations) &&
    input.maxIterations > 0
      ? Math.floor(input.maxIterations)
      : GOAL_DEFAULT_MAX_ITERATIONS;
  return {
    mode: 'goal',
    visibleGoal: goal,
    maxRounds,
    maxStalledRounds: GOAL_DEFAULT_MAX_STALLED_ROUNDS,
  };
}

export function replyLooksGoalDone(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return /\bDONE\b/i.test(t) || /目标已完成/.test(t);
}

/** 将 goalMode.tasks 中未完成项注入续写提示 */
export function formatOpenGoalTasksForPrompt(
  tasks: SessionGoalTask[] | undefined
): string {
  const open = (tasks || []).filter(
    (t) => t && !t.done && (t.text || '').trim()
  );
  if (!open.length) return '';
  return [
    '当前未完成任务清单（请继续推进；每轮结束用 markdown checklist 更新 `- [ ]` / `- [x]`）：',
    ...open.map((t) => `- [ ] ${t.text.trim()}`),
    '',
  ].join('\n');
}

/** 构造目标模式注入到模型的前缀（不展示在用户气泡） */
export function buildGoalModePrefix(
  goal: string,
  iteration: number,
  maxIterations: number,
  tasks?: SessionGoalTask[]
): string {
  const openBlock = formatOpenGoalTasksForPrompt(tasks);
  return [
    '[目标模式 · 系统指令]',
    `你正在执行长期目标，请持续推进直至完成，并在每轮结束前自检进度。`,
    `目标：${goal}`,
    `当前第 ${iteration + 1} 轮（自动续写上限 ${maxIterations} 轮；请尽量在上限内完成）。`,
    '请工作直至目标实质完成；不要半途停下或只列计划而不执行。',
    '请在回复中维护 markdown 任务清单（`- [ ]` / `- [x]`），便于进度同步。',
    '若目标已完成，请在回复末尾明确写出 DONE 或「目标已完成」。',
    openBlock ? openBlock.trimEnd() : '',
    '---',
    '',
  ]
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n');
}

/**
 * 从助手 Markdown checklist 解析任务。
 * 规则与 TasksCard.parseMarkdownChecklist 对齐：
 * - `- [ ]` / `- [x]` / `* [ ]` / `* [X]`
 * - 丢弃「本轮总结」类伪任务
 */
export function parseChecklistTasks(
  text: string | undefined | null
): SessionGoalTask[] {
  if (!text) return [];
  const tasks: SessionGoalTask[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!m) continue;
    const body = (m[2] || '').trim();
    if (!body) continue;
    if (PSEUDO_TASK_RE.test(body)) continue;
    tasks.push({
      id: `goal-task-${i}-${body.slice(0, 48)}`,
      text: body,
      done: m[1].toLowerCase() === 'x',
    });
  }
  return tasks;
}

/** 进度计数（TasksCard / goal ribbon 共用） */
export function computeGoalTaskProgress(
  tasks: SessionGoalTask[] | undefined | null
): {
  total: number;
  done: number;
  pct: number;
} {
  const list = Array.isArray(tasks) ? tasks : [];
  const total = list.length;
  const done = list.filter((t) => t.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return { total, done, pct };
}

/** 合并助手 checklist 到 goalMode（纯函数，不写 store） */
export function mergeGoalTasksFromAssistantText(
  gm: SessionGoalMode,
  assistantText: string
): SessionGoalMode {
  const items = parseChecklistTasks(assistantText);
  if (!items.length) return gm;
  return { ...gm, tasks: items };
}

/**
 * 将未勾任务标 done 并收口 active。
 * ⚠️ 仅在 tasks 已实质完成（或调用方有证据）时使用；
 * 禁止因文案 DONE 无证据时强制勾满（假完成）。
 */
export function markAllGoalTasksDone(gm: SessionGoalMode): SessionGoalMode {
  const tasks = (gm.tasks || []).map((t) =>
    t.done ? t : { ...t, done: true }
  );
  return { ...gm, active: false, tasks };
}

/** 收口 active，**不**强制勾满 tasks（保留真实缺口） */
export function deactivateGoalMode(gm: SessionGoalMode): SessionGoalMode {
  return { ...gm, active: false };
}

export type GoalStopReason =
  'cancelled' | 'inactive' | 'queued' | 'done' | 'max_iter';

export type GoalContinueDecision =
  | {
      action: 'stop';
      reason: GoalStopReason;
      goalMode: SessionGoalMode | null;
      /**
       * 仅异常停机（如达上限）可带 toast。
       * 成功完成（done）/ 取消 / 排队让路：**禁止** toast（Tasks ribbon + TasksCard 同源反馈）。
       */
      toast?: string;
    }
  | {
      action: 'continue';
      goalMode: SessionGoalMode;
      displayText: string;
      modelText: string;
    };

/** 停机原因是否允许 toast（产品：成功不刷屏） */
export function goalStopAllowsToast(reason: GoalStopReason): boolean {
  return reason === 'max_iter';
}

/**
 * 根据当前会话与助手终稿决定是否自动续写（纯函数）。
 * 任务清单解析与 TasksCard 同源（parseChecklistTasks）。
 *
 * 完成门禁（反假完成）：
 * - checklist 全 done → done（不强制 markAll；tasks 已全勾）
 * - 文案 DONE 且 **无 tasks** → done（无清单可验，允许收口）
 * - 文案 DONE 但 tasks 非空且未全 done → **不** done；继续推进或 max_iter 停机并保留缺口
 * - 禁止仅因 DONE 调用 markAllGoalTasksDone
 */
export function decideGoalContinuation(input: {
  cancelled: boolean;
  session: SessionState | undefined;
  assistantText: string;
}): GoalContinueDecision {
  if (input.cancelled) {
    // 用户停止：ribbon 已收；不 toast「已停止目标」
    return { action: 'stop', reason: 'cancelled', goalMode: null };
  }
  let gm = input.session?.goalMode;
  if (!gm?.active) {
    return { action: 'stop', reason: 'inactive', goalMode: gm ?? null };
  }

  const hasQueued = input.session?.messages?.some(
    (m) => m.sender === 'user' && m.status === 'queued'
  );
  if (hasQueued) {
    // 先处理用户排队消息；tasks 可能已由调用方 sync；不 toast
    return { action: 'stop', reason: 'queued', goalMode: gm };
  }

  // 与 TasksCard 同源：从助手 markdown checklist 刷新 goalMode.tasks
  gm = mergeGoalTasksFromAssistantText(gm, input.assistantText);

  const tasks = Array.isArray(gm.tasks) ? gm.tasks : [];
  const hasTasks = tasks.length > 0;
  const allTasksDone = hasTasks && tasks.every((t) => t.done);
  const looksDone = replyLooksGoalDone(input.assistantText);
  // 文案 DONE 但清单仍有未完成项 → 假完成信号，不得 stop:done
  const prematureDoneClaim = looksDone && hasTasks && !allTasksDone;

  // 真完成：清单全勾；或无清单时允许文案 DONE 收口（无 tasks 可证伪）
  if (allTasksDone || (looksDone && !hasTasks)) {
    return {
      action: 'stop',
      reason: 'done',
      // 不 markAllGoalTasksDone：避免无证据强制勾满；全勾时 tasks 已 done
      goalMode: deactivateGoalMode(gm),
    };
  }

  const maxIter = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
  const nextIter = (gm.iteration ?? 0) + 1;
  if (nextIter >= maxIter) {
    return {
      action: 'stop',
      reason: 'max_iter',
      // 保留已解析 tasks（含未完成缺口），便于 TasksCard 展示；不因 DONE 勾满
      goalMode: { ...gm, active: false, iteration: nextIter },
      // 达上限属异常停机，短 toast（不进 runNotice 错误流）
      toast: prematureDoneClaim
        ? `目标已达上限（${maxIter} 轮）；文案 DONE 但任务未全部完成`
        : `目标已达上限（${maxIter} 轮）`,
    };
  }

  const nextGm: SessionGoalMode = {
    ...gm,
    active: true,
    iteration: nextIter,
    maxIterations: maxIter,
  };
  const displayText = prematureDoneClaim
    ? '任务清单仍有未完成项，请继续推进（勿仅因文案 DONE 停机）'
    : '继续推进目标，若已完成请明确说明 DONE';
  const modelText = [
    buildGoalModePrefix(gm.goal, nextIter, maxIter, nextGm.tasks),
    displayText,
  ].join('\n');
  return { action: 'continue', goalMode: nextGm, displayText, modelText };
}

export function createInitialGoalMode(
  goal: string,
  maxIterations = GOAL_DEFAULT_MAX_ITERATIONS
): SessionGoalMode {
  const g = goal.trim();
  return {
    active: true,
    goal: g,
    iteration: 0,
    maxIterations,
    tasks: g ? [{ id: 'goal-root', text: g, done: false }] : [],
  };
}

// ---------------------------------------------------------------------------
// Goal lifecycle pure helpers (enter / exit / pause / progress / exclusivity)
// Controller-local state — does not extend SessionGoalMode (store types frozen).
// ---------------------------------------------------------------------------

/** Lifecycle phase for goal mode orchestration */
export type GoalLifecyclePhase =
  'idle' | 'active' | 'paused' | 'blocked' | 'completed';

/**
 * Controller-local lifecycle snapshot.
 * Maps to SessionGoalMode via {@link goalLifecycleToSessionMode}.
 */
export type GoalLifecycleState = {
  phase: GoalLifecyclePhase;
  goal: string;
  iteration: number;
  maxIterations: number;
  tasks: SessionGoalTask[];
  /** Chronological progress messages (newest last); capped */
  progressMessages: string[];
  /** Latest progress / terminal message for ribbon / UI */
  lastMessage: string | null;
  /**
   * Failure / stuck signal. Exclusive with `completed === true`.
   * Present only when phase === 'blocked'.
   */
  blockedReason: string | null;
  /** Success terminal. Exclusive with non-null blockedReason. */
  completed: boolean;
};

/** Events for the pure lifecycle transition function */
export type GoalLifecycleEvent =
  | { type: 'enter'; goal: string; maxIterations?: number }
  | { type: 'exit' }
  | { type: 'pause'; reason?: string }
  | { type: 'resume' }
  | { type: 'progress'; message: string }
  | { type: 'complete'; message?: string }
  | {
      type: 'update';
      /** Success terminal — exclusive with blocked_reason */
      completed?: boolean;
      /** Progress note (also allowed on complete) */
      message?: string;
      /** Failure / stuck — exclusive with completed:true; pauses as blocked */
      blocked_reason?: string;
    };

export type GoalTransitionOutcome = 'applied' | 'noop' | 'illegal';

export type GoalTransitionResult = {
  outcome: GoalTransitionOutcome;
  /** Machine-readable reason code */
  reason: string | null;
  event: GoalLifecycleEvent['type'];
  changed: boolean;
  state: GoalLifecycleState;
};

/** Structured update payload (update_goal tool shape) */
export type GoalUpdatePayload = {
  completed?: boolean;
  message?: string;
  blocked_reason?: string;
};

const PROGRESS_MESSAGE_CAP = 32;

export function createIdleGoalLifecycle(): GoalLifecycleState {
  return {
    phase: 'idle',
    goal: '',
    iteration: 0,
    maxIterations: GOAL_DEFAULT_MAX_ITERATIONS,
    tasks: [],
    progressMessages: [],
    lastMessage: null,
    blockedReason: null,
    completed: false,
  };
}

/** Fresh active lifecycle from a goal string (enter path) */
export function createActiveGoalLifecycle(
  goal: string,
  maxIterations = GOAL_DEFAULT_MAX_ITERATIONS
): GoalLifecycleState {
  const g = goal.trim();
  return {
    phase: 'active',
    goal: g,
    iteration: 0,
    maxIterations:
      maxIterations > 0 ? maxIterations : GOAL_DEFAULT_MAX_ITERATIONS,
    tasks: g ? [{ id: 'goal-root', text: g, done: false }] : [],
    progressMessages: [],
    lastMessage: null,
    blockedReason: null,
    completed: false,
  };
}

/**
 * blocked_reason vs completed exclusivity.
 * Both set (completed:true AND non-empty blocked_reason) is illegal.
 * Empty/whitespace blocked_reason is treated as absent.
 */
export function validateGoalUpdateExclusivity(
  update: GoalUpdatePayload
): { ok: true } | { ok: false; reason: 'completed_and_blocked' } {
  const blocked = (update.blocked_reason || '').trim();
  if (update.completed === true && blocked) {
    return { ok: false, reason: 'completed_and_blocked' };
  }
  return { ok: true };
}

/** Append a progress message (trim, skip empty, cap length) */
export function appendGoalProgressMessage(
  state: GoalLifecycleState,
  message: string | undefined | null
): GoalLifecycleState {
  const msg = (message || '').trim();
  if (!msg) return state;
  const next = [...state.progressMessages, msg];
  while (next.length > PROGRESS_MESSAGE_CAP) next.shift();
  return { ...state, progressMessages: next, lastMessage: msg };
}

/**
 * Human-readable progress line for ribbon / TasksCard / logs.
 * Prefer explicit message; otherwise synthesize from phase + task progress.
 */
export function formatGoalProgressMessage(input: {
  phase: GoalLifecyclePhase;
  goal: string;
  iteration: number;
  maxIterations: number;
  tasks?: SessionGoalTask[] | null;
  message?: string | null;
  blockedReason?: string | null;
}): string {
  const explicit = (input.message || '').trim();
  if (explicit) return explicit;

  const { total, done, pct } = computeGoalTaskProgress(input.tasks);
  const goalLabel = (input.goal || '').trim() || '目标';
  const round = `第 ${Math.max(0, input.iteration) + 1}/${Math.max(1, input.maxIterations)} 轮`;
  const taskPart =
    total > 0 ? `任务 ${done}/${total}（${pct}%）` : '暂无任务清单';

  switch (input.phase) {
    case 'idle':
      return '目标模式未启动';
    case 'active':
      return `推进中 · ${goalLabel} · ${round} · ${taskPart}`;
    case 'paused':
      return `已暂停 · ${goalLabel} · ${taskPart}`;
    case 'blocked': {
      const br = (input.blockedReason || '').trim();
      return br
        ? `受阻 · ${goalLabel} · ${br}`
        : `受阻 · ${goalLabel} · ${taskPart}`;
    }
    case 'completed':
      return `已完成 · ${goalLabel}${total > 0 ? ` · 任务 ${done}/${total}` : ''}`;
    default:
      return goalLabel;
  }
}

/** Bridge lifecycle → session store shape (null when idle) */
export function goalLifecycleToSessionMode(
  state: GoalLifecycleState
): SessionGoalMode | null {
  if (state.phase === 'idle') return null;
  return {
    active: state.phase === 'active',
    goal: state.goal,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    tasks: state.tasks,
  };
}

/** Bridge session store shape → lifecycle (unknown → idle) */
export function sessionModeToGoalLifecycle(
  gm: SessionGoalMode | null | undefined
): GoalLifecycleState {
  if (!gm) return createIdleGoalLifecycle();
  const maxIterations = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
  if (gm.active) {
    return {
      phase: 'active',
      goal: gm.goal || '',
      iteration: gm.iteration ?? 0,
      maxIterations,
      tasks: Array.isArray(gm.tasks) ? gm.tasks : [],
      progressMessages: [],
      lastMessage: null,
      blockedReason: null,
      completed: false,
    };
  }
  // inactive but present: treat as completed if all tasks done, else paused
  const tasks = Array.isArray(gm.tasks) ? gm.tasks : [];
  const allDone = tasks.length > 0 && tasks.every((t) => t.done);
  if (allDone) {
    return {
      phase: 'completed',
      goal: gm.goal || '',
      iteration: gm.iteration ?? 0,
      maxIterations,
      tasks,
      progressMessages: [],
      lastMessage: null,
      blockedReason: null,
      completed: true,
    };
  }
  return {
    phase: 'paused',
    goal: gm.goal || '',
    iteration: gm.iteration ?? 0,
    maxIterations,
    tasks,
    progressMessages: [],
    lastMessage: null,
    blockedReason: null,
    completed: false,
  };
}

function isRunningPhase(phase: GoalLifecyclePhase): boolean {
  return phase === 'active' || phase === 'paused' || phase === 'blocked';
}

function canEnterFrom(phase: GoalLifecyclePhase): boolean {
  return phase === 'idle' || phase === 'completed';
}

/**
 * Pure lifecycle transition: enter / exit / pause / resume / progress / complete / update.
 *
 * Guards (illegal):
 * - enter with empty goal
 * - enter while active|paused|blocked (must exit first)
 * - pause / resume / progress / complete from idle or completed (where inapplicable)
 * - update with both completed:true and non-empty blocked_reason
 *
 * Noops:
 * - exit from idle / completed
 * - pause when already paused
 * - resume when already active
 * - complete when already completed
 * - empty progress / empty update
 */
export function transitionGoalLifecycle(
  state: GoalLifecycleState,
  event: GoalLifecycleEvent
): GoalTransitionResult {
  const finish = (
    outcome: GoalTransitionOutcome,
    reason: string | null,
    next: GoalLifecycleState
  ): GoalTransitionResult => ({
    outcome,
    reason,
    event: event.type,
    changed: outcome === 'applied',
    state: next,
  });

  switch (event.type) {
    case 'enter': {
      const g = (event.goal || '').trim();
      if (!g) return finish('illegal', 'empty_goal', state);
      if (!canEnterFrom(state.phase)) {
        return finish('illegal', 'already_running', state);
      }
      const max =
        event.maxIterations && event.maxIterations > 0
          ? event.maxIterations
          : GOAL_DEFAULT_MAX_ITERATIONS;
      return finish('applied', 'entered', createActiveGoalLifecycle(g, max));
    }

    case 'exit': {
      if (state.phase === 'idle') return finish('noop', 'already_idle', state);
      if (state.phase === 'completed') {
        // Terminal success already exited auto-loop; clear to idle for re-enter
        return finish(
          'applied',
          'cleared_completed',
          createIdleGoalLifecycle()
        );
      }
      return finish('applied', 'exited', createIdleGoalLifecycle());
    }

    case 'pause': {
      if (state.phase === 'idle')
        return finish('illegal', 'not_running', state);
      if (state.phase === 'completed')
        return finish('illegal', 'already_completed', state);
      if (state.phase === 'paused')
        return finish('noop', 'already_paused', state);
      if (state.phase === 'blocked') {
        // Soft pause from blocked keeps blockedReason but moves to paused? No —
        // stay blocked (stronger terminal-stuck); treat as noop.
        return finish('noop', 'already_blocked', state);
      }
      // active → paused; clear blocked/completed exclusivity side
      let next: GoalLifecycleState = {
        ...state,
        phase: 'paused',
        blockedReason: null,
        completed: false,
      };
      const reasonMsg = (event.reason || '').trim();
      if (reasonMsg) next = appendGoalProgressMessage(next, reasonMsg);
      return finish('applied', 'paused', next);
    }

    case 'resume': {
      if (state.phase === 'idle')
        return finish('illegal', 'not_running', state);
      if (state.phase === 'completed')
        return finish('illegal', 'already_completed', state);
      if (state.phase === 'active')
        return finish('noop', 'already_active', state);
      // paused | blocked → active; clear blocked on resume
      return finish('applied', 'resumed', {
        ...state,
        phase: 'active',
        blockedReason: null,
        completed: false,
      });
    }

    case 'progress': {
      if (!isRunningPhase(state.phase)) {
        return finish(
          'illegal',
          state.phase === 'completed' ? 'already_completed' : 'not_running',
          state
        );
      }
      const msg = (event.message || '').trim();
      if (!msg) return finish('noop', 'empty_message', state);
      return finish(
        'applied',
        'progress_logged',
        appendGoalProgressMessage(state, msg)
      );
    }

    case 'complete': {
      if (state.phase === 'idle')
        return finish('illegal', 'not_running', state);
      if (state.phase === 'completed')
        return finish('noop', 'already_completed', state);
      let next: GoalLifecycleState = {
        ...state,
        phase: 'completed',
        completed: true,
        blockedReason: null, // exclusivity: success clears blocked
        tasks: (state.tasks || []).map((t) =>
          t.done ? t : { ...t, done: true }
        ),
      };
      const msg = (event.message || '').trim() || '目标已完成';
      next = appendGoalProgressMessage(next, msg);
      return finish('applied', 'completed', next);
    }

    case 'update': {
      return applyGoalUpdate(state, {
        completed: event.completed,
        message: event.message,
        blocked_reason: event.blocked_reason,
      });
    }

    default: {
      // Exhaustiveness — should be unreachable
      const _never: never = event;
      void _never;
      return finish('illegal', 'unknown_event', state);
    }
  }
}

/**
 * Apply update_goal-shaped payload with exclusivity + phase guards.
 * - completed:true → complete (clears blockedReason)
 * - blocked_reason → block/pause as blocked (clears completed)
 * - message only → progress log while running
 * - both completed + blocked_reason → illegal (no state change)
 */
export function applyGoalUpdate(
  state: GoalLifecycleState,
  update: GoalUpdatePayload
): GoalTransitionResult {
  const finish = (
    outcome: GoalTransitionOutcome,
    reason: string | null,
    next: GoalLifecycleState
  ): GoalTransitionResult => ({
    outcome,
    reason,
    event: 'update',
    changed: outcome === 'applied',
    state: next,
  });

  const exclusivity = validateGoalUpdateExclusivity(update);
  if (exclusivity.ok === false) {
    return finish('illegal', exclusivity.reason, state);
  }

  const hasCompleted = update.completed === true;
  const blocked = (update.blocked_reason || '').trim();
  const message = (update.message || '').trim();
  const hasBlocked = Boolean(blocked);
  const hasMessage = Boolean(message);

  if (!hasCompleted && !hasBlocked && !hasMessage) {
    return finish('noop', 'empty_update', state);
  }

  // Terminal success
  if (hasCompleted) {
    if (state.phase === 'idle') return finish('illegal', 'not_running', state);
    if (state.phase === 'completed') {
      // Idempotent complete; optional message still logs
      if (!hasMessage) return finish('noop', 'already_completed', state);
      return finish(
        'applied',
        'progress_on_completed',
        appendGoalProgressMessage(state, message)
      );
    }
    let next: GoalLifecycleState = {
      ...state,
      phase: 'completed',
      completed: true,
      blockedReason: null,
      tasks: (state.tasks || []).map((t) =>
        t.done ? t : { ...t, done: true }
      ),
    };
    next = appendGoalProgressMessage(next, message || '目标已完成');
    return finish('applied', 'completed', next);
  }

  // Failure / stuck — exclusive path (no completed)
  if (hasBlocked) {
    if (state.phase === 'idle') return finish('illegal', 'not_running', state);
    if (state.phase === 'completed')
      return finish('illegal', 'already_completed', state);
    let next: GoalLifecycleState = {
      ...state,
      phase: 'blocked',
      completed: false,
      blockedReason: blocked,
    };
    // Progress note (optional) then blocked audit line — never treat blocked as success
    if (hasMessage) next = appendGoalProgressMessage(next, message);
    next = appendGoalProgressMessage(next, `受阻：${blocked}`);
    return finish('applied', 'blocked', next);
  }

  // Progress-only message
  if (!isRunningPhase(state.phase)) {
    return finish(
      'illegal',
      state.phase === 'completed' ? 'already_completed' : 'not_running',
      state
    );
  }
  return finish(
    'applied',
    'progress_logged',
    appendGoalProgressMessage(state, message)
  );
}

/** Convenience: enter */
export function enterGoalMode(
  state: GoalLifecycleState,
  goal: string,
  maxIterations?: number
): GoalTransitionResult {
  return transitionGoalLifecycle(state, { type: 'enter', goal, maxIterations });
}

/** Convenience: exit / clear */
export function exitGoalMode(state: GoalLifecycleState): GoalTransitionResult {
  return transitionGoalLifecycle(state, { type: 'exit' });
}

/** Convenience: pause (soft; not blocked) */
export function pauseGoalMode(
  state: GoalLifecycleState,
  reason?: string
): GoalTransitionResult {
  return transitionGoalLifecycle(state, { type: 'pause', reason });
}

/** Convenience: resume from paused/blocked */
export function resumeGoalMode(
  state: GoalLifecycleState
): GoalTransitionResult {
  return transitionGoalLifecycle(state, { type: 'resume' });
}
