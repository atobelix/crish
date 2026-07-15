/**
 * 目标模式（/goal）续写与任务清单 — 从 useChatStream 抽出的可测逻辑。
 */

import type { SessionGoalMode, SessionGoalTask, SessionState } from '../store/types';

export const GOAL_DEFAULT_MAX_ITERATIONS = 5;

export function replyLooksGoalDone(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return /\bDONE\b/i.test(t) || /目标已完成/.test(t);
}

/** 将 goalMode.tasks 中未完成项注入续写提示 */
export function formatOpenGoalTasksForPrompt(tasks: SessionGoalTask[] | undefined): string {
  const open = (tasks || []).filter((t) => t && !t.done && (t.text || '').trim());
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
  tasks?: SessionGoalTask[],
): string {
  const openBlock = formatOpenGoalTasksForPrompt(tasks);
  return [
    '[目标模式 · 系统指令]',
    `你正在执行长期目标，请持续推进直至完成，并在每轮结束前自检进度。`,
    `目标：${goal}`,
    `当前第 ${iteration + 1} 轮（自动续写上限 ${maxIterations} 轮；请尽量在 8 轮内完成）。`,
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

/** 从助手 Markdown checklist 解析任务（与 TasksCard 规则对齐的轻量版） */
export function parseChecklistTasks(text: string): SessionGoalTask[] {
  const tasks: SessionGoalTask[] = [];
  const re = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text || '')) !== null) {
    const done = m[1].toLowerCase() === 'x';
    const body = (m[2] || '').trim();
    if (!body) continue;
    tasks.push({
      id: `goal-task-${i++}`,
      text: body,
      done,
    });
  }
  return tasks;
}

/** 合并助手 checklist 到 goalMode（纯函数，不写 store） */
export function mergeGoalTasksFromAssistantText(
  gm: SessionGoalMode,
  assistantText: string,
): SessionGoalMode {
  const items = parseChecklistTasks(assistantText);
  if (!items.length) return gm;
  return { ...gm, tasks: items };
}

export type GoalContinueDecision =
  | {
      action: 'stop';
      reason: 'cancelled' | 'inactive' | 'queued' | 'done' | 'max_iter';
      goalMode: SessionGoalMode | null;
      toast?: string;
    }
  | {
      action: 'continue';
      goalMode: SessionGoalMode;
      displayText: string;
      modelText: string;
    };

/**
 * 根据当前会话与助手终稿决定是否自动续写（纯函数）。
 */
export function decideGoalContinuation(input: {
  cancelled: boolean;
  session: SessionState | undefined;
  assistantText: string;
}): GoalContinueDecision {
  if (input.cancelled) {
    return { action: 'stop', reason: 'cancelled', goalMode: null };
  }
  let gm = input.session?.goalMode;
  if (!gm?.active) {
    return { action: 'stop', reason: 'inactive', goalMode: gm ?? null };
  }

  const hasQueued = input.session?.messages?.some(
    (m) => m.sender === 'user' && m.status === 'queued',
  );
  if (hasQueued) {
    return { action: 'stop', reason: 'queued', goalMode: gm };
  }

  gm = mergeGoalTasksFromAssistantText(gm, input.assistantText);

  const allTasksDone =
    Array.isArray(gm.tasks) && gm.tasks.length > 0 && gm.tasks.every((t) => t.done);

  if (replyLooksGoalDone(input.assistantText) || allTasksDone) {
    return {
      action: 'stop',
      reason: 'done',
      goalMode: { ...gm, active: false },
      toast: '目标已完成',
    };
  }

  const maxIter = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
  const nextIter = (gm.iteration ?? 0) + 1;
  if (nextIter >= maxIter) {
    return {
      action: 'stop',
      reason: 'max_iter',
      goalMode: { ...gm, active: false, iteration: nextIter },
      toast: `目标模式已达上限（${maxIter} 轮），已停止自动续写`,
    };
  }

  const nextGm: SessionGoalMode = {
    ...gm,
    active: true,
    iteration: nextIter,
    maxIterations: maxIter,
  };
  const displayText = '继续推进目标，若已完成请明确说明 DONE';
  const modelText = [
    buildGoalModePrefix(gm.goal, nextIter, maxIter, nextGm.tasks),
    displayText,
  ].join('\n');
  return { action: 'continue', goalMode: nextGm, displayText, modelText };
}

export function createInitialGoalMode(
  goal: string,
  maxIterations = GOAL_DEFAULT_MAX_ITERATIONS,
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
