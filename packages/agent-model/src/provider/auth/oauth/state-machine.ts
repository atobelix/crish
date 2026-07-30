export type OAuthState =
  | 'no-token'
  | 'has-token'
  | 'token-expired'
  | 'refreshing'
  | 'need-reauth'
  | 'error';

export class OAuthStateError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

export class OAuthDeadlockError extends Error {
  constructor(
    message: string,
    public readonly transitions: Array<{
      from: OAuthState;
      to: OAuthState;
      trigger: string;
      timestamp: number;
    }>
  ) {
    super(message);
    this.name = 'OAuthDeadlockError';
  }
}

export interface OAuthStateMachineOptions {
  refreshTokenFn?: () => Promise<number>;
  onStateChange?: (from: OAuthState, to: OAuthState, trigger: string) => void;
  onRefreshNeeded?: () => void;
  onRefreshSuccess?: () => void;
  onRefreshFailed?: (error: Error, attempt: number) => void;
  onReauthNeeded?: () => void;
  onError?: (error: Error) => void;
  maxRetries?: number;
  deadlockWindowMs?: number;
  maxTransitionsInWindow?: number;
}

const VALID_TRANSITIONS: Record<
  OAuthState,
  Partial<Record<OAuthState, string[]>>
> = {
  'no-token': {
    'has-token': ['setToken'],
    error: ['handleError'],
  },
  'has-token': {
    'has-token': ['setToken'],
    'token-expired': ['ensureToken', 'handleError'],
    error: ['handleError'],
  },
  'token-expired': {
    refreshing: ['ensureToken', 'handleError'],
    'need-reauth': ['handleError'],
    error: ['handleError'],
  },
  refreshing: {
    'has-token': ['refresh'],
    'need-reauth': ['refresh'],
    error: ['handleError'],
  },
  'need-reauth': {
    'has-token': ['setToken'],
    error: ['handleError'],
  },
  error: {
    'no-token': ['clearToken', 'reset'],
    'has-token': ['setToken'],
  },
};

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DEADLOCK_WINDOW_MS = 30_000;
const DEFAULT_MAX_TRANSITIONS = 10;
const EXPIRY_BUFFER_MS = 5_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 10_000;

export class OAuthStateMachine {
  private state: OAuthState = 'no-token';
  private expiresAt = 0;
  private retryCount = 0;
  private refreshPromise: Promise<void> | null = null;
  private transitionLog: Array<{
    from: OAuthState;
    to: OAuthState;
    trigger: string;
    timestamp: number;
  }> = [];
  private opts: Required<OAuthStateMachineOptions>;

  constructor(opts: OAuthStateMachineOptions = {}) {
    this.opts = {
      refreshTokenFn:
        opts.refreshTokenFn ??
        (() => Promise.reject(new Error('No refresh function configured'))),
      onStateChange: opts.onStateChange ?? (() => {}),
      onRefreshNeeded: opts.onRefreshNeeded ?? (() => {}),
      onRefreshSuccess: opts.onRefreshSuccess ?? (() => {}),
      onRefreshFailed: opts.onRefreshFailed ?? (() => {}),
      onReauthNeeded: opts.onReauthNeeded ?? (() => {}),
      onError: opts.onError ?? (() => {}),
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      deadlockWindowMs: opts.deadlockWindowMs ?? DEFAULT_DEADLOCK_WINDOW_MS,
      maxTransitionsInWindow:
        opts.maxTransitionsInWindow ?? DEFAULT_MAX_TRANSITIONS,
    };
  }

  getState(): OAuthState {
    return this.state;
  }

  getExpiresAt(): number {
    return this.expiresAt;
  }

  getRetryCount(): number {
    return this.retryCount;
  }

  setToken(expiresIn: number): void {
    this.expiresAt = Date.now() + expiresIn * 1000;
    this.retryCount = 0;
    this.transition('has-token', 'setToken');
  }

  clearToken(): void {
    this.expiresAt = 0;
    this.retryCount = 0;
    this.refreshPromise = null;
    this.transition('no-token', 'clearToken');
  }

  async ensureToken(): Promise<void> {
    this.detectDeadlock();

    switch (this.state) {
      case 'has-token':
        if (this.isExpired()) {
          this.transition('token-expired', 'ensureToken');
          return this.refresh();
        }
        return;
      case 'token-expired':
        return this.refresh();
      case 'refreshing':
        if (this.refreshPromise) {
          return this.refreshPromise;
        }
        return this.refresh();
      case 'no-token':
        throw new OAuthStateError('No token available', 'NO_TOKEN');
      case 'need-reauth':
        throw new OAuthStateError(
          'Re-authentication required',
          'REAUTH_REQUIRED'
        );
      case 'error':
        throw new OAuthStateError(
          'State machine is in error state',
          'FATAL_ERROR'
        );
    }
  }

  async handleError(error: Error): Promise<boolean> {
    this.detectDeadlock();

    if (isAuthError(error)) {
      if (this.state === 'has-token') {
        this.transition('token-expired', 'handleError(auth)');
        return true;
      }
      if (this.state === 'token-expired' || this.state === 'refreshing') {
        return true;
      }
      this.transition('need-reauth', 'handleError(auth)');
      return false;
    }

    if (isTransientError(error)) {
      return true;
    }

    this.transition('error', 'handleError(fatal)');
    this.opts.onError(error);
    return false;
  }

  reset(): void {
    this.state = 'no-token';
    this.expiresAt = 0;
    this.retryCount = 0;
    this.refreshPromise = null;
    this.transitionLog = [];
  }

  private isExpired(): boolean {
    return Date.now() + EXPIRY_BUFFER_MS >= this.expiresAt;
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.transition('refreshing', 'refresh');
    this.opts.onRefreshNeeded();

    this.refreshPromise = this.executeRefresh();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async executeRefresh(): Promise<void> {
    while (this.retryCount < this.opts.maxRetries) {
      try {
        const expiresIn = await this.opts.refreshTokenFn();
        this.expiresAt = Date.now() + expiresIn * 1000;
        this.retryCount = 0;
        this.transition('has-token', 'refresh(success)');
        this.opts.onRefreshSuccess();
        return;
      } catch (err) {
        this.retryCount++;
        const error = err instanceof Error ? err : new Error(String(err));
        this.opts.onRefreshFailed(error, this.retryCount);

        if (isAuthError(error) || isFatalError(error)) {
          this.transition('need-reauth', 'refresh(fatal)');
          throw error;
        }

        if (this.retryCount >= this.opts.maxRetries) {
          const msg = `Token refresh failed after ${this.opts.maxRetries} attempts`;
          this.transition('need-reauth', 'refresh(retries-exhausted)');
          throw new OAuthStateError(msg, 'REFRESH_FAILED', error);
        }

        const delay = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, this.retryCount),
          BACKOFF_MAX_MS
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private transition(to: OAuthState, trigger: string): void {
    const from = this.state;
    if (from === to) return;

    const allowedTriggers = VALID_TRANSITIONS[from]?.[to];
    if (!allowedTriggers) {
      throw new OAuthStateError(
        `Invalid transition: ${from} → ${to} (trigger: ${trigger})`,
        'INVALID_TRANSITION'
      );
    }

    this.state = to;
    this.transitionLog.push({ from, to, trigger, timestamp: Date.now() });

    if (this.transitionLog.length > 100) {
      this.transitionLog.splice(0, this.transitionLog.length - 100);
    }

    this.opts.onStateChange(from, to, trigger);

    if (to === 'need-reauth') {
      this.opts.onReauthNeeded();
    }
  }

  private detectDeadlock(): void {
    const now = Date.now();
    const window = this.opts.deadlockWindowMs;
    const recent = this.transitionLog.filter((t) => now - t.timestamp < window);

    if (recent.length >= this.opts.maxTransitionsInWindow) {
      const cycle = findStateCycle(recent);
      const suffix =
        cycle.length > 0
          ? `, detected cycle: ${cycle.map((s) => `"${s}"`).join(' → ')}`
          : '';
      throw new OAuthDeadlockError(
        `Deadlock detected: ${recent.length} transitions in ${window}ms${suffix}`,
        recent
      );
    }
  }
}

function isAuthError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (
    /(401|unauthorized|invalid.token|token.expired|invalid.grant|unauthorized_client)/i.test(
      msg
    )
  ) {
    return true;
  }
  if (error instanceof OAuthStateError && error.code === 'REAUTH_REQUIRED') {
    return true;
  }
  return false;
}

function isTransientError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (
    /(econnrefused|econnreset|etimedout|enotfound|eai_again|429|too.many.requests|5\d{2}|server.error|service.unavailable|rate.limit|timeout)/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

function isFatalError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (
    /(invalid_client|invalid_request|access_denied|unsupported_grant_type)/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

function findStateCycle(
  transitions: Array<{ from: OAuthState; to: OAuthState }>
): OAuthState[] {
  const adj = new Map<OAuthState, OAuthState[]>();

  for (const t of transitions) {
    if (!adj.has(t.from)) adj.set(t.from, []);
    const neighbors = adj.get(t.from)!;
    if (!neighbors.includes(t.to)) {
      neighbors.push(t.to);
    }
  }

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<OAuthState, number>();
  const parent = new Map<OAuthState, OAuthState | null>();

  for (const node of adj.keys()) {
    color.set(node, WHITE);
    parent.set(node, null);
  }

  const visit = (node: OAuthState): OAuthState[] | null => {
    color.set(node, GRAY);

    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) {
        const cycle: OAuthState[] = [neighbor, node];
        let curr = node;
        while (curr !== neighbor) {
          const p = parent.get(curr) as OAuthState | undefined;
          if (!p) break;
          curr = p;
          cycle.push(curr);
        }
        return cycle.reverse();
      }

      if (color.get(neighbor) === WHITE) {
        parent.set(neighbor, node);
        const result = visit(neighbor);
        if (result) return result;
      }
    }

    color.set(node, BLACK);
    return null;
  };

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      const result = visit(node);
      if (result) return result;
    }
  }

  return [];
}
