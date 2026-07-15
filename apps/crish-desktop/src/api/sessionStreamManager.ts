/**
 * 按会话隔离的流式 run 句柄：cancel / drain 排队 / 防止幽灵 run。
 */

export type SessionStreamHandle = {
  cancel: () => void;
  userMsgId: string;
  assistantMsgId: string;
  runId: string | null;
};

export class SessionStreamManager {
  private streams = new Map<string, SessionStreamHandle>();
  private draining = new Set<string>();

  get(sessionId: string): SessionStreamHandle | undefined {
    return this.streams.get(sessionId);
  }

  set(sessionId: string, handle: SessionStreamHandle): void {
    this.streams.set(sessionId, handle);
  }

  delete(sessionId: string): void {
    this.streams.delete(sessionId);
  }

  /** 替换同会话流前先 cancel 旧句柄，避免幽灵 run */
  replace(sessionId: string, next: SessionStreamHandle): SessionStreamHandle | undefined {
    const prev = this.streams.get(sessionId);
    if (prev) {
      this.streams.delete(sessionId);
      try {
        prev.cancel();
      } catch {
        /* ignore */
      }
    }
    this.streams.set(sessionId, next);
    return prev;
  }

  /** cancel 并移除；返回被取消的句柄 */
  cancelSession(sessionId: string): SessionStreamHandle | undefined {
    const cur = this.streams.get(sessionId);
    if (!cur) return undefined;
    this.streams.delete(sessionId);
    try {
      cur.cancel();
    } catch {
      /* ignore */
    }
    return cur;
  }

  beginDrain(sessionId: string): boolean {
    if (this.draining.has(sessionId)) return false;
    this.draining.add(sessionId);
    return true;
  }

  endDrain(sessionId: string): void {
    this.draining.delete(sessionId);
  }

  /** 下一帧结束 drain 锁（与历史 drainQueued 行为一致） */
  endDrainNextTick(sessionId: string, schedule: (fn: () => void) => void = (fn) => setTimeout(fn, 0)): void {
    schedule(() => {
      this.draining.delete(sessionId);
    });
  }
}
