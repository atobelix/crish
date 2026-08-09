/**
 * 受管浏览器会话 hook：状态机 + invoke 封装 + 事件订阅。
 * 对齐 usePreviewNavigation 风格：hook 收拢全部状态副作用，渲染层只消费返回值。
 *
 * 反馈约定：仅错误 toast（启动/停止/急停/查询失败）；成功路径静默
 * （状态展示即反馈）。初始查询失败同样 toast（引擎未接线时给出明确诊断）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShowToastFn } from '../../hooks/useToastQueue';
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

export interface UseBrowserSessionOptions {
  onShowToast: ShowToastFn;
}

export interface UseBrowserSessionResult {
  state: BrowserSessionState;
  url?: string;
  /** 是否有进行中的操作（启动/停止/急停互斥，防重复点击） */
  busy: boolean;
  /** 启动受管浏览器 */
  start: () => void;
  /** 正常停止（running 态可用） */
  stop: () => void;
  /** 急停（running/launching 态可用；与 stop 同一命令，UI 标注「强制」） */
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

export function useBrowserSession(
  opts: UseBrowserSessionOptions,
): UseBrowserSessionResult {
  const [state, setState] = useState<BrowserSessionState>('idle');
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const toastRef = useRef(opts.onShowToast);
  toastRef.current = opts.onShowToast;
  const busyRef = useRef(false);

  const applyPayload = useCallback((payload: unknown) => {
    const parsed = parseBrowserStatePayload(payload);
    if (!parsed) return;
    setState(parsed.state);
    setUrl(parsed.url);
  }, []);

  // 操作互斥：busy 用 ref 同步判定，避免 setState 异步导致连点
  const runOperation = useCallback((op: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    op().finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
  }, []);

  // 挂载：初始查询 + 订阅引擎事件
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    fetchBrowserStatus().then((res) => {
      if (cancelled) return;
      if (res.status === 'ok') {
        const parsed = parseBrowserStatePayload(res.data);
        if (parsed) {
          setState(parsed.state);
          setUrl(parsed.url);
        }
      } else {
        setState('error');
        toastRef.current(describeInvokeFailure(res, '查询浏览器状态'));
      }
    });

    listenBrowserStateEvent((payload) => {
      if (cancelled) return;
      applyPayload(payload);
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
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
          toastRef.current(
            `启动浏览器失败：${res.data.reason || '未知原因'}`,
          );
        } else if (st) {
          setState(st);
        }
      } else {
        setState('error');
        toastRef.current(describeInvokeFailure(res, '启动浏览器'));
      }
    });
  }, [runOperation]);

  const stopSession = useCallback(() => {
    runOperation(async () => {
      const res = await stopBrowserSession();
      if (res.status === 'ok') {
        setState('stopped');
      } else {
        setState('error');
        toastRef.current(describeInvokeFailure(res, '停止浏览器'));
      }
    });
  }, [runOperation]);

  return { state, url, busy, start, stop: stopSession, kill: stopSession };
}
