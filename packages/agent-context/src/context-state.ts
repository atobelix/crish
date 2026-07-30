import { BoundedMap, BoundedArray, toJsonValue } from '@crish/shared-utils';
import { createId, nowIso } from './session';
import type {
  AgentTool,
  ContextCompressionRecord,
  JsonObject,
  JsonValue,
  RuntimeCheckpointRecord,
} from '@crish/shared-types';
import type {
  ContextStateReader,
  ContextStateSnapshot,
} from './_runtime-types';

/**
 * Identity helper for tool definition.
 *
 * agent-context 是 Layer 2 leaf，不持有全局工具注册表（那是 runtime 层的职责）。
 * 此函数仅做类型检查并返回工具对象本身；运行时消费者可在装配时自行注册。
 */
function defineTool<T extends AgentTool>(tool: T): T {
  return tool;
}

/** 任务台账上限：保留最近的任务记录，超容量淘汰最旧的*/
const MAX_CONTEXT_TASKS = 100;
/** 会话事件上限：snapshotForCompression 只取最近 40 条，保留 5x 余量*/
const MAX_SESSION_EVENTS = 200;
/** 文件快照提示上限：snapshotForCompression 只取最?40 条，保留 5x 余量?*/
const MAX_FILE_HINTS = 200;

export interface ContextTask {
  id: string;
  title: string;
  status: 'pending' | 'completed';
  summary?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEventNote {
  id: string;
  text: string;
  createdAt: string;
  compressionWindow: number;
}

export interface FileSnapshotHint {
  id: string;
  path: string;
  reason: string;
  snapshotId?: string | undefined;
  createdAt: string;
}

export class InMemoryContextState implements ContextStateReader {
  private readonly tasks = new BoundedMap<string, ContextTask>(
    MAX_CONTEXT_TASKS,
    undefined
  );
  private readonly events = new BoundedArray<SessionEventNote>(
    MAX_SESSION_EVENTS
  );
  private readonly fileHints = new BoundedArray<FileSnapshotHint>(
    MAX_FILE_HINTS
  );
  private compressionWindow = 0;
  private previousCompressionSummary: string | undefined;

  addTask(title: string, id = createId('task')): ContextTask {
    const now = nowIso();
    const task: ContextTask = {
      id,
      title,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    return task;
  }

  completeTask(id: string, summary: string): ContextTask {
    const existing = this.tasks.get(id);
    const now = nowIso();
    const task: ContextTask = {
      id,
      title: existing?.title ?? id,
      status: 'completed',
      summary,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    return task;
  }

  recordEvent(text: string): SessionEventNote {
    const event = {
      id: createId('evt'),
      text: text.trim(),
      createdAt: nowIso(),
      compressionWindow: this.compressionWindow,
    };
    this.events.push(event);
    return event;
  }

  markFileSnapshot(
    path: string,
    reason: string,
    snapshotId?: string
  ): FileSnapshotHint {
    const hint = {
      id: createId('file'),
      path,
      reason,
      snapshotId,
      createdAt: nowIso(),
    };
    this.fileHints.push(hint);
    return hint;
  }

  recordCheckpoint(checkpoint: RuntimeCheckpointRecord): void {
    if (checkpoint.kind === 'file-snapshot' && checkpoint.sourcePath) {
      this.markFileSnapshot(
        checkpoint.sourcePath,
        `snapshot: ${checkpoint.label}`,
        checkpoint.id
      );
      return;
    }

    const filePaths = stringArrayValue(checkpoint.metadata?.filePaths);
    for (const path of filePaths) {
      this.markFileSnapshot(
        path,
        `checkpoint: ${checkpoint.label}`,
        checkpoint.id
      );
    }
  }

  snapshotForCompression(): ContextStateSnapshot {
    const eventWindowFloor = Math.max(0, this.compressionWindow - 1);
    const completedTaskSummaries = [...this.tasks.values()]
      .filter((task) => task.status === 'completed' && task.summary)
      .map((task) => `${task.title}: ${task.summary}`);
    const pendingTasks = [...this.tasks.values()]
      .filter((task) => task.status === 'pending')
      .map((task) => `${task.id}: ${task.title}`);
    const sessionEvents = this.events
      .filter((event) => event.compressionWindow >= eventWindowFloor)
      .slice(-40)
      .map((event) => `${event.createdAt}: ${event.text}`);
    const fileSnapshotHints = this.fileHints
      .slice(-40)
      .map(
        (hint) =>
          `${hint.path}: ${hint.reason}${hint.snapshotId ? ` (${hint.snapshotId})` : ''}`
      );

    return {
      completedTaskSummaries,
      pendingTasks,
      sessionEvents,
      fileSnapshotHints,
      previousCompressionSummary: this.previousCompressionSummary,
    };
  }

  recordCompression(record: ContextCompressionRecord): void {
    this.compressionWindow += 1;
    this.previousCompressionSummary = record.summary;
  }
}

export function createContextStateTools(
  state: InMemoryContextState
): AgentTool[] {
  return [
    defineTool({
      name: 'record_task',
      label: 'Record task',
      description:
        'Record or update a concise task ledger entry for context continuity.',
      category: 'internal',
      concurrency: 'parallel',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      summarize(input: JsonObject) {
        return `record task ${stringField(input, 'title') ?? ''}`.trim();
      },
      async execute(input: JsonObject) {
        const task = state.addTask(
          requireString(input, 'title'),
          stringField(input, 'id') ?? undefined
        );
        return {
          text: `Recorded task ${task.id}: ${task.title}`,
          json: toJsonValue(task),
        };
      },
    }),
    defineTool({
      name: 'complete_task',
      label: 'Complete task',
      description: 'Mark a task as completed with a concise handoff summary.',
      category: 'internal',
      concurrency: 'parallel',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['id', 'summary'],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      summarize(input: JsonObject) {
        return `complete task ${stringField(input, 'id') ?? ''}`.trim();
      },
      async execute(input: JsonObject) {
        const task = state.completeTask(
          requireString(input, 'id'),
          requireString(input, 'summary')
        );
        return {
          text: `Completed task ${task.id}: ${task.summary}`,
          json: toJsonValue(task),
        };
      },
    }),
    defineTool({
      name: 'record_session_event',
      label: 'Record session event',
      description:
        'Record a short session-level event that can survive context compression.',
      category: 'internal',
      concurrency: 'parallel',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      summarize(input: JsonObject) {
        return `record event ${stringField(input, 'text')?.slice(0, 80) ?? ''}`.trim();
      },
      async execute(input: JsonObject) {
        const event = state.recordEvent(requireString(input, 'text'));
        return {
          text: `Recorded event: ${event.text}`,
          json: toJsonValue(event),
        };
      },
    }),
    defineTool({
      name: 'mark_file_snapshot',
      label: 'Mark file snapshot',
      description:
        'Mark an important file or snapshot as evidence for future context compression.',
      category: 'internal',
      concurrency: 'parallel',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
          snapshotId: { type: 'string' },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      summarize(input: JsonObject) {
        return `mark file ${stringField(input, 'path') ?? ''}`.trim();
      },
      async execute(input: JsonObject) {
        const hint = state.markFileSnapshot(
          requireString(input, 'path'),
          requireString(input, 'reason'),
          stringField(input, 'snapshotId')
        );
        return {
          text: `Marked file snapshot: ${hint.path}`,
          json: toJsonValue(hint),
        };
      },
    }),
  ];
}

function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function stringArrayValue(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === 'string' && item.length > 0
      )
    : [];
}
