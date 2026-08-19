/**
 * 电脑操作会话 hook：enabled 状态机 + activation 三态 + invoke 封装 +
 * 事件订阅。对齐 useBrowserSession 风格：hook 收拢全部状态副作用，渲染层
 * 只消费返回值。
 *
 * 接线语义（已接线，三命令已登记于 Rust 侧，与 `command_manifest.rs` / `main.rs` 同步）：
 * - 挂载：先订阅事件、再查询初始状态（事件优先，对齐 F2 修复的挂载竞态
 *   范式）；查询正常返回引擎状态，missing 仅兜底（非 Tauri 环境）；
 * - 开关：enable/disable 走 invoke，正常落盘引擎，missing 仅兜底本地化；
 * - busy 互斥 + 30s 超时释放（对齐 F4 评审修复）。
 *
 * 反馈约定：仅错误 / 兜底提示 toast；成功路径静默（状态展示即反馈）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { } from '../../../hooks/useToastQueue';
import type { InvokeTypedResult } from '../../../api/tauriInvoke';
import {
  disableComputerSession,
  enableComputerSession,
  fetchComputerStatus,
  listenComputerStateEvent,
} from '../../../api/computerSessionApi';
import {
  parseComputerStatePayload,
  type ComputerActivation,
} from './computerPanelLib';

/** busy 互斥超时（对齐评审 F4）：操作挂死 30s 后强制释放，防永久锁死。 */
const BUSY_OPERATION_TIMEOUT_MS = 30_000;

export interface UseComputerSessionOptions {
}

export interface UseComputerSessionResult {
  /** 会话显式开启 */
  enabled: boolean;
  /** ActivationGate 三态（idle/browser/desktop） */
  activation: ComputerActivation;
  /** 命令面是否接线（正常 true；missing 时 false，面板降级提示） */
  wired: boolean;
  /** 是否有进行中的操作（开关互斥，防重复点击） */
  busy: boolean;
  /** 显式开启（风险确认流在组件层完成后调用） */
  enable: () => void;
  /** 停用（解除授权） */
  disable: () => void;
}

/** 三态失败 → 用户可读文案（missing 为兜底，非 Tauri 环境）；action 为完整动作名 */
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

/** missing 兜底时的本地化提示（非 Tauri 环境）。 */
function describeUnwiredFallback(action: string): string {
  return `引擎未接线：${action}已本地记录（不落盘，重启后不保留）`;
}

import { toast } from '../../../services/toast/ToastContext';

export function useComputerSession(
  _opts?: UseComputerSessionOptions
): UseComputerSessionResult {
  const [enabled, setEnabled] = useState(false);
  const [activation, setActivation] = useState<ComputerActivation>('idle');
  const [wired, setWired] = useState(true);
  const [busy, setBusy] = useState(false);
  const toastRef = useRef((m: string) => toast.show(m));
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
          // 兜底：非 Tauri 环境或旧版本 missing（正常已接线不应命中）
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
        // 兜底：非 Tauri 环境 missing 时本地化置位（正常已接线不应命中）
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
        // 兜底：非 Tauri 环境 missing 时本地化置位（正常已接线不应命中）
        setEnabled(false);
        setWired(false);
        toastRef.current(describeUnwiredFallback('停用电脑操作'));
      } else {
        toastRef.current(describeInvokeFailure(res, '停用电脑操作'));
      }
    });
  }, [runOperation]);

  return { enabled, activation, wired, busy, enable, disable };
}
