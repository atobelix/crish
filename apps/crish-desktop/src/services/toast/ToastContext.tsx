import React, {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useSyncExternalStore,
} from 'react';
import type {
  AppToast,
  ShowToastOptions,
  ToastContextValue,
} from './types';
import { ToastStore } from './ToastStore';
import { toast } from './toast';
import { ToastContainer } from './ToastContainer';

export const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  children: React.ReactNode;
  containerId?: string;
  position?:
    | 'bottom-right'
    | 'bottom-center'
    | 'bottom-left'
    | 'top-right'
    | 'top-center'
    | 'top-left';
}

/**
 * 全局 ToastProvider 单例容器
 */
export const ToastProvider: React.FC<ToastProviderProps> = ({
  children,
  containerId = 'toast-root',
  // 单轨收敛（docs/chat-notice-convergence Step 1）：全局通知默认顶部居中
  position = 'top-center',
}) => {
  const toasts = useSyncExternalStore(
    ToastStore.subscribe,
    ToastStore.getToasts,
    ToastStore.getToasts
  );

  const handleShowToast = useCallback(
    (message: string, onUndo?: () => void, options?: ShowToastOptions) => {
      ToastStore.show(message, onUndo, options);
    },
    []
  );

  const handleDismissToast = useCallback((id: string) => {
    ToastStore.dismiss(id);
  }, []);

  const contextValue = useMemo<ToastContextValue>(
    () => ({
      show: ToastStore.show as any,
      showToast: handleShowToast,
      success: ToastStore.success as any,
      error: ToastStore.error as any,
      warning: ToastStore.warning as any,
      info: ToastStore.info as any,
      loading: ToastStore.loading,
      promise: ToastStore.promise,
      dismiss: ToastStore.dismiss,
      dismissToast: handleDismissToast,
      toasts,
    }),
    [handleShowToast, handleDismissToast, toasts]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer
        toasts={toasts}
        onDismiss={handleDismissToast}
        containerId={containerId}
        position={position}
      />
    </ToastContext.Provider>
  );
};

const fallbackToastContext: ToastContextValue = {
  show: ToastStore.show as any,
  showToast: (message, onUndo, options) => {
    ToastStore.show(message, onUndo, options);
  },
  success: ToastStore.success as any,
  error: ToastStore.error as any,
  warning: ToastStore.warning as any,
  info: ToastStore.info as any,
  loading: ToastStore.loading,
  promise: ToastStore.promise,
  dismiss: ToastStore.dismiss,
  dismissToast: (id) => {
    ToastStore.dismiss(id);
  },
  toasts: [],
};

/**
 * useToast() Hook
 * 导出 show, showToast, success, error, warning, info, loading, promise, dismiss, dismissToast, toasts 方法。
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

export { toast };
export type { AppToast, ShowToastOptions, ToastContextValue };
