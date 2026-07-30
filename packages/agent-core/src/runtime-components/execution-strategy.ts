export class ExecutionStrategy {
  private timeoutMs: number | undefined;
  private retryCount: number | undefined;
  private concurrentMode: 'sequential' | 'parallel' = 'sequential';

  timeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  retry(count: number): this {
    this.retryCount = count;
    return this;
  }

  concurrent(mode: 'sequential' | 'parallel'): this {
    this.concurrentMode = mode;
    return this;
  }

  compose(other: ExecutionStrategy): ExecutionStrategy {
    const result = new ExecutionStrategy();
    result.timeoutMs = this.timeoutMs ?? other.timeoutMs;
    result.retryCount = this.retryCount ?? other.retryCount;
    result.concurrentMode = other.concurrentMode === 'sequential' ? this.concurrentMode : other.concurrentMode;
    return result;
  }

  getTimeoutMs(): number | undefined {
    return this.timeoutMs;
  }

  getRetryCount(): number | undefined {
    return this.retryCount;
  }

  getConcurrentMode(): 'sequential' | 'parallel' {
    return this.concurrentMode;
  }
}
