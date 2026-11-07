// R4 远程 WS 展示合帧调度器（Q4/F4：原事件协议排序与 UI 展示提交分离）：
// - 只合 preview 展示帧（appendFeed preview 不推进游标，M6 §10.5）——
//   正式帧 / gap / resume / stash / 会话副作用不进本调度器，原序立即落店；
// - 有界合帧窗口对齐本地流式合帧（DEFAULT_STREAM_BATCH_WINDOW_MS，F4 审计基线）；
// - 每会话待合帧上限有界背压：到顶立即冲刷，无无限队列；
// - 跨会话独立：flushSession 只动目标会话，其余会话待合帧不受影响；
// - 同 sequence 连续 delta 在缓冲层就地合并（只留最新内容，commit 内 appendFeed
//   覆盖语义不变，减少落店工作量）。
import type { EventEnvelopeFrame } from '@/domain/store/eventReducers';
import { readNumber } from '@/domain/store/eventReducers';
import { DEFAULT_STREAM_BATCH_WINDOW_MS } from '@/adapters/localChat/localChatEngine';

/** 每会话待合帧上限（背压有界）：超出立即冲刷，防无限队列 */
export const DISPLAY_COMMIT_MAX_PENDING_PER_SESSION = 8;

export interface DisplayCommitHost {
  /** 一次 commit = 一次 store 通知（eventStore.ingestBatch 单事务落店） */
  commit(sessionId: string, frames: readonly EventEnvelopeFrame[]): void;
}

export class DisplayCommitScheduler {
  private readonly pending = new Map<string, EventEnvelopeFrame[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly host: DisplayCommitHost;
  private readonly windowMs: number;

  constructor(
    host: DisplayCommitHost,
    windowMs: number = DEFAULT_STREAM_BATCH_WINDOW_MS
  ) {
    this.host = host;
    this.windowMs = windowMs;
  }

  /** preview 展示帧入队；同 sequence 连续 delta 就地合并，cap 到顶立即冲刷 */
  enqueue(sessionId: string, frame: EventEnvelopeFrame): void {
    let list = this.pending.get(sessionId);
    if (!list) {
      list = [];
      this.pending.set(sessionId, list);
    }
    const seq = readNumber(frame, 'sequence');
    const last = list[list.length - 1];
    if (
      last !== undefined &&
      seq !== undefined &&
      readNumber(last, 'sequence') === seq
    ) {
      list[list.length - 1] = frame;
    } else {
      list.push(frame);
    }
    if (list.length >= DISPLAY_COMMIT_MAX_PENDING_PER_SESSION) {
      this.flushSession(sessionId);
      return;
    }
    this.schedule();
  }

  /** 冲刷单会话（原序一次 commit；跨会话独立——其余待合帧不动） */
  flushSession(sessionId: string): void {
    const list = this.pending.get(sessionId);
    if (!list || list.length === 0) {
      this.pending.delete(sessionId);
      return;
    }
    this.pending.delete(sessionId);
    this.host.commit(sessionId, list);
    if (this.pending.size === 0) {
      this.clearTimer();
    }
  }

  /** 冲刷全部会话（终态断线 / 切会话卸载 / detach）：逐会话独立 commit */
  flushAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      this.flushSession(sessionId);
    }
    this.clearTimer();
  }

  /** 释放（调用方须先 flushAll）：清定时器与残留缓冲，之后不再 commit */
  dispose(): void {
    this.clearTimer();
    this.pending.clear();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushAll();
    }, this.windowMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
