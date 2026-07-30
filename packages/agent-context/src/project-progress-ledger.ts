import { BoundedMap } from '@crish/shared-utils';

export type ProjectProgressStatus =
  'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

export interface ProjectProgressClock {
  now(): string;
}

export interface ProjectProgressLedgerOptions {
  now?: () => string;
}

export interface StablePrincipleInput {
  id?: string;
  text: string;
  order?: number;
  updatedAt?: string;
}

export interface StablePrincipleRecord {
  id: string;
  text: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalProgressItemInput {
  id?: string;
  title: string;
  status?: ProjectProgressStatus;
  summary?: string;
  order?: number;
  updatedAt?: string;
}

export interface GlobalProgressItemRecord {
  id: string;
  title: string;
  status: ProjectProgressStatus;
  summary?: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskRecordInput {
  id?: string;
  agentId: string;
  title: string;
  status?: ProjectProgressStatus;
  summary?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface AgentTaskRecord {
  id: string;
  agentId: string;
  title: string;
  status: ProjectProgressStatus;
  summary?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ProjectProgressSnapshotOptions {
  maxPrinciples?: number;
  maxProgressItems?: number;
  maxRecentTasks?: number;
  maxLineLength?: number;
}

export interface ProjectProgressSnapshot {
  principles: StablePrincipleRecord[];
  progressItems: GlobalProgressItemRecord[];
  recentTasks: AgentTaskRecord[];
  stableLines: string[];
  recentTaskLines: string[];
  lines: string[];
}

const DEFAULT_MAX_PRINCIPLES = 20;
const DEFAULT_MAX_PROGRESS_ITEMS = 40;
const DEFAULT_MAX_RECENT_TASKS = 12;
const DEFAULT_MAX_LINE_LENGTH = 180;
/** 台账存储上限：snapshot 只取前 N 条，存储保留 2-3x 余量防止无界增长。 */
const MAX_STORED_PRINCIPLES = 50;
const MAX_STORED_PROGRESS_ITEMS = 100;
const MAX_STORED_TASK_RECORDS = 100;

const STATUS_RANK: Record<ProjectProgressStatus, number> = {
  in_progress: 0,
  blocked: 1,
  pending: 2,
  completed: 3,
  cancelled: 4,
};

export class ProjectProgressLedger {
  private readonly now: () => string;
  private readonly principles = new BoundedMap<string, StablePrincipleRecord>(
    MAX_STORED_PRINCIPLES,
    undefined
  );
  private readonly progressItems = new BoundedMap<
    string,
    GlobalProgressItemRecord
  >(MAX_STORED_PROGRESS_ITEMS, undefined);
  private readonly taskRecords = new BoundedMap<string, AgentTaskRecord>(
    MAX_STORED_TASK_RECORDS,
    undefined
  );

  constructor(options: ProjectProgressLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  addStablePrinciple(input: StablePrincipleInput): StablePrincipleRecord {
    const text = requireNonEmpty(input.text, 'principle text');
    const id = input.id ? normalizeId(input.id) : stableId('principle', text);
    const existingByText = findByCanonicalText(this.principles, text);
    const existing = this.principles.get(id) ?? existingByText;
    const now = input.updatedAt ?? this.now();
    const record: StablePrincipleRecord = {
      id: existing?.id ?? id,
      text,
      order: input.order ?? existing?.order ?? this.principles.size,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing && existing.id !== record.id) {
      this.principles.delete(existing.id);
    }
    this.principles.set(record.id, record);
    return record;
  }

  upsertProgressItem(input: GlobalProgressItemInput): GlobalProgressItemRecord {
    const title = requireNonEmpty(input.title, 'progress title');
    const id = input.id ? normalizeId(input.id) : stableId('progress', title);
    const existingByTitle = findByCanonicalTitle(this.progressItems, title);
    const existing = this.progressItems.get(id) ?? existingByTitle;
    const now = input.updatedAt ?? this.now();
    const summary = optionalText(input.summary) ?? existing?.summary;
    const record: GlobalProgressItemRecord = {
      id: existing?.id ?? id,
      title,
      status: input.status ?? existing?.status ?? 'pending',
      ...(summary !== undefined ? { summary } : {}),
      order: input.order ?? existing?.order ?? this.progressItems.size,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing && existing.id !== record.id) {
      this.progressItems.delete(existing.id);
    }
    this.progressItems.set(record.id, record);
    return record;
  }

  recordSubagentTask(input: AgentTaskRecordInput): AgentTaskRecord {
    const agentId = requireNonEmpty(input.agentId, 'agent id');
    const title = requireNonEmpty(input.title, 'task title');
    const id = input.id
      ? normalizeId(input.id)
      : stableId('task', `${agentId}:${title}`);
    const existing = this.taskRecords.get(id);
    const now = input.updatedAt ?? this.now();
    const summary = optionalText(input.summary) ?? existing?.summary;
    const record: AgentTaskRecord = {
      id,
      agentId,
      title,
      status: input.status ?? existing?.status ?? 'pending',
      ...(summary !== undefined ? { summary } : {}),
      startedAt: input.startedAt ?? existing?.startedAt ?? now,
      updatedAt: now,
    };
    this.taskRecords.set(id, record);
    return record;
  }

  renderStableProgressLines(
    options: ProjectProgressSnapshotOptions = {}
  ): string[] {
    return snapshotProjectProgress(this, options).stableLines;
  }

  renderRecentTaskLines(
    options: ProjectProgressSnapshotOptions = {}
  ): string[] {
    return snapshotProjectProgress(this, options).recentTaskLines;
  }

  snapshotForSubagentContext(
    options: ProjectProgressSnapshotOptions = {}
  ): ProjectProgressSnapshot {
    return snapshotProjectProgress(this, options);
  }

  getStablePrinciples(): StablePrincipleRecord[] {
    return sortPrinciples([...this.principles.values()]);
  }

  getProgressItems(): GlobalProgressItemRecord[] {
    return sortProgressItems([...this.progressItems.values()]);
  }

  getTaskRecords(): AgentTaskRecord[] {
    return sortTasks([...this.taskRecords.values()]);
  }
}

export function renderStableProgressLines(
  ledger: ProjectProgressLedger,
  options: ProjectProgressSnapshotOptions = {}
): string[] {
  return ledger.renderStableProgressLines(options);
}

export function renderRecentSubagentTaskLines(
  ledger: ProjectProgressLedger,
  options: ProjectProgressSnapshotOptions = {}
): string[] {
  return ledger.renderRecentTaskLines(options);
}

export function snapshotForSubagentContext(
  ledger: ProjectProgressLedger,
  options: ProjectProgressSnapshotOptions = {}
): ProjectProgressSnapshot {
  return ledger.snapshotForSubagentContext(options);
}

export function snapshotProjectProgress(
  ledger: ProjectProgressLedger,
  options: ProjectProgressSnapshotOptions = {}
): ProjectProgressSnapshot {
  const maxPrinciples = options.maxPrinciples ?? DEFAULT_MAX_PRINCIPLES;
  const maxProgressItems =
    options.maxProgressItems ?? DEFAULT_MAX_PROGRESS_ITEMS;
  const maxRecentTasks = options.maxRecentTasks ?? DEFAULT_MAX_RECENT_TASKS;
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;

  const principles = ledger.getStablePrinciples().slice(0, maxPrinciples);
  const progressItems = ledger.getProgressItems().slice(0, maxProgressItems);
  const recentTasks = ledger.getTaskRecords().slice(0, maxRecentTasks);
  const stableLines = uniqueLines([
    ...principles.map((item) =>
      clampLine(`Principle: ${item.text}`, maxLineLength)
    ),
    ...progressItems.map((item) =>
      clampLine(
        `Progress[${item.status}]: ${item.title}${item.summary ? ` - ${item.summary}` : ''}`,
        maxLineLength
      )
    ),
  ]);
  const recentTaskLines = uniqueLines(
    recentTasks.map((task) =>
      clampLine(
        `Task[${task.status}]: ${task.agentId}/${task.id} - ${task.title}${task.summary ? ` - ${task.summary}` : ''}`,
        maxLineLength
      )
    )
  );
  const lines = uniqueLines([...stableLines, ...recentTaskLines]);

  return {
    principles,
    progressItems,
    recentTasks,
    stableLines,
    recentTaskLines,
    lines,
  };
}

function sortPrinciples(
  records: StablePrincipleRecord[]
): StablePrincipleRecord[] {
  return records.sort(
    (left, right) =>
      left.order - right.order ||
      left.text.localeCompare(right.text) ||
      left.id.localeCompare(right.id)
  );
}

function sortProgressItems(
  records: GlobalProgressItemRecord[]
): GlobalProgressItemRecord[] {
  return records.sort(
    (left, right) =>
      STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
      left.order - right.order ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
  );
}

function sortTasks(records: AgentTaskRecord[]): AgentTaskRecord[] {
  return records.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.agentId.localeCompare(right.agentId) ||
      left.id.localeCompare(right.id)
  );
}

function findByCanonicalText<T extends { id: string; text: string }>(
  records: { values(): Iterable<T> },
  text: string
): T | undefined {
  const canonical = canonicalText(text);
  return [...records.values()].find(
    (record) => canonicalText(record.text) === canonical
  );
}

function findByCanonicalTitle<T extends { id: string; title: string }>(
  records: { values(): Iterable<T> },
  title: string
): T | undefined {
  const canonical = canonicalText(title);
  return [...records.values()].find(
    (record) => canonicalText(record.title) === canonical
  );
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = collapseWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function canonicalText(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

function normalizeId(value: string): string {
  return requireNonEmpty(value, 'id');
}

function stableId(prefix: string, value: string): string {
  let hash = 5381;
  for (const char of canonicalText(value)) {
    hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}

function clampLine(value: string, maxLineLength: number): string {
  const normalized = collapseWhitespace(value);
  if (maxLineLength <= 0 || normalized.length <= maxLineLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLineLength - 1)).trimEnd()}...`;
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const canonical = canonicalText(line);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(line);
    }
  }
  return result;
}
