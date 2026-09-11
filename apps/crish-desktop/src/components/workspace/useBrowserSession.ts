/**
 * 受管浏览器会话 hook：状态机 + invoke 封装 + 事件订阅。
 * 对齐 usePreviewNavigation 风格：hook 收拢全部状态副作用，渲染层只消费返回值。
 *
 * 反馈约定：仅错误 toast（启动/停止/急停/查询失败）；成功路径静默
 * （状态展示即反馈）。初始查询失败同样 toast（引擎未接线时给出明确诊断）。
 *
 * 评审修复（F2/F3/F4/F7）：
 * - 挂载竞态（F2）：先订阅事件、再查询初始状态；事件先到时查询回包
 *   （查询时刻的旧快照）不得覆盖事件态——事件优先，查询仅在无事件时作基线；
 * - 急停 force（F3）：kill 走 browser_stop force=true（Rust 侧强制杀树路径，
 *   不等会话锁）；与 stop（Graceful）命令同名仅参数不同；
 * - busy 超时（F4）：操作挂死 30s 后强制释放互斥，防永久锁死；
 * - crash 原因（F7）：事件/查询载荷携带 reason 时透出（前端兼容解析）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvokeTypedResult } from '../../api/tauriInvoke';
import {
  fetchBrowserStatus,
  listenBrowserStateEvent,
  startBrowserSession,
  stopBrowserSession,
} from '../../api/browserSessionApi';
import {
  normalizeBrowserState,
  parseBrowserStatePayload,
  type BrowserSessionState,
} from './browserSessionLib';

import { useToast } from '../../services/toast/ToastContext';

/** busy 互斥超时（评审 F4）：操作挂死 30s 后强制释放，防永久锁死。 */
const BUSY_OPERATION_TIMEOUT_MS = 30_000;

export interface UseBrowserSessionResult {
  state: BrowserSessionState;
  url?: string;
  /** 崩溃/异常原因（事件或查询载荷携带时透出；无则 undefined） */
  reason?: string;
  /** 是否有进行中的操作（启动/停止/急停互斥，防重复点击） */
  busy: boolean;
  /** 启动浏览器 */
  start: () => void;
  /** 正常停止（running 态可用；Graceful） */
  stop: () => void;
  /** 急停（running/launching 态可用；browser_stop force=true 强制杀树） */
  kill: () => void;
}

/** 三态失败 → 用户可读文案（missing = 引擎未接线）；action 为完整动作名，如「启动浏览器」 */
function describeInvokeFailure(
  res: InvokeTypedResult<unknown>,
  action: string,
): string {
  if (res.status === 'missing') {
    return `无法${action}：引擎未接线浏览器控制命令`;
  }
  if (res.status === 'error') {
    return `${action}失败：${res.message}`;
  }
  return `${action}失败：未知错误`;
}

/** 载荷 reason 字段提取（评审 F7：崩溃事件携带原因，前端兼容解析）。 */
function extractPayloadReason(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const r = (payload as Record<string, unknown>).reason;
  return typeof r === 'string' && r ? r : undefined;
}

export function useBrowserSession(): UseBrowserSessionResult {
  const { showToast } = useToast();
  const [state, setState] = useState<BrowserSessionState>('idle');
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const toastRef = useRef(showToast);
  toastRef.current = showToast;
  const busyRef = useRef(false);

  const applyPayload = useCallback((payload: unknown) => {
    const parsed = parseBrowserStatePayload(payload);
    if (!parsed) return;
    setState(parsed.state);
    setUrl(parsed.url);
    setReason(extractPayloadReason(payload));
  }, []);

  // 操作互斥：busy 用 ref 同步判定，避免 setState 异步导致连点；
  // 超时强制释放（评审 F4）：操作挂死 30s 后解除互斥（操作仍在途，
  // 仅防永久锁死；后续点击可重新派发）
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

  // 挂载：先订阅事件，再查询初始状态（评审 F2 修复挂载竞态——旧实现查询与
  // 订阅并行，订阅建立前的状态迁移事件丢失；现实现：订阅就绪后的事件不丢，
  // 查询结果仅在无事件到达时作为基线——事件优先，旧快照不得回滚事件态）
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let eventSeen = false;

    const handler = (payload: unknown) => {
      if (cancelled) return;
      eventSeen = true;
      applyPayload(payload);
    };

    listenBrowserStateEvent(handler).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
      fetchBrowserStatus().then((res) => {
        if (cancelled) return;
        // 事件已先到：查询快照为查询时刻的旧值，丢弃（事件态优先）
        if (eventSeen) return;
        if (res.status === 'ok') {
          const parsed = parseBrowserStatePayload(res.data);
          if (parsed) {
            setState(parsed.state);
            setUrl(parsed.url);
            setReason(extractPayloadReason(res.data));
          }
        } else {
          setState('error');
          toastRef.current(describeInvokeFailure(res, '查询浏览器状态'));
        }
      });
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyPayload]);

  const start = useCallback(() => {
    runOperation(async () => {
      const res = await startBrowserSession();
      if (res.status === 'ok') {
        // 'starting' 归一为 'launching'（UI 单一状态机）
        const st = normalizeBrowserState(res.data.state);
        if (st === 'error' || res.data.state === 'error') {
          setState('error');
          setReason(res.data.reason);
          toastRef.current(
            `启动浏览器失败：${res.data.reason || '未知原因'}`,
          );
        } else if (st) {
          setState(st);
          setReason(undefined);
        }
      } else {
        setState('error');
        toastRef.current(describeInvokeFailure(res, '启动浏览器'));
      }
    });
  }, [runOperation]);

  const stopSession = useCallback(
    (force = false) => {
      runOperation(async () => {
        const res = await stopBrowserSession(force);
        if (res.status === 'ok') {
          setState('stopped');
          setReason(undefined);
        } else {
          setState('error');
          toastRef.current(
            describeInvokeFailure(res, force ? '急停浏览器' : '停止浏览器'),
          );
        }
      });
    },
    [runOperation],
  );

  return {
    state,
    url,
    reason,
    busy,
    start,
    stop: () => stopSession(false),
    kill: () => stopSession(true),
  };
}
