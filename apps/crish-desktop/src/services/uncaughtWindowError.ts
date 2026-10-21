/**
 * 窗口未捕获异常的唯一出口。
 * 布局观察器回路是浏览器自己发出的良性噪声，不进入通知。
 * 真正的异常只交给顶部通知，不再另做底栏。
 */
import { logger } from './LoggerService';
import { ToastStore } from './toast/ToastStore';

const RESIZE_OBSERVER_LOOP =
  /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/;

export interface WindowErrorLike {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
}

export interface RejectionLike {
  reason?: unknown;
}

export interface UncaughtWindowNotice {
  message: string;
  technical?: string;
}

export function isResizeObserverLoopNoise(
  text: string | null | undefined
): boolean {
  if (!text) return false;
  return RESIZE_OBSERVER_LOOP.test(text);
}

function locationOf(event: WindowErrorLike): string | undefined {
  if (!event.filename && !event.lineno && !event.colno) return undefined;
  return `${event.filename ?? '<unknown>'}:${event.lineno ?? 0}:${event.colno ?? 0}`;
}

/**
 * 读出应展示的文案。回路噪声返回空，调用方不得再通知。
 */
export function readUncaughtWindowNotice(
  kind: 'error' | 'unhandledrejection',
  event: WindowErrorLike | RejectionLike,
  fallbackMessage: string
): UncaughtWindowNotice | null {
  if (kind === 'error') {
    const ev = event as WindowErrorLike;
    const thrown = ev.error;
    const thrownMessage = thrown instanceof Error ? thrown.message : undefined;
    if (
      isResizeObserverLoopNoise(ev.message) ||
      isResizeObserverLoopNoise(thrownMessage)
    ) {
      return null;
    }
    const message =
      (ev.message || thrownMessage || fallbackMessage).trim() ||
      fallbackMessage;
    const technical =
      thrown instanceof Error && thrown.stack ? thrown.stack : locationOf(ev);
    return technical ? { message, technical } : { message };
  }

  const reason = (event as RejectionLike).reason;
  if (typeof reason === 'string') {
    if (isResizeObserverLoopNoise(reason)) return null;
    const message = reason.trim() || fallbackMessage;
    return { message, technical: reason };
  }
  if (reason instanceof Error) {
    if (isResizeObserverLoopNoise(reason.message)) return null;
    const message = reason.message.trim() || fallbackMessage;
    return { message, technical: reason.stack ?? reason.message };
  }
  if (reason !== undefined && reason !== null) {
    const technical = String(reason);
    if (isResizeObserverLoopNoise(technical)) return null;
    return { message: fallbackMessage, technical };
  }
  return { message: fallbackMessage };
}

export function reportUncaughtWindowNotice(
  notice: UncaughtWindowNotice | null
): void {
  if (!notice) {
    logger.debug('ignored-resize-observer-loop', {
      module: 'uncaught-window',
    });
    return;
  }
  logger.error('uncaught-window', {
    module: 'uncaught-window',
    err: {
      message: notice.message,
      ...(notice.technical ? { stack: notice.technical } : {}),
    },
  });
  ToastStore.error(notice.message);
}

export function installUncaughtWindowReporting(
  fallbackMessage: string
): () => void {
  if (typeof window === 'undefined') return () => {};

  const onError = (event: Event) => {
    reportUncaughtWindowNotice(
      readUncaughtWindowNotice(
        'error',
        event as WindowErrorLike,
        fallbackMessage
      )
    );
  };
  const onUnhandledRejection = (event: Event) => {
    reportUncaughtWindowNotice(
      readUncaughtWindowNotice(
        'unhandledrejection',
        event as RejectionLike,
        fallbackMessage
      )
    );
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
