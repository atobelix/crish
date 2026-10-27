/**
 * apps/crish-desktop/src/components/ui/ContextMenu/ContextMenuContext.tsx
 *
 * ContextMenu 上下文共享层：无缝串联根菜单、子菜单、条目高亮与单选组
 */

import React, { createContext, useContext } from 'react';
import type {
  VirtualPoint,
  PositionerAnchor,
} from '../internal/positioner/types';
import type { ContextMenuSize } from './types';

export interface ContextMenuRootContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  anchor: PositionerAnchor | null;
  setAnchor: (point: VirtualPoint | null) => void;
  size: ContextMenuSize;
  modal: boolean;
  closeMenu: () => void;
  registerFloatingLayer: (el: HTMLElement) => () => void;
  isInsideFloatingLayers: (target: EventTarget | null) => boolean;
}

export const ContextMenuRootContext =
  createContext<ContextMenuRootContextValue | null>(null);

export function useContextMenuRoot(): ContextMenuRootContextValue {
  const ctx = useContext(ContextMenuRootContext);
  if (!ctx) {
    throw new Error(
      'ContextMenu subcomponents must be used within a <ContextMenu> root component.'
    );
  }
  return ctx;
}

export interface ContextMenuLayerContextValue {
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
  registerSubmenuHandler?: (
    triggerId: string,
    handlers: {
      expand: () => void;
      collapse: () => void;
    }
  ) => () => void;
  getSubmenuHandlers?: (
    triggerId: string
  ) => { expand: () => void; collapse: () => void } | undefined;
}

export const ContextMenuLayerContext =
  createContext<ContextMenuLayerContextValue | null>(null);

export function useContextMenuLayer(): ContextMenuLayerContextValue | null {
  return useContext(ContextMenuLayerContext);
}

export interface ContextMenuSubContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  openSubmenu: () => void;
  closeSubmenu: (delayMs?: number) => void;
}

export const ContextMenuSubContext =
  createContext<ContextMenuSubContextValue | null>(null);

export function useContextMenuSub(): ContextMenuSubContextValue | null {
  return useContext(ContextMenuSubContext);
}

export interface ContextMenuRadioGroupContextValue {
  value?: string;
  onValueChange?: (val: string) => void;
}

export const ContextMenuRadioGroupContext =
  createContext<ContextMenuRadioGroupContextValue | null>(null);

export function useContextMenuRadioGroup(): ContextMenuRadioGroupContextValue | null {
  return useContext(ContextMenuRadioGroupContext);
}
