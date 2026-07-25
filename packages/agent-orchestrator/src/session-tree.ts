import { BoundedMap } from "@crish/shared-utils";
import { SessionError, type JsonObject } from "@crish/shared-types";
import type { OrchestratorSessionRecord } from "./types";

/**
 * 默认条目容量上限。
 *
 * session tree 的 entries 代表会话分支历史（节点 + 分支摘要）。500 条覆盖典型长会话；
 * 超出时按 FIFO 淘汰最旧条目，旧分支路径将不可回溯（readBranchPath 会抛 not found）。
 * 需要更长历史的调用方可通过 SessionTreeOptions.maxEntries 提升。
 */
const DEFAULT_MAX_ENTRIES = 500;

export type SessionTreeLeafId = string | null;
export type SessionTreeEntryType = "node" | "branch_summary";

export interface SessionTreeBaseEntry {
  id: string;
  parentId: string | null;
  createdAt: string;
}

export interface SessionTreeNodeEntry<TPayload = JsonObject> extends SessionTreeBaseEntry {
  type: "node";
  payload: TPayload;
}

export interface SessionTreeBranchSummaryEntry<TDetails = JsonObject> extends SessionTreeBaseEntry {
  type: "branch_summary";
  summary: string;
  abandonedLeafId: string | null;
  details?: TDetails;
}

export type SessionTreeEntry<TPayload = JsonObject, TDetails = JsonObject> =
  | SessionTreeNodeEntry<TPayload>
  | SessionTreeBranchSummaryEntry<TDetails>;

export interface SessionTreeSnapshot<TPayload = JsonObject, TDetails = JsonObject> {
  entries: SessionTreeEntry<TPayload, TDetails>[];
  currentLeafId?: OrchestratorSessionRecord["currentLeafId"];
}

export interface SessionTreeOptions<TPayload = JsonObject, TDetails = JsonObject> {
  entries?: readonly SessionTreeEntry<TPayload, TDetails>[];
  currentLeafId?: OrchestratorSessionRecord["currentLeafId"] | null;
  now?: () => string;
  createId?: (prefix: string) => string;
  /** 条目容量上限，超出按 FIFO 淘汰最旧。默认 500。 */
  maxEntries?: number;
}

export interface SessionTreeAppendNodeInput<TPayload = JsonObject> {
  id?: string;
  createdAt?: string;
  payload: TPayload;
}

export interface SessionTreeBranchSummaryInput<TDetails = JsonObject> {
  id?: string;
  createdAt?: string;
  summary: string;
  details?: TDetails;
}

export type SessionTreeLeafSource = Pick<OrchestratorSessionRecord, "currentLeafId"> | string | null | undefined;

export class SessionTree<TPayload = JsonObject, TDetails = JsonObject> {
  private readonly maxEntries: number;
  private readonly byId: BoundedMap<string, SessionTreeEntry<TPayload, TDetails>>;
  private currentLeafId: string | null = null;
  private lastInsertedId: string | null = null;
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  constructor(options: SessionTreeOptions<TPayload, TDetails> = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? defaultCreateId;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.byId = new BoundedMap<string, SessionTreeEntry<TPayload, TDetails>>(this.maxEntries, undefined);
    this.loadEntries(options.entries ?? []);
    this.restoreLeaf(options.currentLeafId);
  }

  getCurrentLeafId(): string | null {
    return this.currentLeafId;
  }

  getEntries(): SessionTreeEntry<TPayload, TDetails>[] {
    // 返回 byId.values() 的新数组（浅拷贝引用，不逐条 clone）。
    // 调用方仅读取（filter/map/.id），不修改条目本身；内部条目仍受 appendEntry 的 cloneEntry 隔离保护。
    return this.byId.values();
  }

  getEntry(id: string): SessionTreeEntry<TPayload, TDetails> | undefined {
    const entry = this.byId.get(id);
    return entry ? cloneEntry(entry) : undefined;
  }

  appendNode(input: SessionTreeAppendNodeInput<TPayload>): SessionTreeNodeEntry<TPayload> {
    const entry = this.createNode(input, this.currentLeafId);
    this.appendEntry(entry);
    return cloneEntry(entry);
  }

  forkBranch(fromId: string | null, input: SessionTreeAppendNodeInput<TPayload>): SessionTreeNodeEntry<TPayload> {
    this.assertValidLeafTarget(fromId);
    const entry = this.createNode(input, fromId);
    this.appendEntry(entry);
    return cloneEntry(entry);
  }

  moveLeaf(leafId: string | null): void {
    this.assertValidLeafTarget(leafId);
    this.currentLeafId = leafId;
  }

  abandonBranchWithSummary(
    targetLeafId: string | null,
    input: SessionTreeBranchSummaryInput<TDetails>
  ): SessionTreeBranchSummaryEntry<TDetails> {
    this.assertValidLeafTarget(targetLeafId);
    const abandonedLeafId = this.currentLeafId;
    const entry: SessionTreeBranchSummaryEntry<TDetails> = {
      type: "branch_summary",
      id: input.id ?? this.createAvailableId("tree_summary"),
      parentId: targetLeafId,
      createdAt: input.createdAt ?? this.now(),
      summary: input.summary,
      abandonedLeafId,
      ...(input.details === undefined ? {} : { details: input.details })
    };
    this.assertAvailableId(entry.id);
    this.appendEntry(entry);
    return cloneEntry(entry);
  }

  restoreLeaf(source?: SessionTreeLeafSource): void {
    const requestedLeafId = leafIdFromSource(source);
    const restoredLeafId = requestedLeafId === undefined ? this.lastEntryId() : requestedLeafId;
    this.assertValidLeafTarget(restoredLeafId);
    this.currentLeafId = restoredLeafId;
  }

  applyLeafToSession<TSession extends Pick<OrchestratorSessionRecord, "currentLeafId">>(session: TSession): TSession {
    if (this.currentLeafId === null) {
      (session as Record<string, unknown>).currentLeafId = undefined;
    } else {
      session.currentLeafId = this.currentLeafId;
    }
    return session;
  }

  readBranchPath(leafId: string | null | undefined = this.currentLeafId): SessionTreeEntry<TPayload, TDetails>[] {
    if (leafId === null) return [];
    if (leafId === undefined) {
      return this.currentLeafId === null ? [] : this.readBranchPath(this.currentLeafId);
    }

    const path: SessionTreeEntry<TPayload, TDetails>[] = [];
    const seen = new Set<string>();
    let current = this.byId.get(leafId);
    if (!current) throw new SessionError(`Session tree entry ${leafId} not found`, "not_found");

    while (current) {
      if (seen.has(current.id)) {
        throw new SessionError(`Session tree cycle detected at entry ${current.id}`, "invalid_state");
      }
      seen.add(current.id);
      // push 后整体 reverse，避免 unshift 的 O(depth²) 退化
      path.push(cloneEntry(current));
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }

    path.reverse();
    return path;
  }

  snapshot(): SessionTreeSnapshot<TPayload, TDetails> {
    const entries = this.getEntries();
    if (this.currentLeafId === null) {
      return { entries };
    }
    return { entries, currentLeafId: this.currentLeafId };
  }

  private loadEntries(entries: readonly SessionTreeEntry<TPayload, TDetails>[]): void {
    // 两阶段：先对完整输入做结构校验（与容量淘汰解耦），再加载。
    // 校验阶段使用本地 seen 集合，避免 BoundedMap 在超容量时淘汰早期父节点
    // 而误判"父节点缺失"（淘汰是容量行为，不是结构错误）。
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        throw new SessionError(`Session tree entry ${entry.id} already exists`, "invalid_entry");
      }
      if (entry.parentId !== null && !seen.has(entry.parentId)) {
        throw new SessionError(`Parent ${entry.parentId} for session tree entry ${entry.id} must appear before the child`, "invalid_state");
      }
      if (entry.type === "branch_summary" && entry.abandonedLeafId !== null && !seen.has(entry.abandonedLeafId)) {
        throw new SessionError(`Abandoned leaf ${entry.abandonedLeafId} for branch summary ${entry.id} not found`, "not_found");
      }
      seen.add(entry.id);
    }
    // 加载阶段：BoundedMap 在超容量时自动按 FIFO 淘汰最旧条目。
    // 超容量的旧分支路径将不可回溯（readBranchPath 会抛 not found），这是有界历史的固有取舍。
    for (const entry of entries) {
      this.byId.set(entry.id, cloneEntry(entry));
      this.lastInsertedId = entry.id;
    }
  }

  private createNode(input: SessionTreeAppendNodeInput<TPayload>, parentId: string | null): SessionTreeNodeEntry<TPayload> {
    const id = input.id ?? this.createAvailableId("tree_node");
    this.assertAvailableId(id);
    return {
      type: "node",
      id,
      parentId,
      createdAt: input.createdAt ?? this.now(),
      payload: input.payload
    };
  }

  private appendEntry(entry: SessionTreeEntry<TPayload, TDetails>): void {
    this.byId.set(entry.id, cloneEntry(entry));
    this.lastInsertedId = entry.id;
    this.currentLeafId = entry.id;
  }

  private createAvailableId(prefix: string): string {
    let id = this.createId(prefix);
    while (this.byId.has(id)) {
      id = this.createId(prefix);
    }
    return id;
  }

  private assertAvailableId(id: string): void {
    if (this.byId.has(id)) {
      throw new SessionError(`Session tree entry ${id} already exists`, "invalid_entry");
    }
  }

  private assertValidLeafTarget(leafId: string | null): void {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError(`Session tree entry ${leafId} not found`, "not_found");
    }
  }

  private lastEntryId(): string | null {
    return this.lastInsertedId;
  }
}

function cloneEntry<TPayload>(entry: SessionTreeNodeEntry<TPayload>): SessionTreeNodeEntry<TPayload>;
function cloneEntry<TDetails>(entry: SessionTreeBranchSummaryEntry<TDetails>): SessionTreeBranchSummaryEntry<TDetails>;
function cloneEntry<TPayload, TDetails>(entry: SessionTreeEntry<TPayload, TDetails>): SessionTreeEntry<TPayload, TDetails>;
function cloneEntry<TPayload, TDetails>(entry: SessionTreeEntry<TPayload, TDetails>): SessionTreeEntry<TPayload, TDetails> {
  return { ...entry };
}

function leafIdFromSource(source: SessionTreeLeafSource): string | null | undefined {
  if (source === undefined || source === null || typeof source === "string") {
    return source;
  }
  return source.currentLeafId;
}

function defaultCreateId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}
