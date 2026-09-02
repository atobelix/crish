import React from 'react';
import { createPortal } from 'react-dom';
import type { AppToast, ToastPosition } from './types';
import { ToastViewport } from '../../components/overlay/ToastViewport';

export interface ToastContainerProps {
  toasts?: readonly AppToast[];
  onDismiss?: (id: string) => void;
  containerId?: string;
  position?: ToastPosition;
}

/**
 * ToastContainer: 负责将 ToastViewport 渲染并挂载至 index.html 的 #toast-root Portal 容器中。
 */
export const ToastContainer: React.FC<ToastContainerProps> = ({
  toasts,
  onDismiss,
  containerId = 'toast-root',
  position = 'bottom-right',
}) => {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById(containerId) ?? document.body;
  if (!root) return null;

  return createPortal(
    <ToastViewport
      toasts={toasts}
      onDismiss={onDismiss}
      position={position}
    />,
    root
  );
};
