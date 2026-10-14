import type * as React from 'react';
import type { CrishError } from '@crish/shared-types';
import type {
  AppToast,
  ShowToastOptions,
  PromiseToastMessages,
  ToastType,
  ToastPriority,
} from './types';
import {
  enqueueToast,
  removeToastById,
  TOAST_TTL_MS,
  TOAST_MAX_QUEUE,
  createToastId,
} from '../../hooks/toastQueueLogic';
import {
  normalizeCrishError,
  toUserVisibleError,
  type UserVisibleError,
} from '../../utils/error-translation';

type Listener = () => void;

function isUserVisibleError(error: unknown): error is UserVisibleError {
  if (typeof error !== 'object' || error === null) return false;
  const obj = error as Record<string, unknown>;
  return (
    typeof obj.visible === 'boolean' &&
    typeof obj.title === 'string' &&
    typeof obj.message === 'string' &&
    typeof obj.severity === 'string' &&
    typeof obj.code === 'string'
  );
}

function isCrishErrorPayload(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const obj = error as Record<string, unknown>;
  return typeof obj.code === 'string' && typeof obj.category === 'string';
}

export class ToastStoreImpl {
  private toasts: AppToast[] = [];
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getToasts = (): readonly AppToast[] => {
    return this.toasts;
  };

  show = (
    message: React.ReactNode | CrishError | UserVisibleError | unknown,
    arg2?: (() => void) | ShowToastOptions,
    arg3?: ShowToastOptions
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: ShowToastOptions | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    if (
      isUserVisibleError(message) ||
      message instanceof Error ||
      isCrishErrorPayload(message)
    ) {
      return this.showError(message, { ...options, onUndo });
    }

    const textMessage = typeof message === 'string' ? message : '';
    const id = options?.id ?? createToastId();
    const duration =
      options?.duration ??
      options?.ttlMs ??
      (options?.type === 'loading' ? Infinity : TOAST_TTL_MS);

    const resolvedType: ToastType = options?.type ?? 'info';
    const resolvedAriaLive: ToastPriority =
      options?.ariaLive ?? (resolvedType === 'error' ? 'assertive' : 'polite');

    const newToast: AppToast = {
      id,
      type: resolvedType,
      title: options?.title,
      message: message as React.ReactNode,
      description: options?.description,
      icon: options?.icon,
      duration,
      ariaLive: resolvedAriaLive,
      action: options?.action,
      onUndo,
      onDismiss: options?.onDismiss,
      timestamp: Date.now(),
      updateKey: Date.now(),
    };

    return this.commitToast(newToast, textMessage, onUndo, options);
  };

  showError = (
    error: CrishError | UserVisibleError | Error | string | unknown,
    options?: ShowToastOptions
  ): string => {
    let visibleError: UserVisibleError;

    if (isUserVisibleError(error)) {
      visibleError = error;
    } else {
      const payload = normalizeCrishError(error);
      visibleError = toUserVisibleError(payload);
    }

    const id = options?.id ?? createToastId();

    if (!visibleError.visible || visibleError.severity === 'silent') {
      return id;
    }

    const resolvedType: ToastType =
      options?.type ??
      (visibleError.severity === 'warning'
        ? 'warning'
        : visibleError.severity === 'info'
          ? 'info'
          : 'error');

    const resolvedAriaLive: ToastPriority =
      options?.ariaLive ?? (resolvedType === 'error' ? 'assertive' : 'polite');

    const duration =
      options?.duration ??
      options?.ttlMs ??
      (resolvedType === 'loading' ? Infinity : TOAST_TTL_MS);

    const title = options?.title ?? (visibleError.title || undefined);
    const message = visibleError.message;
    const description =
      options?.description ??
      (visibleError.action ? visibleError.action : undefined);
    const onUndo = options?.onUndo;

    const newToast: AppToast = {
      id,
      type: resolvedType,
      title,
      message,
      description,
      icon: options?.icon,
      duration,
      ariaLive: resolvedAriaLive,
      action: options?.action,
      onUndo,
      onDismiss: options?.onDismiss,
      timestamp: Date.now(),
      updateKey: Date.now(),
    };

    return this.commitToast(newToast, message, onUndo, options);
  };

  success = (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: Omit<ShowToastOptions, 'type'> | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    return this.show(message, onUndo, { ...options, type: 'success' });
  };

  error: {
    (
      errorOrMessage: CrishError | UserVisibleError | Error | React.ReactNode,
      options?: Omit<ShowToastOptions, 'type'>
    ): string;
    (
      errorOrMessage: CrishError | UserVisibleError | Error | React.ReactNode,
      onUndo?: () => void,
      options?: Omit<ShowToastOptions, 'type'>
    ): string;
  } = (
    errorOrMessage: unknown,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: Omit<ShowToastOptions, 'type'> | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    if (
      isUserVisibleError(errorOrMessage) ||
      errorOrMessage instanceof Error ||
      isCrishErrorPayload(errorOrMessage)
    ) {
      return this.showError(errorOrMessage, { ...options, onUndo });
    }

    return this.show(errorOrMessage as React.ReactNode, onUndo, {
      ...options,
      type: 'error',
    });
  };

  warning = (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: Omit<ShowToastOptions, 'type'> | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    return this.show(message, onUndo, { ...options, type: 'warning' });
  };

  info = (
    message: React.ReactNode,
    arg2?: (() => void) | Omit<ShowToastOptions, 'type'>,
    arg3?: Omit<ShowToastOptions, 'type'>
  ): string => {
    let onUndo: (() => void) | undefined;
    let options: Omit<ShowToastOptions, 'type'> | undefined;

    if (typeof arg2 === 'function') {
      onUndo = arg2;
      options = arg3;
    } else if (typeof arg2 === 'object' && arg2 !== null) {
      options = arg2;
      onUndo = options.onUndo;
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      options = arg3;
      onUndo = options.onUndo;
    }

    return this.show(message, onUndo, { ...options, type: 'info' });
  };

  loading = (
    message: React.ReactNode,
    options?: Omit<ShowToastOptions, 'type'>
  ): string => {
    return this.show(message, {
      ...options,
      type: 'loading',
      duration: Infinity,
    });
  };

  promise = async <T>(
    promise: Promise<T>,
    messages: PromiseToastMessages<T>,
    options?: ShowToastOptions
  ): Promise<T> => {
    const id = options?.id ?? createToastId();
    this.show(messages.loading, {
      ...options,
      id,
      type: 'loading',
      duration: Infinity,
    });

    try {
      const data = await promise;
      const successMsg =
        typeof messages.success === 'function'
          ? messages.success(data)
          : messages.success;
      this.show(successMsg, {
        ...options,
        id,
        type: 'success',
        duration: options?.duration ?? options?.ttlMs ?? TOAST_TTL_MS,
      });
      return data;
    } catch (err) {
      const errorMsg =
        typeof messages.error === 'function'
          ? messages.error(err)
          : messages.error;
      this.show(errorMsg, {
        ...options,
        id,
        type: 'error',
        duration: options?.duration ?? options?.ttlMs ?? TOAST_TTL_MS,
      });
      throw err;
    }
  };

  dismiss = (id?: string): void => {
    if (!id) {
      for (const t of this.toasts) {
        t.onDismiss?.();
      }
      this.toasts = [];
    } else {
      const target = this.toasts.find((t) => t.id === id);
      if (target) {
        target.onDismiss?.();
      }
      this.toasts = removeToastById(this.toasts as any, id) as AppToast[];
    }
    this.notify();
  };

  clear = (): void => {
    this.dismiss();
  };

  private commitToast(
    toast: AppToast,
    textMessage: string,
    onUndo: (() => void) | undefined,
    options?: ShowToastOptions
  ): string {
    const queueOldestFirst = this.toasts.slice().reverse();
    const result = enqueueToast(queueOldestFirst as any, textMessage, onUndo, {
      id: toast.id,
      ttlMs: toast.duration,
      maxQueue: options?.maxQueue,
      type: options?.type as any,
    });

    if (result.kind === 'drop') {
      return toast.id;
    }

    if (result.kind === 'dedupe') {
      this.toasts = this.toasts.map((t) =>
        t.id === result.existingId
          ? {
              ...t,
              ...toast,
              id: t.id,
              onUndo: onUndo ?? t.onUndo,
              updateKey: Date.now(),
            }
          : t
      );
    } else {
      const maxQueue = options?.maxQueue ?? TOAST_MAX_QUEUE;
      const filtered = this.toasts.filter(
        (t) => t.id !== toast.id && !result.evictedIds.includes(t.id)
      );
      this.toasts = [toast, ...filtered].slice(0, maxQueue);
    }

    this.notify();
    return toast.id;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[ToastStore] Listener error:', err);
      }
    }
  }
}

export const ToastStore = new ToastStoreImpl();
