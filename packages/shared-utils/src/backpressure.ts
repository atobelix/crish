export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;

  constructor(
    capacity: number,
    refillRate: number,
    refillInterval: number = 1000
  ) {
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
