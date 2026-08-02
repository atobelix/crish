import { eventBus } from './EventBus';
import type { UiError } from './ErrorStore';

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'recovery';
export type ToastPriority = 'polite' | 'assertive';

export interface ToastOptions {
  title?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  group?: string;
}

export interface AppToast {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  duration: number;
  ariaLive: ToastPriority;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  onUndo?: () => void;
  group?: string;
  timestamp: number;
}

export type Unsubscribe = () => void;

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  info: 5000,
  success: 3000,
  warning: 8000,
  error: 10000,
  recovery: 6000,
};

function resolveAriaLive(type: ToastType): ToastPriority {
  return type === 'error' || type === 'recovery' ? 'assertive' : 'polite';
}

function resolveDuration(type: ToastType, preferred?: number): number {
  if (preferred !== undefined && preferred > 0) return preferred;
  return DEFAULT_DURATIONS[type];
}

class ToastBus {
  private toasts: AppToast[] = [];
  private subscribers = new Set<(toasts: AppToast[]) => void>();
  private counter = 0;
  private maxVisible = 5;

  show(toast: Omit<AppToast, 'id' | 'timestamp'>): string;
  show(error: UiError): string;
  show(input: Omit<AppToast, 'id' | 'timestamp'> | UiError): string {
    if ('severity' in input && 'code' in input) {
      return this.showFromError(input);
    }
    const toast = input as Omit<AppToast, 'id' | 'timestamp'>;
    const id = `toast_${++this.counter}_${Date.now()}`;
    const timestamp = Date.now();

    const fullToast: AppToast = {
      ...toast,
      id,
      timestamp,
    };

    if (toast.group) {
      const existingIndex = this.toasts.findIndex((t) => t.group === toast.group);
      if (existingIndex !== -1) {
        // 治理防线 #3（noUncheckedIndexedAccess）：findIndex 命中后下标访问仍可能 undefined
        // 因 existingIndex !== -1 且 array 未被并发修改，此处赋值是安全的；
        // 但仍用显式守卫避免在 undefined 上写
        this.toasts[existingIndex] = fullToast;
        this.notify();
        return id;
      }
    }

    this.toasts.push(fullToast);

    if (this.toasts.length > this.maxVisible) {
      // shift() 在 length > 0 时返回 T，但 TS 在 noUncheckedIndexedAccess 下推断为 T | undefined
      // 这里 length > maxVisible >= 1，shift 必返回值；用守卫消除 !
      const removed = this.toasts.shift();
      if (removed) {
        removed.onDismiss?.();
      }
    }

    this.notify();
    return id;
  }

  info(message: string, options?: ToastOptions): string {
    // 治理防线 #2（exactOptionalPropertyTypes）：AppToast 中 title/action/onDismiss/group
    // 均为 `field?: T`，不接受 undefined 值；用条件展开剔除 undefined 键
    return this.show({
      type: 'info',
      message,
      ...(options?.title !== undefined ? { title: options.title } : {}),
      duration: resolveDuration('info', options?.duration),
      ariaLive: resolveAriaLive('info'),
      ...(options?.action !== undefined ? { action: options.action } : {}),
      ...(options?.onDismiss !== undefined ? { onDismiss: options.onDismiss } : {}),
      ...(options?.group !== undefined ? { group: options.group } : {}),
    });
  }

  success(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'success',
      message,
      ...(options?.title !== undefined ? { title: options.title } : {}),
      duration: resolveDuration('success', options?.duration),
      ariaLive: resolveAriaLive('success'),
      ...(options?.action !== undefined ? { action: options.action } : {}),
      ...(options?.onDismiss !== undefined ? { onDismiss: options.onDismiss } : {}),
      ...(options?.group !== undefined ? { group: options.group } : {}),
    });
  }

  warning(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'warning',
      message,
      ...(options?.title !== undefined ? { title: options.title } : {}),
      duration: resolveDuration('warning', options?.duration),
      ariaLive: resolveAriaLive('warning'),
      ...(options?.action !== undefined ? { action: options.action } : {}),
      ...(options?.onDismiss !== undefined ? { onDismiss: options.onDismiss } : {}),
      ...(options?.group !== undefined ? { group: options.group } : {}),
    });
  }

  error(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'error',
      message,
      ...(options?.title !== undefined ? { title: options.title } : {}),
      duration: resolveDuration('error', options?.duration),
      ariaLive: resolveAriaLive('error'),
      ...(options?.action !== undefined ? { action: options.action } : {}),
      ...(options?.onDismiss !== undefined ? { onDismiss: options.onDismiss } : {}),
      ...(options?.group !== undefined ? { group: options.group } : {}),
    });
  }

  recovery(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'recovery',
      message,
      ...(options?.title !== undefined ? { title: options.title } : {}),
      duration: resolveDuration('recovery', options?.duration),
      ariaLive: resolveAriaLive('recovery'),
      ...(options?.action !== undefined ? { action: options.action } : {}),
      ...(options?.onDismiss !== undefined ? { onDismiss: options.onDismiss } : {}),
      ...(options?.group !== undefined ? { group: options.group } : {}),
    });
  }

  dismiss(id: string): void {
    const index = this.toasts.findIndex((t) => t.id === id);
    if (index !== -1) {
      // splice 返回数组；用解构 + 守卫消除 [0]! 非空断言
      const [removed] = this.toasts.splice(index, 1);
      if (removed) {
        removed.onDismiss?.();
      }
      this.notify();
    }
  }

  dismissAll(): void {
    const oldToasts = this.toasts;
    this.toasts = [];
    for (const t of oldToasts) {
      t.onDismiss?.();
    }
    this.notify();
  }

  subscribe(callback: (toasts: AppToast[]) => void): Unsubscribe {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  getToasts(): AppToast[] {
    return [...this.toasts];
  }

  private showFromError(error: UiError): string {
    const typeMap: Record<string, ToastType> = {
      info: 'info',
      warning: 'warning',
      error: 'error',
      critical: 'error',
    };
    const toastType = typeMap[error.severity] || 'warning';
    return this.show({
      type: toastType,
      message: error.message,
      title: error.code,
      duration: DEFAULT_DURATIONS[toastType],
      ariaLive: resolveAriaLive(toastType),
    });
  }

  private notify(): void {
    const snapshot = [...this.toasts];
    for (const cb of this.subscribers) {
      cb(snapshot);
    }
  }
}

export const toastBus = new ToastBus();

eventBus.on('toast:show', (payload: unknown) => {
  if (payload && typeof payload === 'object' && 'severity' in payload && 'code' in payload) {
    toastBus.show(payload as UiError);
  }
});
