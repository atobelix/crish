/**
 * 后台常驻任务：列表 + 输出（经 Tauri sidecar）。
 * 展示在运行状态；点击后在终端面板展开详情。
 */

import { invokeCmd } from './tauriInvoke';

export type BackgroundTaskInfo = {
  id: string;
  label: string;
  state: string;
  command?: string;
  startedAt?: number;
  summary?: string;
};

function asTask(raw: Record<string, unknown>): BackgroundTaskInfo | null {
  const id = String(raw.id ?? raw.taskId ?? raw.task_id ?? '');
  if (!id) return null;
  const state = String(raw.state ?? raw.status ?? 'unknown');
  const command =
    (typeof raw.command === 'string' && raw.command) ||
    (typeof raw.cmd === 'string' && raw.cmd) ||
    undefined;
  const label =
    (typeof raw.label === 'string' && raw.label) ||
    (typeof raw.name === 'string' && raw.name) ||
    (command ? command.slice(0, 64) : id);
  const startedAt =
    typeof raw.startedAt === 'number'
      ? raw.startedAt
      : typeof raw.started_at === 'number'
        ? raw.started_at
        : typeof raw.startedAt === 'string'
          ? Date.parse(raw.startedAt) || undefined
          : undefined;
  return {
    id,
    label,
    state,
    command,
    startedAt,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
  };
}

export async function listBackgroundTasks(): Promise<BackgroundTaskInfo[]> {
  const data = await invokeCmd<unknown>('workbench_list_background_tasks');
  if (!data) return [];
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { tasks?: unknown[] }).tasks)
      ? (data as { tasks: unknown[] }).tasks
      : [];
  return arr
    .map((x) => (x && typeof x === 'object' ? asTask(x as Record<string, unknown>) : null))
    .filter((x): x is BackgroundTaskInfo => Boolean(x));
}

export async function getBackgroundTaskOutput(taskId: string): Promise<string> {
  const data = await invokeCmd<unknown>('workbench_get_background_task_output', { taskId });
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (typeof o.output === 'string') return o.output;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

/** 将任务输出推到终端面板 */
export function openBackgroundTaskInTerminal(title: string, output: string): void {
  const lines = (output || '（无输出）').split(/\r?\n/).slice(0, 400);
  window.dispatchEvent(
    new CustomEvent('crish-terminal-append', {
      detail: { title, lines },
    }),
  );
  window.dispatchEvent(new CustomEvent('crish-open-terminal'));
}
