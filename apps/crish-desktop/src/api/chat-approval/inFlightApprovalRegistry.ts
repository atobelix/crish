/**
 * 跨实例共享审批锁管理器：
 * 解决 ChatCard 与 InlineAgentPanel 之间同 toolId 并发重复提交问题
 */
class InFlightApprovalRegistry {
  private inFlight = new Set<string>();
  private listeners = new Set<() => void>();

  public isBusy(toolId: string): boolean {
    return this.inFlight.has(toolId);
  }

  public getCount(): number {
    return this.inFlight.size;
  }

  public acquire(toolIds: string[]): string[] {
    const acquired: string[] = [];
    for (const tid of toolIds) {
      if (!this.inFlight.has(tid)) {
        this.inFlight.add(tid);
        acquired.push(tid);
      }
    }
    if (acquired.length > 0) {
      this.notify();
    }
    return acquired;
  }

  public release(toolIds: string[]): void {
    let changed = false;
    for (const tid of toolIds) {
      if (this.inFlight.delete(tid)) {
        changed = true;
      }
    }
    if (changed) {
      this.notify();
    }
  }

  public clearForTest(): void {
    if (this.inFlight.size > 0) {
      this.inFlight.clear();
      this.notify();
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error('[InFlightApprovalRegistry] listener error', err);
      }
    }
  }
}

export const inFlightApprovalRegistry = new InFlightApprovalRegistry();
