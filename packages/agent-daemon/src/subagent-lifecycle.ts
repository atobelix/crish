export type SubagentLifecycleState =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

const ORPHANED_CLEANUP_DELAY_MS = 30_000;

const VALID_TRANSITIONS: Record<SubagentLifecycleState, Partial<Record<string, SubagentLifecycleState>>> = {
  starting: { start: 'running', fail: 'failed', cancel: 'cancelled' },
  running: { complete: 'completed', fail: 'failed', cancel: 'cancelled', orphan: 'orphaned' },
  completed: {},
  failed: {},
  cancelled: {},
  orphaned: { cancel: 'cancelled' },
};

export interface SubagentEntry {
  runId: string;
  subagentRunId: string;
  subagentId: string;
  parentToolCallId: string;
  description: string;
  mode: string;
  parentRunId: string;
  createdAt: number;
}

export class SubagentRegistry {
  private subagents: Map<string, { state: SubagentLifecycleState; entry: SubagentEntry }> = new Map();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  register(id: string, entry: SubagentEntry): void {
    if (this.subagents.has(id)) return;
    this.subagents.set(id, { state: 'starting', entry });
  }

  transition(id: string, event: string): void {
    const record = this.subagents.get(id);
    if (!record) return;

    const allowed = VALID_TRANSITIONS[record.state];
    const nextState = allowed[event];
    if (!nextState) return;

    record.state = nextState;

    if (nextState === 'orphaned') {
      this.scheduleOrphanedCleanup(id);
    } else if (nextState === 'cancelled') {
      this.cancelCleanupTimer(id);
    }
  }

  getState(id: string): SubagentLifecycleState | undefined {
    return this.subagents.get(id)?.state;
  }

  private scheduleOrphanedCleanup(id: string): void {
    this.cancelCleanupTimer(id);
    const timer = setTimeout(() => {
      this.transition(id, 'cancel');
      this.cleanupTimers.delete(id);
    }, ORPHANED_CLEANUP_DELAY_MS);
    timer.unref();
    this.cleanupTimers.set(id, timer);
  }

  clearOrphaned(): void {
    for (const [id, record] of this.subagents) {
      if (record.state === 'orphaned') {
        this.transition(id, 'cancel');
      }
    }
  }

  clearAll(): void {
    for (const id of this.cleanupTimers.keys()) {
      this.cancelCleanupTimer(id);
    }
    this.subagents.clear();
  }

  clearRun(runId: string): void {
    for (const [id, record] of this.subagents) {
      if (record.entry.parentRunId === runId) {
        this.cancelCleanupTimer(id);
        this.subagents.delete(id);
      }
    }
  }

  private cancelCleanupTimer(id: string): void {
    const timer = this.cleanupTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(id);
    }
  }
}
