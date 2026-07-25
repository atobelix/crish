import { RingBuffer } from "@crish/shared-utils";

export type StateId = string;
export type EventId = string;

export type RejectionReason =
  | "no-transition-defined"
  | "guard-denied"
  | "already-in-target-state"
  | "machine-destroyed";

export interface TransitionOk<S extends StateId, E extends EventId> {
  ok: true;
  from: S;
  to: S;
  event: E;
  timestamp: string;
  effects: SideEffect[];
}

export interface TransitionRejected {
  ok: false;
  reason: RejectionReason;
  message: string;
}

export type TransitionResult<S extends StateId, E extends EventId> = TransitionOk<S, E> | TransitionRejected;

export type SideEffect =
  | { kind: "patch-context"; patch: Record<string, unknown> }
  | { kind: "update-context"; updater: (context: object) => object };

export interface TransitionRecord<S extends StateId = StateId, E extends EventId = EventId> {
  from: S;
  to: S;
  event: E;
  timestamp: string;
  payload?: unknown;
}

export interface StateMachineSnapshot<S extends StateId = StateId, C = unknown> {
  machineType: string;
  machineId: string;
  current: S;
  context: C;
  history: TransitionRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

export interface TransitionTarget<S extends StateId, C> {
  target: S;
  guard: (context: C, payload?: unknown) => GuardResult;
  effect?: (context: C, payload?: unknown) => SideEffect[];
}

export interface StateDefinition<S extends StateId, E extends EventId, C> {
  onEnter?: (context: C, event: E, payload?: unknown) => SideEffect[];
  onExit?: (context: C, event: E, payload?: unknown) => SideEffect[];
  transitions: Map<E, TransitionTarget<S, C>>;
}

export interface StateMachineDefinition<S extends StateId, E extends EventId, C> {
  machineType: string;
  states: Map<S, StateDefinition<S, E, C>>;
  initial: S;
  createContext: () => C;
}

/**
 * TransitionTable provides an explicit, human-readable view of all state transitions.
 * For each current state, it enumerates every possible event and the resulting target state.
 */
export type TransitionTable<S extends StateId, E extends EventId> = Map<S, Map<E, S>>;

export class StateMachineBuilder<S extends StateId, E extends EventId, C = unknown> {
  private states = new Map<S, StateDefinition<S, E, C>>();
  private initialState!: S;
  private contextFactory: () => C = () => ({} as C);
  private machineType: string = "unnamed";

  type(name: string): this { this.machineType = name; return this; }
  initial(state: S): this { this.initialState = state; return this; }
  context(factory: () => C): this { this.contextFactory = factory; return this; }

  state(id: S, definition: {
    onEnter?: (context: C, event: E, payload?: unknown) => SideEffect[];
    onExit?: (context: C, event: E, payload?: unknown) => SideEffect[];
    transitions: Array<[E, TransitionTarget<S, C>]>;
  }): this {
    const transitions = new Map<E, TransitionTarget<S, C>>();
    for (const [event, target] of definition.transitions) {
      transitions.set(event, target);
    }
    this.states.set(id, {
      ...(definition.onEnter !== undefined ? { onEnter: definition.onEnter } : {}),
      ...(definition.onExit !== undefined ? { onExit: definition.onExit } : {}),
      transitions,
    });
    return this;
  }

  build(): StateMachineDefinition<S, E, C> {
    if (!this.initialState) throw new Error("initial state is required");
    if (this.states.size === 0) throw new Error("at least one state is required");
    if (!this.states.has(this.initialState)) throw new Error(`initial state "${this.initialState}" not defined`);
    return { machineType: this.machineType, states: this.states, initial: this.initialState, createContext: this.contextFactory };
  }
}

export class ConexStateMachine<S extends StateId, E extends EventId, C = unknown> {
  private current: S;
  private context: C;
  private readonly maxHistoryLength = 1000;
  private readonly history = new RingBuffer<TransitionRecord<S, E>>(this.maxHistoryLength);
  private destroyed = false;
  private readonly createdAt: string;
  private updatedAt: string;

  constructor(
    private readonly definition: StateMachineDefinition<S, E, C>,
    private readonly machineId: string,
    options?: { initialContext?: C; snapshot?: StateMachineSnapshot<S, C> }
  ) {
    if (options?.snapshot) {
      this.current = options.snapshot.current;
      this.context = options.snapshot.context;
      this.history.fromArrayTail(options.snapshot.history as TransitionRecord<S, E>[]);
      this.createdAt = options.snapshot.createdAt;
      this.updatedAt = options.snapshot.updatedAt;
    } else {
      this.current = definition.initial;
      this.context = (options?.initialContext ?? definition.createContext()) as C;
      this.createdAt = nowIso();
      this.updatedAt = this.createdAt;
    }
  }

  getCurrent(): S { return this.current; }
  getContext(): C { return this.context; }
  is(state: S): boolean { return this.current === state; }
  isDestroyed(): boolean { return this.destroyed; }

  isTerminal(): boolean {
    const stateDef = this.definition.states.get(this.current);
    if (!stateDef) return true;
    return stateDef.transitions.size === 0;
  }

  getAvailableEvents(): E[] {
    const stateDef = this.definition.states.get(this.current);
    if (!stateDef) return [];
    return [...stateDef.transitions.keys()];
  }

  getHistory(): ReadonlyArray<TransitionRecord<S, E>> { return this.history.toArray(); }

  /** Returns an explicit transition table: current state × event → target state. */
  getTransitionTable(): TransitionTable<S, E> {
    const table: TransitionTable<S, E> = new Map();
    for (const [stateId, stateDef] of this.definition.states) {
      const eventMap = new Map<E, S>();
      for (const [event, target] of stateDef.transitions) {
        eventMap.set(event, target.target);
      }
      table.set(stateId, eventMap);
    }
    return table;
  }

  getSnapshot(): StateMachineSnapshot<S, C> {
    return {
      machineType: this.definition.machineType,
      machineId: this.machineId,
      current: this.current,
      context: structuredClone(this.context),
      history: this.history.toArray(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  canSend(event: E): boolean {
    if (this.destroyed) return false;
    const stateDef = this.definition.states.get(this.current);
    if (!stateDef) return false;
    const target = stateDef.transitions.get(event);
    if (!target) return false;
    return target.guard(this.context).allowed;
  }

  send(event: E, payload?: unknown): TransitionResult<S, E> {
    // Phase 1: Validate machine is alive
    if (this.destroyed) {
      return { ok: false, reason: "machine-destroyed", message: "Machine has been destroyed" };
    }

    // Phase 2: Look up current state definition
    const stateDef = this.definition.states.get(this.current);
    if (!stateDef) {
      return { ok: false, reason: "no-transition-defined", message: `State "${this.current}" not defined` };
    }

    // Phase 3: Look up transition target for event
    const transitionTarget = stateDef.transitions.get(event);
    if (!transitionTarget) {
      return {
        ok: false, reason: "no-transition-defined",
        message: `No transition from "${this.current}" on event "${event}"`,
      };
    }

    // Phase 4: Reject self-transitions
    if (transitionTarget.target === this.current) {
      return { ok: false, reason: "already-in-target-state", message: `Already in state "${this.current}"` };
    }

    // Phase 5: Guard check
    const guardResult = transitionTarget.guard(this.context, payload);
    if (!guardResult.allowed) {
      return {
        ok: false, reason: "guard-denied",
        message: `Guard denied transition from "${this.current}" to "${transitionTarget.target}" on event "${event}": ${guardResult.reason ?? "denied"}`,
      };
    }

    // Phase 6: Execute transition pipeline: onExit → transition effect → update state → onEnter
    const from = this.current;
    const to = transitionTarget.target;
    const timestamp = nowIso();
    const allEffects: SideEffect[] = [];

    // 6a: Collect onExit effects from current state
    const exitEffects = stateDef.onExit?.(this.context, event, payload) ?? [];
    allEffects.push(...exitEffects);

    // 6b: Collect transition effects
    const transitionEffects = transitionTarget.effect?.(this.context, payload) ?? [];
    allEffects.push(...transitionEffects);

    // 6c: Apply patch-context and update-context effects
    for (const effect of allEffects) {
      if (effect.kind === "patch-context") {
        this.context = { ...this.context, ...effect.patch };
      } else if (effect.kind === "update-context") {
        this.context = effect.updater(this.context as unknown as Record<string, unknown>) as unknown as C;
      }
    }

    // 6d: Update current state
    this.current = to;
    this.updatedAt = timestamp;

    // 6e: Collect and apply onEnter effects from target state
    const targetStateDef = this.definition.states.get(to);
    const enterEffects = targetStateDef?.onEnter?.(this.context, event, payload) ?? [];
    allEffects.push(...enterEffects);

    for (const effect of enterEffects) {
      if (effect.kind === "patch-context") {
        this.context = { ...this.context, ...effect.patch };
      } else if (effect.kind === "update-context") {
        this.context = effect.updater(this.context as unknown as Record<string, unknown>) as unknown as C;
      }
    }

    // Phase 7: Record transition in history
    const record: TransitionRecord<S, E> = { from, to, event, timestamp, payload };
    this.history.pushOverwritingOldest(record);

    return { ok: true, from, to, event, timestamp, effects: allEffects };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function denyTransition(reason: string): GuardResult {
  return { allowed: false, reason };
}

export function transitionWith<S extends StateId, C>(
  target: S,
  updater: (context: C) => C
): TransitionTarget<S, C> {
  return {
    target,
    guard: () => ({ allowed: true }),
    effect: () => [{ kind: "update-context" as const, updater: (c: object) => updater(c as unknown as C) as unknown as object }],
  };
}

export function transitionTo<S extends StateId, C>(
  target: S,
  options?: { guard?: (context: C, payload?: unknown) => GuardResult; effect?: (context: C, payload?: unknown) => SideEffect[] }
): TransitionTarget<S, C> {
  return {
    target,
    guard: options?.guard ?? (() => ({ allowed: true })),
    ...(options?.effect !== undefined ? { effect: options.effect } : {}),
  };
}

export function transitionWithPatch<S extends StateId, C>(
  target: S,
  patch: Record<string, unknown>
): TransitionTarget<S, C> {
  return {
    target,
    guard: () => ({ allowed: true }),
    effect: () => [{ kind: "patch-context", patch }],
  };
}
