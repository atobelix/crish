export class CircuitBreakerOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker "${name}" is open`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;

  constructor(capacity: number, refillRate: number, refillInterval: number = 1000) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.refillInterval = refillInterval;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed < this.refillInterval) return;
    const intervals = Math.floor(elapsed / this.refillInterval);
    const refillTokens = intervals * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + refillTokens);
    this.lastRefill += intervals * this.refillInterval;
  }

  tryConsume(tokens: number): boolean {
    this.refill();
    if (this.tokens < tokens) return false;
    this.tokens -= tokens;
    return true;
  }

  get remaining(): number {
    this.refill();
    return this.tokens;
  }
}

export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  tryAcquire(): (() => void) | null {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return null;
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.active--;
    }
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerState {
  state: CircuitState;
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxRequests: number;
  failureCount: number;
  lastFailureTime: number | null;
  halfOpenSuccesses: number;
}

export class CircuitBreaker {
  private _state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private halfOpenSuccesses = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxRequests: number;

  constructor(
    failureThreshold: number = 5,
    cooldownMs: number = 30_000,
    halfOpenMaxRequests: number = 1,
  ) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.halfOpenMaxRequests = halfOpenMaxRequests;
  }

  allowRequest(): boolean {
    if (this._state === 'closed') return true;
    if (this._state === 'open') {
      if (this.lastFailureTime !== null && Date.now() - this.lastFailureTime >= this.cooldownMs) {
        this._state = 'half-open';
        return true;
      }
      return false;
    }
    return this.halfOpenSuccesses < this.halfOpenMaxRequests;
  }

  onSuccess(): void {
    if (this._state === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.halfOpenMaxRequests) {
        this.reset();
      }
    } else {
      this.reset();
    }
  }

  onFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this._state = 'open';
      this.halfOpenSuccesses = 0;
    }
  }

  get state(): CircuitState {
    return this._state;
  }

  reset(): void {
    this._state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.halfOpenSuccesses = 0;
  }

  toJSON(): CircuitBreakerState {
    return {
      state: this._state,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      halfOpenMaxRequests: this.halfOpenMaxRequests,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      halfOpenSuccesses: this.halfOpenSuccesses,
    };
  }

  static fromJSON(state: CircuitBreakerState): CircuitBreaker {
    const cb = new CircuitBreaker(state.failureThreshold, state.cooldownMs, state.halfOpenMaxRequests);
    cb._state = state.state;
    cb.failureCount = state.failureCount;
    cb.lastFailureTime = state.lastFailureTime;
    cb.halfOpenSuccesses = state.halfOpenSuccesses;
    return cb;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.allowRequest()) {
      throw new CircuitBreakerOpenError('unknown');
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
}
