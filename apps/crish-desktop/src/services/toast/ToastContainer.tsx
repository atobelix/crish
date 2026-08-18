import React from 'react';
import { createPortal } from 'react-dom';
import type { AppToast } from '../../hooks/useToastQueue';
import { ToastStack } from '../../components/overlay/ToastStack';

export interface ToastContainerProps {
  toasts: readonly AppToast[];
  onDismiss: (id: string) => void;
  containerId?: string;
}

/**
 * ToastContainer: 负责将 ToastStack 渲染并挂载至 index.html 的 #toast-root Portal 容器中。
 */
export const ToastContainer: React.FC<ToastContainerProps> = ({
  toasts,
  onDismiss,
  containerId = 'toast-root',
}) => {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById(containerId) ?? document.body;
  if (!root) return null;

  return createPortal(
    <ToastStack toasts={toasts as AppToast[]} onDismiss={onDismiss} />,
    root
  );
};
