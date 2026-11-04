// 发送队列消费面（批 C 01-4/②）：订阅 sendQueueStore 的单会话队列 +
// 排空状态机。状态机语义（两引擎共用）：
// - idle：无生成进行且队列非空 → 取队首发送；受理（send 返回 true）
//   后条目正式出队，进 awaiting；
// - awaiting：已受理但生成活动尚未被观察到——活动出现转 running；
//   终局信号先到（远端 = run-terminal notice，运行瞬间失败/完成而
//   无流式块）直接回 idle 续发下一条；15s 无活动无信号兜底回 idle
//   （防病理静默把队列永久卡死，条目不丢）；
// - running：活动结束回 idle，续发下一条；
// - send 被拒（在飞锁/未受理）：条目回滚队首（顺序不变、不丢失）并
//   闩住该队首——同一条目不自动重试（确定性失败如附件超限会永远
//   失败，热循环无意义）；闩在队首变更或一轮生成周期完成时解除。
// 队列真源在 sendQueueStore（按会话键隔离 + 持久化）；本 hook 只做
// 订阅与驱动，不复制队列状态。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { nextId } from '@/domain/pure/id';
import type { ComposerAttachment } from '@/domain/pure/attachments';
import {
  hydrateSendQueueKey,
  sendQueueStore,
  type SendQueueItem,
} from '@/domain/store/sendQueueStore';

export interface SendQueueDrain {
  /** 生成/发送进行中信号（true 时不取队首；发送入口据此改走入队） */
  active: boolean;
  /**
   * 排空硬门（true 时不取队首）：发送通道当前必然未受理的环境事实
   * （远端未连接 / 本地未配置）——与 active（生成态）分开，避免把
   * 「离线发送」的既有反馈行为改成静默排队。
   */
  blocked?: boolean;
  /** 发送一条排队意图；true = 已受理（条目出队），false = 未受理（回滚） */
  send: (item: SendQueueItem) => Promise<boolean> | boolean;
  /**
   * 终局信号（可选）：自 sinceMs 起是否已出现运行终局呈现
   * （远端引擎以 run-terminal notice 的 atMs 判定；本地引擎生成态
   * 由 streaming 布尔权威承载，不提供本信号）。
   */
  terminalSignal?: (sinceMs: number) => boolean;
  /** 信号世代（终局呈现变化时递增的数值，驱动 awaiting 复查） */
  signalEpoch?: number;
}

export interface SendQueueApi {
  items: readonly SendQueueItem[];
  /** 入队（达到每会话上限返回 false，调用方给诚实提示） */
  enqueue: (
    text: string,
    attachments?: readonly ComposerAttachment[]
  ) => boolean;
  /** 撤回单条（未发出的排队消息） */
  withdraw: (itemId: string) => void;
}

const EMPTY_ITEMS: readonly SendQueueItem[] = [];

/** awaiting 兜底时长：受理后无活动无终局信号的最长等待（防卡死） */
const AWAITING_FALLBACK_MS = 15_000;

export function useSendQueue(
  queueKey: string,
  drain: SendQueueDrain
): SendQueueApi {
  const items = useStore(
    sendQueueStore,
    (s) => s.queues[queueKey] ?? EMPTY_ITEMS
  );

  useEffect(() => {
    void hydrateSendQueueKey(queueKey);
  }, [queueKey]);

  const enqueue = useCallback(
    (text: string, attachments: readonly ComposerAttachment[] = []) =>
      sendQueueStore.getState().enqueue(queueKey, {
        id: nextId('queue'),
        text,
        attachments: [...attachments],
        createdAtMs: Date.now(),
      }),
    [queueKey]
  );

  const withdraw = useCallback(
    (itemId: string) => sendQueueStore.getState().withdraw(queueKey, itemId),
    [queueKey]
  );

  // ── 排空状态机 ────────────────────────────────────────────────────
  const phaseRef = useRef<'idle' | 'awaiting' | 'running'>('idle');
  const acceptedAtRef = useRef(0);
  /** 被拒队首闩：该 id 的条目不自动重试（解除条件见文件头注） */
  const rejectedHeadRef = useRef<string | null>(null);
  /** 上一拍的 active（下降沿 = 一轮生成周期完成 → 解闩） */
  const prevActiveRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tick, setTick] = useState(0);
  const drainRef = useRef(drain);
  drainRef.current = drain;
  const active = drain.active;
  const blocked = drain.blocked ?? false;
  const signalEpoch = drain.signalEpoch ?? 0;

  // 会话键变化 = 新队列：状态机复位（旧会话的在飞发送结果由其自身
  // send 承诺收敛，条目回滚按旧键 unshift，不串会话）
  useEffect(() => {
    phaseRef.current = 'idle';
    rejectedHeadRef.current = null;
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, [queueKey]);

  useEffect(() => {
    const d = drainRef.current;
    // 生成周期完成（active 下降沿）= 被拒队首的重试时机：不论本队列
    // 是否参与了那一轮（用户也可能手动发送），条件已变，解闩一次
    if (prevActiveRef.current && !d.active) {
      rejectedHeadRef.current = null;
    }
    prevActiveRef.current = d.active;
    if (phaseRef.current === 'awaiting') {
      if (d.active) {
        phaseRef.current = 'running';
        if (fallbackTimerRef.current !== null) {
          clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = null;
        }
        return;
      }
      if (d.terminalSignal?.(acceptedAtRef.current)) {
        phaseRef.current = 'idle';
      } else {
        return; // 继续等待活动/信号/兜底定时
      }
    }
    if (phaseRef.current === 'running') {
      if (d.active) return;
      phaseRef.current = 'idle';
      // 一轮生成周期完成 = 被拒队首的重试时机
      rejectedHeadRef.current = null;
    }
    if (d.active || d.blocked) return;
    const head = sendQueueStore.getState().queues[queueKey]?.[0];
    if (!head) return;
    if (rejectedHeadRef.current === head.id) return;
    if (rejectedHeadRef.current !== null) rejectedHeadRef.current = null;
    phaseRef.current = 'awaiting';
    acceptedAtRef.current = Date.now();
    const shifted = sendQueueStore.getState().shift(queueKey);
    if (!shifted) {
      phaseRef.current = 'idle';
      return;
    }
    fallbackTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = null;
      if (phaseRef.current === 'awaiting') {
        phaseRef.current = 'idle';
        setTick((t) => t + 1);
      }
    }, AWAITING_FALLBACK_MS);
    let outcome: Promise<boolean>;
    try {
      outcome = Promise.resolve(d.send(shifted));
    } catch {
      outcome = Promise.resolve(false);
    }
    void outcome.then((ok) => {
      if (ok) return;
      // 未受理：条目回滚队首（不丢失）并闩住，不自动重试同一条目
      sendQueueStore.getState().unshift(queueKey, shifted);
      rejectedHeadRef.current = shifted.id;
      if (phaseRef.current === 'awaiting') phaseRef.current = 'idle';
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    });
  }, [items, active, blocked, signalEpoch, tick, queueKey]);

  return { items, enqueue, withdraw };
}
