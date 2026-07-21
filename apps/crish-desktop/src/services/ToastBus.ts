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
        this.toasts[existingIndex] = fullToast;
        this.notify();
        return id;
      }
    }

    this.toasts.push(fullToast);

    if (this.toasts.length > this.maxVisible) {
      const removed = this.toasts.shift()!;
      removed.onDismiss?.();
    }

    this.notify();
    return id;
  }

  info(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'info',
      message,
      title: options?.title,
      duration: resolveDuration('info', options?.duration),
      ariaLive: resolveAriaLive('info'),
      action: options?.action,
      onDismiss: options?.onDismiss,
      group: options?.group,
    });
  }

  success(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'success',
      message,
      title: options?.title,
      duration: resolveDuration('success', options?.duration),
      ariaLive: resolveAriaLive('success'),
      action: options?.action,
      onDismiss: options?.onDismiss,
      group: options?.group,
    });
  }

  warning(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'warning',
      message,
      title: options?.title,
      duration: resolveDuration('warning', options?.duration),
      ariaLive: resolveAriaLive('warning'),
      action: options?.action,
      onDismiss: options?.onDismiss,
      group: options?.group,
    });
  }

  error(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'error',
      message,
      title: options?.title,
      duration: resolveDuration('error', options?.duration),
      ariaLive: resolveAriaLive('error'),
      action: options?.action,
      onDismiss: options?.onDismiss,
      group: options?.group,
    });
  }

  recovery(message: string, options?: ToastOptions): string {
    return this.show({
      type: 'recovery',
      message,
      title: options?.title,
      duration: resolveDuration('recovery', options?.duration),
      ariaLive: resolveAriaLive('recovery'),
      action: options?.action,
      onDismiss: options?.onDismiss,
      group: options?.group,
    });
  }

  dismiss(id: string): void {
    const index = this.toasts.findIndex((t) => t.id === id);
    if (index !== -1) {
      const removed = this.toasts.splice(index, 1)[0];
      removed.onDismiss?.();
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

eventBus.on('toast:show', (payload: any) => {
  if (payload && typeof payload === 'object' && 'severity' in payload && 'code' in payload) {
    toastBus.show(payload as UiError);
  }
});
