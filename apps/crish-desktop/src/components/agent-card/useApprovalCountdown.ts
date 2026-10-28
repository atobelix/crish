import { useEffect, useRef, useState, useMemo, useCallback } from 'react';

/** 超时动作策略定义 */
export type ApprovalTimeoutPolicy = 'auto-allow' | 'auto-deny' | 'manual-only';

/** 张力色彩阶段：calm(绿色 >50%) | warning(琥珀色 20%~50%) | critical(绯红色 <20%) */
export type CountdownTensionStage = 'calm' | 'warning' | 'critical';

export interface UseApprovalCountdownOptions {
  /** 权威绝对到期毫秒时间戳 (Server Epoch MS，SSOT) */
  expiresAtMs?: number | undefined;
  /** 超时预算总时长 (ms)，用于计算百分比分母 */
  timeoutMs?: number | undefined;
  /** 超时动作策略 */
  timeoutPolicy?: ApprovalTimeoutPolicy | undefined;
  /** 外部是否置于 busy (提交中不触发超时回调) */
  busy?: boolean | undefined;
  /** 是否已被前端暂停锁定 */
  isPaused?: boolean | undefined;
  /** 遗留兼容：相对剩余毫秒数 */
  remainingMs?: number | undefined;
  /** 超时到达通知回调 (纯 UI 层通知，严禁发起 IPC 自决) */
  onTimeout?: (() => void) | undefined;
}

export interface UseApprovalCountdownResult {
  /** 当前剩余毫秒数 */
  remainingMs: number;
  /** 格式化后的剩余秒数 */
  remainingSeconds: number;
  /** 进度百分比 (0.0 - 100.0) */
  percent: number;
  /** 兼容现有调用方的别名百分比 */
  timeoutPercent: number;
  /** 当前张力阶段：绿色 >50%，琥珀色 20%~50%，绯红色 <20% */
  tensionStage: CountdownTensionStage;
  /** 是否已超时归零 */
  isExpired: boolean;
  /** 是否正处于暂停态 */
  isPaused: boolean;
  /** 是否处于有效运行倒计时中 */
  isActive: boolean;
}

/**
 * 权威时间基准单源 (Server Epoch SSOT) 审批倒计时 Hook：
 * - 彻底废除父组件重渲染导致的 100% 暴走复位 bug；
 * - 倒计时归零仅设置 isExpired 标志并锁定 UI，严禁向后端发起任何 IPC 决策请求；
 * - 计算三阶段张力色彩进度 (绿色 >50%，琥珀色 20%~50%，绯红色 <20%)。
 */
export function useApprovalCountdown({
  expiresAtMs: propExpiresAtMs,
  timeoutMs: propTimeoutMs,
  timeoutPolicy = 'auto-deny',
  busy = false,
  isPaused = false,
  remainingMs: propRemainingMs,
  onTimeout,
}: UseApprovalCountdownOptions): UseApprovalCountdownResult {
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const busyRef = useRef(busy);
  busyRef.current = busy;

  // 记录是否已触发过超时通知
  const firedRef = useRef(false);

  // 权威绝对到期时间戳归一化（优先使用 expiresAtMs，兼容遗留相对 remainingMs 入参）
  const initialAnchorRef = useRef<{
    expiresAtMs: number | undefined;
    timeoutMs: number;
  } | null>(null);

  if (!initialAnchorRef.current) {
    if (propExpiresAtMs != null) {
      initialAnchorRef.current = {
        expiresAtMs: propExpiresAtMs,
        timeoutMs: Math.max(1, propTimeoutMs ?? 60000),
      };
    } else if (propRemainingMs != null) {
      initialAnchorRef.current = {
        expiresAtMs: Date.now() + Math.max(0, propRemainingMs),
        timeoutMs: Math.max(1, propTimeoutMs ?? propRemainingMs),
      };
    }
  }

  // 当外部显式更新 expiresAtMs 或 remainingMs 切换任务时同步更新锚点
  const effectiveExpiresAtMs =
    propExpiresAtMs ?? initialAnchorRef.current?.expiresAtMs;
  const effectiveTimeoutMs =
    propTimeoutMs ?? initialAnchorRef.current?.timeoutMs ?? 60000;

  // 计算当前剩余时间的纯函数
  const calculateRemaining = useCallback((): number => {
    if (timeoutPolicy === 'manual-only' || effectiveExpiresAtMs == null) {
      return 0;
    }
    return Math.max(0, effectiveExpiresAtMs - Date.now());
  }, [effectiveExpiresAtMs, timeoutPolicy]);

  const [remainingMs, setRemainingMs] = useState<number>(calculateRemaining);

  // 暂停态的锁定时间快照
  const pausedRemainingRef = useRef<number | null>(null);

  // 当有效到期时间戳发生变更时重置触发状态
  useEffect(() => {
    firedRef.current = false;
    pausedRemainingRef.current = null;
    setRemainingMs(calculateRemaining());
  }, [effectiveExpiresAtMs, calculateRemaining]);

  // 核心时钟驱动循环（100ms 平滑采样，绝不依赖频繁变动的相对时间）
  useEffect(() => {
    if (effectiveExpiresAtMs == null || timeoutPolicy === 'manual-only') {
      return;
    }

    if (isPaused) {
      if (pausedRemainingRef.current === null) {
        pausedRemainingRef.current = Math.max(
          0,
          effectiveExpiresAtMs - Date.now()
        );
      }
      setRemainingMs(pausedRemainingRef.current);
      return;
    }

    // 恢复运行时清除暂停快照
    pausedRemainingRef.current = null;

    const updateClock = () => {
      const now = Date.now();
      const left = Math.max(0, effectiveExpiresAtMs - now);
      setRemainingMs(left);

      if (left <= 0) {
        if (!firedRef.current && !busyRef.current) {
          firedRef.current = true;
          onTimeoutRef.current?.();
        }
      }
    };

    updateClock();
    const timerId = setInterval(updateClock, 100);

    return () => {
      clearInterval(timerId);
    };
  }, [effectiveExpiresAtMs, isPaused, timeoutPolicy]);

  // 当 busy 状态解除且已经超时时，补发一次 UI 通知
  useEffect(() => {
    if (
      !busy &&
      remainingMs <= 0 &&
      effectiveExpiresAtMs != null &&
      timeoutPolicy !== 'manual-only' &&
      !firedRef.current &&
      !isPaused
    ) {
      firedRef.current = true;
      onTimeoutRef.current?.();
    }
  }, [busy, remainingMs, effectiveExpiresAtMs, isPaused, timeoutPolicy]);

  // 百分比计算 (0.0 - 100.0)
  const total = Math.max(effectiveTimeoutMs, 1000);
  const percent =
    effectiveExpiresAtMs != null && timeoutPolicy !== 'manual-only'
      ? Math.max(0, Math.min(100, (remainingMs / total) * 100))
      : 0;

  // 三阶段张力色彩判定：绿色 >50%，琥珀色 20%~50%，绯红色 <20%
  const tensionStage: CountdownTensionStage = useMemo(() => {
    if (percent < 20 || (remainingMs <= 5000 && remainingMs > 0)) {
      return 'critical';
    }
    if (percent <= 50) {
      return 'warning';
    }
    return 'calm';
  }, [percent, remainingMs]);

  const isExpired = Boolean(
    effectiveExpiresAtMs != null &&
    timeoutPolicy !== 'manual-only' &&
    remainingMs <= 0
  );

  const isActive = Boolean(
    effectiveExpiresAtMs != null &&
    timeoutPolicy !== 'manual-only' &&
    remainingMs > 0
  );

  return {
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    percent,
    timeoutPercent: percent,
    tensionStage,
    isExpired,
    isPaused,
    isActive,
  };
}
