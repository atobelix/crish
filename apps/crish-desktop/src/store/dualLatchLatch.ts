/**
 * apps/crish-desktop/src/store/dualLatchLatch.ts
 *
 * 双轨锁存交接协议（Dual-Latch Handoff Protocol）第一轨：语义自锁存 Barrier。
 * 类型契约、四态序、纯函数（单调文本解析 / 终态校验 / 锁存与终态应用）。
 * 从 dualLatchProtocol.ts 拆出（行数门禁收敛）：rAF 交接与状态机留主模块。
 */

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

/** rAF / setTimeout 计时句柄（DOM 返回 number；Node 计时器为 Timeout 对象） */
export type RafTimerId = number | ReturnType<typeof setTimeout>;

export interface RafScheduler {
  readonly requestAnimationFrame: (
    callback: (timestamp: number) => void
  ) => RafTimerId;
  readonly cancelAnimationFrame: (handle: RafTimerId) => void;
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
