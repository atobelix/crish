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

import { clearStream, clearStreams } from '../store/streamingStore';

export type DualLatchPhase = 'STREAMING' | 'LATCHED' | 'COMMITTED' | 'DRAINED';
export type DualLatchState = DualLatchPhase;
export type TerminalStreamStatus =
  'completed' | 'error' | 'aborted' | 'cancelled' | 'stopped';

export const DUAL_LATCH_PHASE_ORDER: Readonly<Record<DualLatchPhase, number>> =
  Object.freeze({
    STREAMING: 0,
    LATCHED: 1,
    COMMITTED: 2,
    DRAINED: 3,
  });

export const DUAL_RAF_FALLBACK_MS = 32;

export interface RafScheduler {
  readonly requestAnimationFrame: (
    callback: (timestamp: number) => void
  ) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
}

export interface LatchableMessageShape {
  readonly id?: string | undefined;
  readonly text?: string | undefined;
  readonly streamText?: string | undefined;
  readonly thinking?: string | undefined;
  readonly status?: string | null | undefined;
}

export interface LatchedMessageResult<M> {
  readonly msg: M;
  readonly id?: string | undefined;
  readonly text: string;
  readonly streamText: undefined;
  readonly status?: string | null | undefined;
  readonly isLatched: boolean;
  readonly latched: boolean;
  readonly phase: DualLatchPhase;
}

export function isValidDualLatchTransition(
  from: DualLatchPhase,
  to: DualLatchPhase
): boolean {
  return DUAL_LATCH_PHASE_ORDER[to] >= DUAL_LATCH_PHASE_ORDER[from];
}

export function isTerminalStreamStatus(
  status?: string | null
): status is TerminalStreamStatus {
  return (
    status === 'completed' ||
    status === 'error' ||
    status === 'aborted' ||
    status === 'cancelled' ||
    status === 'stopped'
  );
}

/**
 * 非空单调渲染文本解析器（保障 Invariant 2：RenderedText 长度单调不减）
 */
export function resolveMonotonicRenderedText(
  persistedText: string | null | undefined,
  streamText: string | null | undefined,
  status?: string | null
): string {
  const durable = persistedText ?? '';
  const live = streamText ?? '';
  if (isTerminalStreamStatus(status))
    return durable.length >= live.length ? durable : live;
  return live.length >= durable.length ? live : durable;
}

/**
 * 第一道防线：ViewModel 语义自锁存解析器 (Semantic Self-Latch)
 *
 * 一旦消息处于终态或显式传入 terminalStatus：
 * 1. 将持久层 `msg.text` 与 `streamText` 取最长单调非空快照作为 SSOT；
 * 2. 强制将 `streamText` 置为 `undefined`；
 * 3. 同时返回扁平化消息属性与包装属性（`msg`, `isLatched`, `phase`）。
 */
export function resolveStreamMessageLatch<
  M extends {
    id?: string;
    status?: string | null;
    text?: string | null;
    streamText?: string | null;
  },
>(
  msg: M,
  streamText?: string | null,
  explicitTerminalStatus?: string | null
): M & LatchedMessageResult<M> {
  const effectiveStatus = explicitTerminalStatus ?? msg.status ?? undefined;
  const candidateStream = streamText ?? msg.streamText ?? undefined;
  const resolvedText = resolveMonotonicRenderedText(
    msg.text,
    candidateStream,
    effectiveStatus
  );

  if (isTerminalStreamStatus(effectiveStatus)) {
    const latchedMsg = {
      ...msg,
      text: resolvedText,
      streamText: undefined,
      status: effectiveStatus,
    };
    return {
      ...latchedMsg,
      msg: latchedMsg,
      text: resolvedText,
      streamText: undefined,
      isLatched: true,
      latched: true,
      phase: 'LATCHED',
    };
  }

  return {
    ...msg,
    msg,
    text: resolvedText,
    streamText: (candidateStream ?? undefined) as undefined,
    isLatched: false,
    latched: false,
    phase: 'STREAMING',
  };
}

/**
 * 终态状态锁存器：兼容 (msg, nextStatus, finalStreamBuffer) 与 (msg, streamText) 两种调用签名
 */
export function applyTerminalStatusLatch<
  M extends {
    id?: string;
    status?: string | null;
    text?: string | null;
    streamText?: string | null;
  },
>(
  msg: M,
  statusOrStreamText?: string | null,
  finalStreamBuffer?: string | null
): M & LatchedMessageResult<M> {
  if (isTerminalStreamStatus(statusOrStreamText)) {
    return resolveStreamMessageLatch(
      msg,
      finalStreamBuffer,
      statusOrStreamText
    );
  }
  return resolveStreamMessageLatch(msg, statusOrStreamText);
}

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
      cancelAnimationFrame: (id) => globalThis.cancelAnimationFrame(id),
    };
  }
  return {
    requestAnimationFrame: (cb) =>
      setTimeout(() => cb(Date.now()), 16) as unknown as number,
    cancelAnimationFrame: (id) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
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
    let raf1 = 0;
    let raf2 = 0;
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
  let raf1 = 0;
  let raf2 = 0;
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
  return `${sessionId || '__default__'}::${messageId}`;
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

  public abortSession(sessionId: string): void {
    if (!sessionId) return;
    const prefix = `${sessionId}::`;
    for (const [key, rec] of this.records.entries()) {
      if (key.startsWith(prefix)) {
        rec.cancelPendingDrain?.();
        this.records.delete(key);
      }
    }
  }

  public clearAll(): void {
    for (const [, rec] of this.records) rec.cancelPendingDrain?.();
    this.records.clear();
  }
}

export const dualLatchStateMachine = new DualLatchStateMachine();
