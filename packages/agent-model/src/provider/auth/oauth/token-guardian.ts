import { ChatGPTAccountPool } from './chatgpt-pool';

export class TokenGuardian {
  private pool: ChatGPTAccountPool;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private isRunning = false;

  constructor(pool: ChatGPTAccountPool, intervalMs = 5 * 60 * 1000) {
    this.pool = pool;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.sweep();

    this.timer = setInterval(() => this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async sweep(): Promise<void> {
    const accounts = this.pool.listAccounts();
    const now = Date.now();

    for (const account of accounts) {
      if (account.expiresAt - now < 5 * 60 * 1000 && account.expiresAt > now) {
        console.log(
          `[TokenGuardian] Refreshing token for ${account.label} (expires in ${Math.round((account.expiresAt - now) / 1000)}s)`
        );
        await this.pool.refreshAccount(account.id);
      }
    }
  }
}
