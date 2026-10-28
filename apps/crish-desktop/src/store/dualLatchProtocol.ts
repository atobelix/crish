/**
 * 双轨锁存交接协议 (Dual-Latch Handoff Protocol) 核心库 — Stage 02 (UNIT-S02-01)
 *
 * 旨在从物理与数学底层彻底根除流终态单帧退空白屏闪烁缺陷 (VULN-01)：
 * 1. 四状态单向状态机：STREAMING -> LATCHED -> COMMITTED -> DRAINED；
 * 2. 第一轨（语义自锁存 Barrier）：resolveStreamMessageLatch 在消息进入终态瞬间
 *    强制冻结 streamText 穿透（置为 undefined），以持久层 msg.text 为唯一真理源 (SSOT)；
 * 3. 第二轨（双物理帧 rAF 布局上屏握手）：executeDualRafHandoff 彻底废除 queueMicrotask
 *    裸清流，强制等待 Frame 1 (React Fiber Commit) 与 Frame 2 (Blink Layout & Paint)
 *    两个完整物理渲染帧上屏后，才安全排空 streamingStore 热备缓冲。
 */

import {
  sessionMessageKeyOrDefault,
  sessionMessageKeyPrefix,
} from '../api/compositeSessionKeys';

import { clearStream, clearStreams } from './streamingStore';
import type {
  DualLatchPhase,
  TerminalStreamStatus,
  RafScheduler,
  RafTimerId,
} from './dualLatchLatch';
import { isValidDualLatchTransition } from './dualLatchLatch';

export type {
  DualLatchPhase,
  DualLatchState,
  TerminalStreamStatus,
  RafScheduler,
  RafTimerId,
  LatchableMessageShape,
  LatchedMessageResult,
} from './dualLatchLatch';
export {
  DUAL_LATCH_PHASE_ORDER,
  DUAL_RAF_FALLBACK_MS,
  isValidDualLatchTransition,
  isTerminalStreamStatus,
  resolveMonotonicRenderedText,
  resolveStreamMessageLatch,
  applyTerminalStatusLatch,
} from './dualLatchLatch';

export interface DualRafHandoffConfig {
  readonly sessionId: string;
  readonly messageId: string;
  readonly latchedTextLength?: number;
  readonly scheduleFrame?: RafScheduler;
  readonly onCommitted?: () => void;
  readonly onDrain: () => void;
}

function getDefaultScheduler(): RafScheduler {
  if (
    typeof globalThis.requestAnimationFrame === 'function' &&
    typeof globalThis.cancelAnimationFrame === 'function'
  ) {
    return {
      requestAnimationFrame: (cb) => globalThis.requestAnimationFrame(cb),
      cancelAnimationFrame: (id) => globalThis.cancelAnimationFrame(Number(id)),
    };
  }
  return {
    requestAnimationFrame: (cb) =>
      globalThis.setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => globalThis.clearTimeout(id),
  };
}

/**
 * 第二道防线：双物理帧渲染确认解冻器 (Dual-rAF Handshake)
 */
export function executeDualRafHandoff(
  configOrCallback: DualRafHandoffConfig | (() => void)
): () => void {
  if (typeof configOrCallback === 'function') {
    const onCommitted = configOrCallback;
    const scheduler = getDefaultScheduler();
    let cancelled = false;
    let raf1: RafTimerId = 0;
    let raf2: RafTimerId = 0;
    raf1 = scheduler.requestAnimationFrame(() => {
      if (cancelled) return;
      raf2 = scheduler.requestAnimationFrame(() => {
        if (!cancelled) onCommitted();
      });
    });
    return () => {
      if (cancelled) return;
      cancelled = true;
      if (raf1) scheduler.cancelAnimationFrame(raf1);
      if (raf2) scheduler.cancelAnimationFrame(raf2);
    };
  }

  const {
    sessionId,
    messageId,
    latchedTextLength = 0,
    scheduleFrame,
    onCommitted,
    onDrain,
  } = configOrCallback;
  const scheduler = scheduleFrame ?? getDefaultScheduler();
  dualLatchStateMachine.markLatched(sessionId, messageId, latchedTextLength);

  let cancelled = false;
  let raf1: RafTimerId = 0;
  let raf2: RafTimerId = 0;
  raf1 = scheduler.requestAnimationFrame(() => {
    if (cancelled) return;
    dualLatchStateMachine.markCommitted(sessionId, messageId);
    onCommitted?.();
    raf2 = scheduler.requestAnimationFrame(() => {
      if (cancelled) return;
      onDrain();
      dualLatchStateMachine.markDrained(sessionId, messageId);
    });
  });

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (raf1) scheduler.cancelAnimationFrame(raf1);
    if (raf2) scheduler.cancelAnimationFrame(raf2);
  };
}

export const scheduleDualRafHandoff = executeDualRafHandoff;

/** 通过双物理帧 rAF 渲染确认后安全释放单条流式热缓冲 */
export function scheduleDualRafClearStream(
  sessionId: string,
  messageId: string,
  clearStreamFn: (sid: string, mid: string) => void = clearStream,
  scheduleFrame?: RafScheduler
): () => void {
  return executeDualRafHandoff({
    sessionId,
    messageId,
    scheduleFrame,
    onDrain: () => {
      if (sessionId && messageId) clearStreamFn(sessionId, messageId);
    },
  });
}

/** 通过双物理帧 rAF 渲染确认后定向批量释放指定消息流热缓冲（严禁调用 clearSession） */
export function scheduleDualRafClearStreams(
  sessionId: string,
  messageIds: Iterable<string>,
  clearStreamsFn: (sid: string, mids: string[]) => void = clearStreams,
  scheduleFrame?: RafScheduler
): () => void {
  const ids = Array.from(messageIds).filter(Boolean);
  if (!sessionId || ids.length === 0) return () => {};
  for (const id of ids) dualLatchStateMachine.markLatched(sessionId, id);
  return executeDualRafHandoff({
    sessionId,
    messageId: ids[0]!,
    scheduleFrame,
    onCommitted: () => {
      for (const id of ids) dualLatchStateMachine.markCommitted(sessionId, id);
    },
    onDrain: () => {
      clearStreamsFn(sessionId, ids);
      for (const id of ids) dualLatchStateMachine.markDrained(sessionId, id);
    },
  });
}

export function makeDualLatchKey(sessionId: string, messageId: string): string {
  return sessionMessageKeyOrDefault(sessionId, messageId);
}

export interface DualLatchTurnRecord {
  readonly sessionId: string;
  readonly messageId: string;
  phase: DualLatchPhase;
  snapshotText: string;
  latchedTextLength: number;
  terminalStatus: TerminalStreamStatus;
  updatedAt: number;
  cancelPendingDrain?: () => void;
}

export interface DualLatchHandoffOptions {
  readonly sessionId: string;
  readonly messageId: string;
  readonly snapshotText: string;
  readonly terminalStatus?: TerminalStreamStatus;
  readonly companionMessageIds?: readonly string[];
  readonly onCommit?: (
    snapshotText: string,
    terminalStatus: TerminalStreamStatus
  ) => void;
  readonly onDrained?: () => void;
}

export class DualLatchStateMachine {
  private readonly records = new Map<string, DualLatchTurnRecord>();

  public startStreaming(
    sessionId: string,
    messageId: string
  ): DualLatchTurnRecord {
    const key = makeDualLatchKey(sessionId, messageId);
    this.records.get(key)?.cancelPendingDrain?.();
    const record: DualLatchTurnRecord = {
      sessionId,
      messageId,
      phase: 'STREAMING',
      snapshotText: '',
      latchedTextLength: 0,
      terminalStatus: 'completed',
      updatedAt: Date.now(),
    };
    this.records.set(key, record);
    return record;
  }

  public markStreaming(
    sessionId: string,
    messageId: string
  ): DualLatchTurnRecord {
    return this.startStreaming(sessionId, messageId);
  }

  public latch(
    sessionId: string,
    messageId: string,
    snapshotOrLength: string | number = '',
    terminalStatus: TerminalStreamStatus = 'completed'
  ): DualLatchTurnRecord {
    const key = makeDualLatchKey(sessionId, messageId);
    const existing = this.records.get(key);
    const incomingText =
      typeof snapshotOrLength === 'string' ? snapshotOrLength : '';
    const incomingLength =
      typeof snapshotOrLength === 'number'
        ? Math.max(0, snapshotOrLength)
        : incomingText.length;
    const nextLength = Math.max(
      existing?.latchedTextLength ?? 0,
      incomingLength
    );
    const nextText =
      incomingText.length >= (existing?.snapshotText.length ?? 0)
        ? incomingText
        : (existing?.snapshotText ?? incomingText);

    const record: DualLatchTurnRecord = {
      sessionId,
      messageId,
      phase: 'LATCHED',
      snapshotText: nextText,
      latchedTextLength: nextLength,
      terminalStatus,
      updatedAt: Date.now(),
      ...(existing?.cancelPendingDrain
        ? { cancelPendingDrain: existing.cancelPendingDrain }
        : {}),
    };
    this.records.set(key, record);
    return record;
  }

  public markLatched(
    sessionId: string,
    messageId: string,
    latchedTextLength: number | string = 0
  ): DualLatchTurnRecord {
    return this.latch(sessionId, messageId, latchedTextLength, 'completed');
  }

  public commit(
    sessionId: string,
    messageId: string,
    onCommit?: (record: DualLatchTurnRecord) => void
  ): DualLatchTurnRecord {
    const key = makeDualLatchKey(sessionId, messageId);
    const existing =
      this.records.get(key) ??
      this.latch(sessionId, messageId, '', 'completed');
    if (isValidDualLatchTransition(existing.phase, 'COMMITTED')) {
      existing.phase = 'COMMITTED';
      existing.updatedAt = Date.now();
    }
    onCommit?.(existing);
    return existing;
  }

  public markCommitted(
    sessionId: string,
    messageId: string
  ): DualLatchTurnRecord {
    return this.commit(sessionId, messageId);
  }

  public markDrained(
    sessionId: string,
    messageId: string
  ): DualLatchTurnRecord {
    const key = makeDualLatchKey(sessionId, messageId);
    const existing = this.records.get(key) ?? this.commit(sessionId, messageId);
    existing.phase = 'DRAINED';
    existing.updatedAt = Date.now();
    delete existing.cancelPendingDrain;

    // 【P0 重构落地：终态排空即刻微任务释放】
    // 同步清空文本，瞬间释放可能多达数 MB 的快照文本占用
    existing.snapshotText = '';

    // 排空微任务调度：在当前宏任务帧微任务阶段彻底物理剔除该条目，根绝无界内存泄漏
    queueMicrotask(() => {
      const rec = this.records.get(key);
      if (rec && rec.phase === 'DRAINED') {
        this.records.delete(key);
      }
    });

    return existing;
  }

  public drain(
    sessionId: string,
    messageId: string,
    options?: {
      companionMessageIds?: readonly string[];
      onDrained?: (record: DualLatchTurnRecord) => void;
    }
  ): () => void {
    const key = makeDualLatchKey(sessionId, messageId);
    const record = this.records.get(key) ?? this.commit(sessionId, messageId);
    record.cancelPendingDrain?.();

    const cancel = executeDualRafHandoff(() => {
      const current = this.markDrained(sessionId, messageId);
      const companion = options?.companionMessageIds;
      if (companion && companion.length > 0)
        clearStreams(sessionId, [messageId, ...companion]);
      else clearStream(sessionId, messageId);
      options?.onDrained?.(current);
    });
    record.cancelPendingDrain = cancel;
    return cancel;
  }

  public executeHandoff(options: DualLatchHandoffOptions): () => void {
    const {
      sessionId,
      messageId,
      snapshotText,
      terminalStatus = 'completed',
      companionMessageIds,
      onCommit,
      onDrained,
    } = options;
    const latchedRecord = this.latch(
      sessionId,
      messageId,
      snapshotText,
      terminalStatus
    );
    this.commit(sessionId, messageId, (rec) => {
      onCommit?.(rec.snapshotText, rec.terminalStatus);
    });
    return this.drain(sessionId, latchedRecord.messageId, {
      ...(companionMessageIds ? { companionMessageIds } : {}),
      ...(onDrained ? { onDrained: () => onDrained() } : {}),
    });
  }

  public getPhase(sessionId: string, messageId: string): DualLatchPhase {
    return (
      this.records.get(makeDualLatchKey(sessionId, messageId))?.phase ??
      'STREAMING'
    );
  }

  public getRecord(
    sessionId: string,
    messageId: string
  ): DualLatchTurnRecord | undefined {
    return this.records.get(makeDualLatchKey(sessionId, messageId));
  }

  /**
   * 刚性清理指定会话下的全部锁存记录与挂起排空定时器（会话销毁 / 级联取消专属）
   */
  public abortSession(sessionId: string): void {
    if (!sessionId) return;
    const prefix = sessionMessageKeyPrefix(sessionId);
    for (const [key, rec] of this.records.entries()) {
      if (key.startsWith(prefix)) {
        rec.cancelPendingDrain?.();
        rec.snapshotText = '';
        this.records.delete(key);
      }
    }
  }

  /** 获取当前活跃锁存记录数（供测试断言与内存监控诊断） */
  public getRecordCount(): number {
    return this.records.size;
  }

  public clearAll(): void {
    for (const [, rec] of this.records) {
      rec.cancelPendingDrain?.();
      rec.snapshotText = '';
    }
    this.records.clear();
  }
}

export const dualLatchStateMachine = new DualLatchStateMachine();
