/**
 * 目标模式（/goal）续写与任务清单 — 续写决策与提示构造纯函数。
 * checklist 解析规则与 TasksCard 共用本模块，保证进度一致。
 *
 * 本模块从 goalModeController.ts 拆出，仅含续写/提示/checklist 域纯函数；
 * lifecycle 状态机见 goalModeLifecycleTypes.ts / goalModeLifecycleTransitions.ts。
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
    const m = lines[i]!.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!m) continue;
    const body = (m[2] || '').trim();
    if (!body) continue;
    if (PSEUDO_TASK_RE.test(body)) continue;
    tasks.push({
      id: `goal-task-${i}-${body.slice(0, 48)}`,
      text: body,
      done: m![1]!.toLowerCase() === 'x',
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
  | 'cancelled'
  | 'inactive'
  | 'queued'
  | 'done'
  | 'max_iter';

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
