import type * as React from 'react';

export type ToastType =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'recovery'
  | 'loading';

export type ToastPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type ToastPriority = 'polite' | 'assertive';

export interface ToastActionConfig {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}

export interface AppToast {
  id: string;
  type: ToastType;
  title?: React.ReactNode;
  message: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  duration?: number;
  ariaLive?: ToastPriority;
  action?: ToastActionConfig;
  onUndo?: () => void;
  onDismiss?: () => void;
  timestamp: number;
  updateKey?: number;
}

export interface ShowToastOptions {
  id?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  duration?: number;
  ttlMs?: number;
  maxQueue?: number;
  type?: ToastType;
  action?: ToastActionConfig;
  onUndo?: () => void;
  onDismiss?: () => void;
  position?: ToastPosition;
  progress?: boolean;
  ariaLive?: ToastPriority;
}

export interface PromiseToastMessages<T = unknown> {
  loading: React.ReactNode;
  success: React.ReactNode | ((data: T) => React.ReactNode);
  error: React.ReactNode | ((err: unknown) => React.ReactNode);
}

export interface ToastContextValue {
  show: {
    (message: React.ReactNode, options?: ShowToastOptions): string;
    (
      message: React.ReactNode,
      onUndo?: () => void,
      options?: ShowToastOptions
    ): string;
  };
  showToast: (
    message: string,
    onUndo?: () => void,
    options?: ShowToastOptions
  ) => void;
  success: {
    (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string;
    (
      message: React.ReactNode,
      onUndo?: () => void,
      options?: Omit<ShowToastOptions, 'type'>
    ): string;
  };
  error: {
    (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string;
    (
      message: React.ReactNode,
      onUndo?: () => void,
      options?: Omit<ShowToastOptions, 'type'>
    ): string;
  };
  warning: {
    (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string;
    (
      message: React.ReactNode,
      onUndo?: () => void,
      options?: Omit<ShowToastOptions, 'type'>
    ): string;
  };
  info: {
    (message: React.ReactNode, options?: Omit<ShowToastOptions, 'type'>): string;
    (
      message: React.ReactNode,
      onUndo?: () => void,
      options?: Omit<ShowToastOptions, 'type'>
    ): string;
  };
  loading: (
    message: React.ReactNode,
    options?: Omit<ShowToastOptions, 'type'>
  ) => string;
  promise: <T>(
    promise: Promise<T>,
    messages: PromiseToastMessages<T>,
    options?: ShowToastOptions
  ) => Promise<T>;
  dismiss: (id?: string) => void;
  dismissToast: (id: string) => void;
  toasts: readonly AppToast[];
}
