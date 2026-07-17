import type { WorkflowDefinition, WorkflowRunEntry } from "./types.js";
import { type WorkflowStore, WorkflowStoreConflictError } from "./workflow-store.js";
import { AsyncMutex } from "@crish/shared-utils";

/**
 * 串行化 tickScheduler 调用的进程级互斥锁。
 *
 * 定时调度与手动触发可能并发进入 tickScheduler，跨 await 的 read-then-trigger
 * 会让两个 tick 拿到相同的 due 列表，导致第二次 trigger 抛 WorkflowStoreConflictError。
 * 该互斥锁确保任意时刻只有一个 tick 在执行 critical section，从根源上消除竞态。
 */
const tickMutex = new AsyncMutex();

export interface WorkflowDueRun {
  workflow: WorkflowDefinition;
  scheduledFor: string;
  reason: "daily" | "intervalMinutes";
}

export interface WorkflowSchedulerTickResult {
  due: WorkflowDueRun[];
  triggered: WorkflowRunAccepted[];
}

export interface WorkflowRunAccepted {
  accepted: true;
  runId: string;
  workflowRunId: string;
  run: WorkflowRunEntry;
}

export interface WorkflowSchedulerOptions {
  store: WorkflowStore;
  triggerWorkflow?: (due: WorkflowDueRun, now: Date) => Promise<WorkflowRunAccepted>;
}

export class WorkflowScheduler {
  constructor(private readonly options: WorkflowSchedulerOptions) {}

  async getDueWorkflows(now: Date = new Date()): Promise<WorkflowDueRun[]> {
    const [workflows, runs] = await Promise.all([
      this.options.store.listWorkflows(),
      this.options.store.listRuns(),
    ]);
    return calculateDueWorkflowRuns(workflows, runs, now);
  }

  async tickScheduler(now: Date = new Date()): Promise<WorkflowSchedulerTickResult> {
    return tickMutex.runExclusive(async () => {
      const due = await this.getDueWorkflows(now);
      const triggered: WorkflowRunAccepted[] = [];

      if (this.options.triggerWorkflow) {
        for (const item of due) {
          try {
            triggered.push(await this.options.triggerWorkflow(item, now));
          } catch (error) {
            // WorkflowStoreConflictError 表示该项已被其他 tick/进程触发，
            // 属于预期的非 fatal 情况：跳过该项，继续处理后续 due 项。
            if (error instanceof WorkflowStoreConflictError) continue;
            throw error;
          }
        }
      }

      return { due, triggered };
    });
  }
}

export function calculateDueWorkflowRuns(
  workflows: readonly WorkflowDefinition[],
  runs: readonly WorkflowRunEntry[],
  now: Date
): WorkflowDueRun[] {
  const due: WorkflowDueRun[] = [];

  for (const workflow of workflows) {
    if (!workflow.enabled) continue;

    if (workflow.schedule.type === "daily") {
      const scheduledFor = calculateDailyScheduledFor(workflow, now);
      if (!scheduledFor) continue;
      if (hasWorkflowRunForSchedule(runs, workflow.id, scheduledFor)) continue;
      due.push({ workflow, scheduledFor, reason: "daily" });
      continue;
    }

    if (workflow.schedule.type === "intervalMinutes") {
      const scheduledFor = calculateIntervalScheduledFor(workflow, runs, now);
      if (!scheduledFor) continue;
      if (hasWorkflowRunForSchedule(runs, workflow.id, scheduledFor)) continue;
      due.push({ workflow, scheduledFor, reason: "intervalMinutes" });
    }
  }

  return due.sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
}

function calculateDailyScheduledFor(
  workflow: WorkflowDefinition,
  now: Date
): string | undefined {
  if (workflow.schedule.type !== "daily") return undefined;

  const createdAtMs = Date.parse(workflow.createdAt);
  if (!Number.isFinite(createdAtMs)) return undefined;

  const parts = zonedDateParts(now, workflow.schedule.timezone);
  const [hourText, minuteText] = workflow.schedule.time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const scheduled = zonedLocalTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute,
      second: 0,
    },
    workflow.schedule.timezone
  );

  if (scheduled.getTime() > now.getTime()) return undefined;
  if (scheduled.getTime() < createdAtMs) return undefined;
  return scheduled.toISOString();
}

function calculateIntervalScheduledFor(
  workflow: WorkflowDefinition,
  runs: readonly WorkflowRunEntry[],
  now: Date
): string | undefined {
  if (workflow.schedule.type !== "intervalMinutes") return undefined;

  const intervalMs = workflow.schedule.intervalMinutes * 60_000;
  const createdAtMs = Date.parse(workflow.createdAt);
  if (!Number.isFinite(createdAtMs)) return undefined;

  const previousRuns = runs
    .filter((run) => run.workflowId === workflow.id)
    .map((run) => Date.parse(run.scheduledFor))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  const anchorMs = previousRuns.at(-1) ?? createdAtMs;
  const nextMs = anchorMs + intervalMs;
  if (nextMs > now.getTime()) return undefined;
  return new Date(nextMs).toISOString();
}

function hasWorkflowRunForSchedule(
  runs: readonly WorkflowRunEntry[],
  workflowId: string,
  scheduledFor: string
): boolean {
  return runs.some((run) => run.workflowId === workflowId && run.scheduledFor === scheduledFor);
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = getFormatter(timeZone);
  const values = new Map<string, string>();
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values.set(part.type, part.value);
    }
  }

  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function zonedLocalTimeToUtc(parts: ZonedDateParts, timeZone: string): Date {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
  let utcMs = localAsUtc;

  for (let index = 0; index < 3; index += 1) {
    const offsetMs = timeZoneOffsetMs(new Date(utcMs), timeZone);
    const adjustedMs = localAsUtc - offsetMs;
    if (adjustedMs === utcMs) break;
    utcMs = adjustedMs;
  }

  return new Date(utcMs);
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedDateParts(date, timeZone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
  return zonedAsUtc - date.getTime();
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}
