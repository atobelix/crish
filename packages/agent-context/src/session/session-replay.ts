import type {
  AgentMessage,
  ContextCompressionRecord,
} from '@crish/shared-types';
import { SessionError } from '@crish/shared-types';
import type { SessionEntry, SessionPersistenceStore } from '../_runtime-types';
import type {
  MoveSessionLeafOptions,
  MoveSessionLeafResult,
  SessionLeafPointerEntry,
} from './session-types';

export function createId(prefix = 'id'): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

/**
 * 生成不与已知 ID 冲突的条目 ID。
 *
 * 对齐 Pi 的 generateEntryId 模式：在极小概率的 UUID 碰撞下重试最多 100 次，
 * 仍碰撞则退化为带时间戳的随机 ID。prefix 用于区分条目类型。
 */
export function generateUniqueEntryId(
  prefix: string,
  usedIds: { has(key: string): boolean }
): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = createId(prefix);
    if (!usedIds.has(id)) {
      return id;
    }
  }
  // 100 次仍碰撞，退化为带更高熵的 ID
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${globalThis.crypto?.randomUUID?.() ?? ''}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createTextMessage(
  role: AgentMessage['role'],
  text: string,
  metadata?: AgentMessage['metadata']
): AgentMessage {
  return {
    id: createId(role),
    role,
    createdAt: nowIso(),
    blocks: text ? [{ type: 'text', text }] : [],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function pruneHistoricalToolOutputs(
  messages: AgentMessage[],
  keepLastN: number = 10
): void {
  let toolOutputCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'tool') {
      toolOutputCount++;
      if (toolOutputCount > keepLastN) {
        messages[i] = {
          ...msg,
          blocks: [{ type: 'text', text: '[truncated]' }],
        };
      }
    }
  }
}

export function createCompactionSummaryAgentMessage(
  record: ContextCompressionRecord
): AgentMessage {
  return {
    id: record.id,
    role: 'user',
    createdAt: record.createdAt,
    blocks: [
      {
        type: 'text',
        text: `<context_checkpoint>\n${record.summary.trim()}\n</context_checkpoint>`,
      },
    ],
    metadata: {
      kind: 'context-compression-summary',
      compactionId: record.id,
      trigger: record.trigger,
      tokensBefore: record.tokensBefore,
      tokensAfter: record.tokensAfter,
    },
  };
}

export function buildSessionContextFromEntries(
  entries: SessionEntry[],
  leafId: string | null = findSessionLeafId(entries)
): AgentMessage[] {
  const path = buildSessionPath(entries, leafId);
  const latestCompactionIndex = findLatestCompactionIndex(path);
  if (latestCompactionIndex === -1) {
    return path.flatMap((entry) =>
      entry.type === 'message' ? [entry.message] : []
    );
  }

  const compaction = path[latestCompactionIndex]!;
  if (compaction.type !== 'compaction') {
    return [];
  }

  const keptIds = new Set(compaction.record.keptMessageIds);
  const keptBeforeCompaction = path
    .slice(0, latestCompactionIndex)
    .flatMap((entry) =>
      entry.type === 'message' && keptIds.has(entry.message.id)
        ? [entry.message]
        : []
    );
  const afterCompaction = path
    .slice(latestCompactionIndex + 1)
    .flatMap((entry) => (entry.type === 'message' ? [entry.message] : []));

  return [
    createCompactionSummaryAgentMessage(compaction.record),
    ...keptBeforeCompaction,
    ...afterCompaction,
  ];
}

export function findSessionLeafId(entries: SessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === 'leaf-pointer') {
      return entry.targetLeafId;
    }
    if (
      entry.type === 'message' ||
      entry.type === 'checkpoint' ||
      entry.type === 'compaction'
    ) {
      return entry.id;
    }
  }
  return null;
}

export function findLatestCompactionIndex(entries: SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === 'compaction') return index;
  }
  return -1;
}

export function assertValidSessionLeafTarget(
  entries: SessionEntry[],
  targetLeafId: string | null
): void {
  if (targetLeafId === null) return;
  const target = entries.find((entry) => entry.id === targetLeafId);
  if (!target) {
    throw new SessionError(
      `Session leaf target ${targetLeafId} not found`,
      'not_found'
    );
  }
  if (target.type === 'event' || target.type === 'leaf-pointer') {
    throw new SessionError(
      `Session leaf target ${targetLeafId} must be a message, checkpoint, or compaction entry`,
      'invalid_entry'
    );
  }
}

export function buildSessionPath(
  entries: SessionEntry[],
  leafId: string | null
): SessionEntry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const reversedPath: SessionEntry[] = [];
  const seen = new Set<string>();
  let currentId: string | null = leafId;

  while (currentId !== null) {
    if (seen.has(currentId)) {
      throw new SessionError(
        `Session entry parent cycle detected at ${currentId}`,
        'invalid_session'
      );
    }
    const entry = byId.get(currentId);
    if (!entry) {
      if (reversedPath.length === 0) {
        throw new SessionError(
          `Session entry ${currentId} not found`,
          'not_found'
        );
      }
      break;
    }
    seen.add(currentId);
    if (entry.type === 'leaf-pointer') {
      currentId = entry.targetLeafId;
      continue;
    }
    reversedPath.push(entry);
    currentId = entry.parentId;
  }

  return reversedPath.reverse();
}

export async function moveSessionLeaf(
  store: SessionPersistenceStore,
  targetLeafId: string | null,
  options: MoveSessionLeafOptions = {},
  recordLeafPointerFn?: (
    targetLeafId: string | null,
    reason?: string,
    metadata?: AgentMessage['metadata']
  ) => Promise<SessionLeafPointerEntry>
): Promise<MoveSessionLeafResult> {
  if (!store.readAll) {
    throw new SessionError(
      'Session store must support readAll before moving the session leaf',
      'invalid_state'
    );
  }

  const entries = await store.readAll();
  assertValidSessionLeafTarget(entries, targetLeafId);
  const previousLeafId = findSessionLeafId(entries);
  let pointerEntry: SessionLeafPointerEntry;
  if (recordLeafPointerFn) {
    pointerEntry = await recordLeafPointerFn(
      targetLeafId,
      options.reason,
      options.metadata
    );
  } else {
    const { SessionRecorder } = await import('./session-storage');
    const recorder = new SessionRecorder(store, previousLeafId);
    pointerEntry = await recorder.recordLeafPointer(
      targetLeafId,
      options.reason,
      options.metadata
    );
  }

  return {
    previousLeafId,
    targetLeafId,
    pointerEntry,
  };
}
