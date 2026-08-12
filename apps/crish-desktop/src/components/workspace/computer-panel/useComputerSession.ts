/**
 * 电脑操作会话 hook：enabled 本地化状态机 + activation 三态 + invoke 封装 +
 * 事件订阅。对齐 useBrowserSession 风格：hook 收拢全部状态副作用，渲染层
 * 只消费返回值。
 *
 * 接线语义（命令面未接线，06 §8 遗留项 9/10）：
 * - 挂载：先订阅事件、再查询初始状态（事件优先，对齐 F2 修复的挂载竞态
 *   范式）；查询返回 missing → wired=false（预期状态，不 toast——面板
 *   展示「引擎未接线」徽标降级提示）；
 * - 开关：enable/disable 走 invoke，missing 时本地化置位并 toast 提示
 *   「本地记录不落盘」；error 时 toast 错误；
 * - 急停：estop invoke，ok/missing 均本地复位（activation→idle、
 *   enabled→false——04 §4.3 急停回 Idle + §4.4 恢复需重新显式开启）；
 * - busy 互斥 + 30s 超时释放（对齐 F4 评审修复）。
 *
 * 反馈约定：仅错误 / 降级提示 toast；成功路径静默（状态展示即反馈）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShowToastFn } from '../../../hooks/useToastQueue';
import type { InvokeTypedResult } from '../../../api/tauriInvoke';
import {
  disableComputerSession,
  enableComputerSession,
  fetchComputerStatus,
  listenComputerStateEvent,
  triggerComputerEstop,
} from '../../../api/computerSessionApi';
import {
  parseComputerStatePayload,
  type ComputerActivation,
} from './computerPanelLib';

/** busy 互斥超时（对齐评审 F4）：操作挂死 30s 后强制释放，防永久锁死。 */
const BUSY_OPERATION_TIMEOUT_MS = 30_000;

export interface UseComputerSessionOptions {
  onShowToast: ShowToastFn;
}

export interface UseComputerSessionResult {
  /** 会话显式开启（命令面未接线时为本地记录，不落盘） */
  enabled: boolean;
  /** ActivationGate 三态（idle/browser/desktop；未接线恒 idle） */
  activation: ComputerActivation;
  /** 命令面是否接线（status 查询 missing → false，面板显示降级徽标） */
  wired: boolean;
  /** 是否有进行中的操作（开关/急停互斥，防重复点击） */
  busy: boolean;
  /** 显式开启（风险确认流在组件层完成后调用） */
  enable: () => void;
  /** 停用（解除授权） */
  disable: () => void;
  /** 全局急停（确认流在组件层完成后调用；急停后回 idle 且需重新开启） */
  estop: () => void;
}

/** 三态失败 → 用户可读文案（missing = 引擎未接线）；action 为完整动作名 */
function describeInvokeFailure(
  res: InvokeTypedResult<unknown>,
  action: string
): string {
  if (res.status === 'missing') {
    return `无法${action}：引擎未接线电脑操作命令`;
  }
  if (res.status === 'error') {
    return `${action}失败：${res.message}`;
  }
  return `${action}失败：未知错误`;
}

/** missing（引擎未接线）时的本地化降级提示。 */
function describeUnwiredFallback(action: string): string {
  return `引擎未接线：${action}已本地记录（不落盘，重启后不保留）`;
}

export function useComputerSession(
  opts: UseComputerSessionOptions
): UseComputerSessionResult {
  const [enabled, setEnabled] = useState(false);
  const [activation, setActivation] = useState<ComputerActivation>('idle');
  const [wired, setWired] = useState(true);
  const [busy, setBusy] = useState(false);
  const toastRef = useRef(opts.onShowToast);
  toastRef.current = opts.onShowToast;
  const busyRef = useRef(false);

  const applyPayload = useCallback((payload: unknown) => {
    const parsed = parseComputerStatePayload(payload);
    if (!parsed) return;
    if (parsed.enabled !== undefined) setEnabled(parsed.enabled);
    if (parsed.activation !== undefined) setActivation(parsed.activation);
  }, []);

  // 操作互斥：busy 用 ref 同步判定，避免 setState 异步导致连点；
  // 超时强制释放（对齐 F4）：操作挂死 30s 后解除互斥（仅防永久锁死）
  const runOperation = useCallback((op: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    op().finally(() => {
      if (timer) clearTimeout(timer);
      busyRef.current = false;
      setBusy(false);
    });
    timer = setTimeout(() => {
      busyRef.current = false;
      setBusy(false);
    }, BUSY_OPERATION_TIMEOUT_MS);
  }, []);

  // 挂载：先订阅事件，再查询初始状态（事件优先——查询旧快照不得回滚事件态）
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let eventSeen = false;

    const handler = (payload: unknown) => {
      if (cancelled) return;
      eventSeen = true;
      applyPayload(payload);
    };

    listenComputerStateEvent(handler).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
      fetchComputerStatus().then((res) => {
        if (cancelled) return;
        // 事件已先到：查询快照为查询时刻的旧值，丢弃（事件态优先）
        if (eventSeen) return;
        if (res.status === 'ok') {
          applyPayload(res.data);
        } else if (res.status === 'missing') {
          // 命令未接线是当前预期状态（S5 遗留接线项）：不 toast，
          // 面板以「引擎未接线」徽标降级提示（wired=false）
          setWired(false);
        } else {
          // 命令存在但查询报错：toast 明确诊断
          setWired(false);
          toastRef.current(describeInvokeFailure(res, '查询电脑操作状态'));
        }
      });
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyPayload]);

  const enable = useCallback(() => {
    runOperation(async () => {
      const res = await enableComputerSession();
      if (res.status === 'ok') {
        if (typeof res.data?.enabled === 'boolean')
          setEnabled(res.data.enabled);
        setWired(true);
      } else if (res.status === 'missing') {
        // 命令面未接线：本地化置位 + 降级提示（不落盘）
        setEnabled(true);
        setWired(false);
        toastRef.current(describeUnwiredFallback('启用电脑操作'));
      } else {
        toastRef.current(describeInvokeFailure(res, '启用电脑操作'));
      }
    });
  }, [runOperation]);

  const disable = useCallback(() => {
    runOperation(async () => {
      const res = await disableComputerSession();
      if (res.status === 'ok') {
        if (typeof res.data?.enabled === 'boolean')
          setEnabled(res.data.enabled);
        setWired(true);
      } else if (res.status === 'missing') {
        setEnabled(false);
        setWired(false);
        toastRef.current(describeUnwiredFallback('停用电脑操作'));
      } else {
        toastRef.current(describeInvokeFailure(res, '停用电脑操作'));
      }
    });
  }, [runOperation]);

  const estop = useCallback(() => {
    runOperation(async () => {
      const res = await triggerComputerEstop('panel-button');
      if (res.status === 'ok') {
        // 04 §4.3 急停语义：中止在途注入 → 感知源停止 → 会话回 Idle；
        // §4.4 恢复需重新显式开启 → enabled 复位
        setActivation('idle');
        setEnabled(false);
      } else if (res.status === 'missing') {
        // 命令面未接线：本地复位（未触达引擎急停链——提示明确）
        setActivation('idle');
        setEnabled(false);
        toastRef.current(
          '引擎未接线：已本地复位会话标记（未触达引擎全局急停链）'
        );
      } else {
        toastRef.current(describeInvokeFailure(res, '全局急停'));
      }
    });
  }, [runOperation]);

  return { enabled, activation, wired, busy, enable, disable, estop };
}
