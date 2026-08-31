import React, {
  createContext,
  useContext,
  useMemo,
  useCallback,
} from 'react';
import {
  useToastQueue,
  type AppToast,
  } from '../../hooks/useToastQueue';
import { ToastContainer } from './ToastContainer';

export interface ShowToastOptions {
  ttlMs?: number;
  maxQueue?: number;
  id?: string;
  type?: 'info' | 'success' | 'warning' | 'error' | 'recovery';
}

export interface ToastContextValue {
  showToast: (
    message: string,
    onUndo?: () => void,
    options?: ShowToastOptions
  ) => void;
  dismissToast: (id: string) => void;
  toasts: readonly AppToast[];
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * 全局命令式发射器实例（供非 React 异步通信管道、事件监听器直接调用）
 */
let globalShowToast:
  | ((
      message: string,
      onUndo?: () => void,
      options?: ShowToastOptions
    ) => void)
  | null = null;
let globalDismissToast: ((id: string) => void) | null = null;

export const toast = {
  show: (
    message: string,
    onUndo?: () => void,
    options?: ShowToastOptions
  ): void => {
    if (globalShowToast) {
      globalShowToast(message, onUndo, options);
    } else if (import.meta.env?.DEV) {
      console.warn(
        '[ToastContext] ToastProvider not mounted yet. Message dropped:',
        message
      );
    }
  },
  success: (
    message: string,
    onUndo?: () => void,
    options?: Omit<ShowToastOptions, 'type'>
  ): void => {
    toast.show(message, onUndo, { ...options, type: 'success' });
  },
  info: (
    message: string,
    onUndo?: () => void,
    options?: Omit<ShowToastOptions, 'type'>
  ): void => {
    toast.show(message, onUndo, { ...options, type: 'info' });
  },
  error: (
    message: string,
    onUndo?: () => void,
    options?: Omit<ShowToastOptions, 'type'>
  ): void => {
    toast.show(message, onUndo, { ...options, type: 'error' });
  },
  warning: (
    message: string,
    onUndo?: () => void,
    options?: Omit<ShowToastOptions, 'type'>
  ): void => {
    toast.show(message, onUndo, { ...options, type: 'warning' });
  },
  dismiss: (id: string): void => {
    if (globalDismissToast) {
      globalDismissToast(id);
    }
  },
};

export interface ToastProviderProps {
  children: React.ReactNode;
}

/**
 * 全局 ToastProvider 单例容器
 */
export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const { toasts, showToast: queueShowToast, dismissToast } = useToastQueue();

  const handleShowToast = useCallback(
    (message: string, onUndo?: () => void, options?: ShowToastOptions) => {
      queueShowToast(message, onUndo, options);
    },
    [queueShowToast]
  );

  // 绑定全局命令式发射器
  globalShowToast = handleShowToast;
  globalDismissToast = dismissToast;

  const contextValue = useMemo<ToastContextValue>(
    () => ({
      showToast: handleShowToast,
      dismissToast,
      toasts,
    }),
    [handleShowToast, dismissToast, toasts]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
};

const fallbackToastContext: ToastContextValue = {
  showToast: (message, onUndo, options) => {
    toast.show(message, onUndo, options);
  },
  dismissToast: (id) => {
    toast.dismiss(id);
  },
  toasts: [],
};

/**
 * useToast() Hook
 * 导出 showToast, dismissToast, toasts 方法。
 * 当在未包裹 ToastProvider 的独立环境（如独立弹窗 Portal、微前端或测试沙箱）调用时，
 * 平滑降级为全局 fallback 单例，防止白屏崩溃。
 */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    if (import.meta.env?.DEV) {
      console.warn(
        '[useToast] useToast called outside ToastProvider, falling back to global singleton.'
      );
    }
    return fallbackToastContext;
  }
  return context;
}

export { ToastContext };
export type { AppToast, };
