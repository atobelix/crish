/**
 * Lightweight script wait policy — keep AI and users comfortable, not over-engineered.
 *
 * Goals:
 * - Prefer real waiting over tiny poll loops that burn tokens
 * - Allow short background work without blocking the model forever
 * - Never kill scripts just so the model can keep talking
 */

import { BoundedMap } from '@crish/shared-utils';

/** 任务元数据上限：后台任务完成后保留供查询，超过后按 FIFO 淘汰。 */
const MAX_SCRIPT_TASK_METAS = 200;

export type ScriptRunMode = 'wait' | 'continue';

export interface ScriptTaskMeta {
  taskId: string;
  command: string;
  family: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  mode: ScriptRunMode;
  pollTimes: number[];
}

export interface PollAdvice {
  /** If true, tools should block on wait instead of returning "still running". */
  forceWait: boolean;
  /** Short note for the model (also fine to show users in details). */
  hint: string;
  pollCount: number;
  runningMs: number;
}

/** Soft parallel budget: after this, prefer waiting over more model turns. */
export const PARALLEL_SOFT_LIMIT_MS = 120_000;

/** If the model polls faster than this repeatedly, treat as noisy. */
export const NOISY_POLL_GAP_MS = 20_000;

/** How many short polls before we nudge / force a real wait. */
export const NOISY_POLL_THRESHOLD = 3;

export function commandFamily(command: string): string {
  const raw = command.trim().toLowerCase();
  if (!raw) return 'other';
  // Cheap fingerprint: first 1–2 tokens, ignore flags/paths noise
  const tokens = raw
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !t.startsWith('-') && !t.includes('/') && !t.includes('\\'));
  const head = tokens.slice(0, 2).join(' ');
  if (/npm|pnpm|yarn|bun/.test(head)) {
    if (/test|vitest|jest/.test(raw)) return 'package-test';
    if (/build|compile/.test(raw)) return 'package-build';
    if (/install|ci/.test(raw)) return 'package-install';
    return 'package-script';
  }
  if (/cargo|go |dotnet|mvn|gradle|make|cmake/.test(raw)) return 'native-build';
  if (/pytest|python -m pytest/.test(raw)) return 'python-test';
  return head || 'other';
}

/**
 * Suggest wait vs continue from history + command shape.
 * Simple heuristics only — no ML.
 */
export function suggestRunMode(
  command: string,
  avgDurationMs?: number
): ScriptRunMode {
  if (avgDurationMs !== undefined) {
    if (avgDurationMs < 15_000) return 'wait';
    if (avgDurationMs > 90_000) return 'continue';
  }
  const raw = command.toLowerCase();
  // Long-ish by nature
  if (/install|build|compile|test|e2e|benchmark|migrate|seed/.test(raw))
    return 'continue';
  // Usually quick
  if (/git status|git diff|ls |dir |echo |type |cat /.test(raw)) return 'wait';
  return 'continue';
}

export class ScriptWaitPolicy {
  private readonly tasks = new BoundedMap<string, ScriptTaskMeta>(
    MAX_SCRIPT_TASK_METAS,
    undefined
  );
  /** Rolling average duration by command family */
  private readonly familyDurations = new BoundedMap<string, number[]>(
    100,
    undefined
  );

  registerStart(
    taskId: string,
    command: string,
    mode?: ScriptRunMode
  ): ScriptTaskMeta {
    const family = commandFamily(command);
    const avg = this.averageDuration(family);
    const resolvedMode = mode ?? suggestRunMode(command, avg);
    const meta: ScriptTaskMeta = {
      taskId,
      command,
      family,
      startedAt: Date.now(),
      mode: resolvedMode,
      pollTimes: [],
    };
    this.tasks.set(taskId, meta);
    return meta;
  }

  registerEnd(taskId: string, durationMs?: number): void {
    const meta = this.tasks.get(taskId);
    if (!meta) return;
    const endedAt = Date.now();
    const duration = durationMs ?? endedAt - meta.startedAt;
    meta.endedAt = endedAt;
    meta.durationMs = duration;
    const list = this.familyDurations.get(meta.family) ?? [];
    list.push(duration);
    // Keep last 20 samples per family
    if (list.length > 20) list.shift();
    this.familyDurations.set(meta.family, list);
  }

  getMeta(taskId: string): ScriptTaskMeta | undefined {
    return this.tasks.get(taskId);
  }

  averageDuration(family: string): number | undefined {
    const list = this.familyDurations.get(family);
    if (!list || list.length === 0) return undefined;
    return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
  }

  /**
   * Called when the model checks status (get) without waiting.
   */
  recordPoll(taskId: string, runningMs: number): PollAdvice {
    const meta = this.tasks.get(taskId);
    if (!meta) {
      return {
        forceWait: false,
        hint: '任务状态已更新。',
        pollCount: 0,
        runningMs,
      };
    }
    const now = Date.now();
    meta.pollTimes.push(now);
    // Keep recent polls only
    meta.pollTimes = meta.pollTimes.filter((t) => now - t < 5 * 60_000);
    const pollCount = meta.pollTimes.length;
    const avg = this.averageDuration(meta.family);

    // Recent gaps between polls
    let shortGaps = 0;
    for (let i = 1; i < meta.pollTimes.length; i++) {
      if (meta.pollTimes[i]! - meta.pollTimes[i - 1]! < NOISY_POLL_GAP_MS)
        shortGaps += 1;
    }

    const noisy =
      pollCount >= NOISY_POLL_THRESHOLD &&
      shortGaps >= NOISY_POLL_THRESHOLD - 1;
    const longRunner =
      runningMs >= PARALLEL_SOFT_LIMIT_MS ||
      (avg !== undefined && avg >= PARALLEL_SOFT_LIMIT_MS);

    if (noisy && longRunner) {
      return {
        forceWait: true,
        hint: '这个任务通常较久，短间隔反复查看会浪费时间。系统已改为等待任务结束后再返回结果，请不要继续高频检查。',
        pollCount,
        runningMs,
      };
    }

    if (noisy && avg !== undefined && avg < 30_000) {
      return {
        forceWait: true,
        hint: '这类命令通常很快结束。请直接等待完成，不要反复轮询。',
        pollCount,
        runningMs,
      };
    }

    if (runningMs >= PARALLEL_SOFT_LIMIT_MS) {
      return {
        forceWait: false,
        hint: '后台任务已运行超过约 2 分钟。建议使用「等待任务结束」，而不是一边输出一边频繁查看。系统不会为了继续对话而结束该进程。',
        pollCount,
        runningMs,
      };
    }

    if (pollCount >= 2) {
      return {
        forceWait: false,
        hint: '若暂时没有其它独立工作，请使用 wait 等待任务结束，比多次查询更省事。',
        pollCount,
        runningMs,
      };
    }

    return {
      forceWait: false,
      hint: '任务仍在运行。',
      pollCount,
      runningMs,
    };
  }

  /** Human-readable start guidance for tool results */
  startGuidance(meta: ScriptTaskMeta): string {
    if (meta.mode === 'wait') {
      return '将等待该命令结束后再继续（适合短命令）。';
    }
    return [
      '已在后台启动。你可以先做其它不依赖其结果的工作。',
      '需要结果时请调用等待接口，不要每几秒查一次。',
      '系统不会为了让你继续说话而强行结束仍在运行的正常进程。',
    ].join(' ');
  }
}

/** Shared singleton for a process/runtime process (simple, no DI maze). */
let sharedPolicy: ScriptWaitPolicy | undefined;

export function getSharedScriptWaitPolicy(): ScriptWaitPolicy {
  if (!sharedPolicy) sharedPolicy = new ScriptWaitPolicy();
  return sharedPolicy;
}

export function resetSharedScriptWaitPolicyForTests(): void {
  sharedPolicy = new ScriptWaitPolicy();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m${rem}s` : `${min}m`;
}
