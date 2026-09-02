import { useState, useRef, useCallback } from 'react';
import type { Point2D, UseSmartPanelReturn } from '../types';

export function useSmartPanel(defaultOpen = false): UseSmartPanelReturn {
  const [isOpen, setIsOpen] = useState<boolean>(defaultOpen);
  const [point, setPoint] = useState<Point2D | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const open = useCallback(() => {
    setPoint(null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setPoint(null);
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const openAtPoint = useCallback((pt: Point2D) => {
    setPoint(pt);
    setIsOpen(true);
  }, []);

  return {
    isOpen,
    triggerRef,
    anchorRef,
    open,
    close,
    toggle,
    openAtPoint,
    point,
    onOpenChange: setIsOpen,
    setOpen: setIsOpen,
  };
}
