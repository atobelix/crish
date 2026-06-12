import type { JsonObject } from "@crish/shared-types";
import type { OrchestratorSessionRecord } from "./types";

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
  private readonly entries: SessionTreeEntry<TPayload, TDetails>[] = [];
  private readonly byId = new Map<string, SessionTreeEntry<TPayload, TDetails>>();
  private currentLeafId: string | null = null;
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  constructor(options: SessionTreeOptions<TPayload, TDetails> = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? defaultCreateId;
    this.loadEntries(options.entries ?? []);
    this.restoreLeaf(options.currentLeafId);
  }

  getCurrentLeafId(): string | null {
    return this.currentLeafId;
  }

  getEntries(): SessionTreeEntry<TPayload, TDetails>[] {
    return this.entries.map((entry) => cloneEntry<TPayload, TDetails>(entry));
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
      delete session.currentLeafId;
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
    if (!current) throw new Error(`Session tree entry ${leafId} not found`);

    while (current) {
      if (seen.has(current.id)) {
        throw new Error(`Session tree cycle detected at entry ${current.id}`);
      }
      seen.add(current.id);
      path.unshift(cloneEntry(current));
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }

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
    for (const entry of entries) {
      this.assertAvailableId(entry.id);
      if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
        throw new Error(`Parent ${entry.parentId} for session tree entry ${entry.id} must appear before the child`);
      }
      if (entry.type === "branch_summary" && entry.abandonedLeafId !== null && !this.byId.has(entry.abandonedLeafId)) {
        throw new Error(`Abandoned leaf ${entry.abandonedLeafId} for branch summary ${entry.id} not found`);
      }
      this.entries.push(cloneEntry(entry));
      this.byId.set(entry.id, cloneEntry(entry));
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
    this.entries.push(cloneEntry(entry));
    this.byId.set(entry.id, cloneEntry(entry));
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
      throw new Error(`Session tree entry ${id} already exists`);
    }
  }

  private assertValidLeafTarget(leafId: string | null): void {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new Error(`Session tree entry ${leafId} not found`);
    }
  }

  private lastEntryId(): string | null {
    return this.entries.at(-1)?.id ?? null;
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
