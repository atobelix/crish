/**
 * Per-run stream backpressure gate.
 *
 * pause → outbound messages are buffered (drop-oldest at cap)
 * resume → flush buffer + wake waiters
 * waitIfPaused → block the for-await event loop until resume
 */

export class StreamBackpressureRegistry {
  private readonly paused = new Set<string>();
  private readonly buffers = new Map<string, unknown[]>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly maxBuffered: number;

  constructor(maxBuffered = 512) {
    this.maxBuffered = Math.max(1, maxBuffered);
  }

  pause(runId: string): void {
    if (!runId) return;
    this.paused.add(runId);
  }

  /**
   * Clear pause state, resolve waiters, and return (then clear) buffered messages.
   */
  resume(runId: string): unknown[] {
    if (!runId) return [];
    this.paused.delete(runId);
    const buffered = this.buffers.get(runId) ?? [];
    this.buffers.delete(runId);
    this.resolveWaiters(runId);
    return buffered;
  }

  isPaused(runId: string): boolean {
    return Boolean(runId) && this.paused.has(runId);
  }

  /**
   * If the run is paused, push `message` into the per-run buffer and return true.
   * At maxBuffered, drop the oldest entry to bound memory.
   */
  tryBuffer(runId: string, message: unknown): boolean {
    if (!this.isPaused(runId)) return false;
    let buf = this.buffers.get(runId);
    if (!buf) {
      buf = [];
      this.buffers.set(runId, buf);
    }
    if (buf.length >= this.maxBuffered) {
      buf.shift();
    }
    buf.push(message);
    return true;
  }

  /** Block until the run is no longer paused (or cleared). */
  async waitIfPaused(runId: string): Promise<void> {
    if (!runId) return;
    while (this.isPaused(runId)) {
      await new Promise<void>((resolve) => {
        let list = this.waiters.get(runId);
        if (!list) {
          list = [];
          this.waiters.set(runId, list);
        }
        list.push(resolve);
      });
    }
  }

  bufferedCount(runId: string): number {
    return this.buffers.get(runId)?.length ?? 0;
  }

  /** Drop pause/buffer/waiters for a finished run (wakes any waiters). */
  clearRun(runId: string): void {
    if (!runId) return;
    this.paused.delete(runId);
    this.buffers.delete(runId);
    this.resolveWaiters(runId);
  }

  private resolveWaiters(runId: string): void {
    const ws = this.waiters.get(runId) ?? [];
    this.waiters.delete(runId);
    for (const resolve of ws) resolve();
  }
}
