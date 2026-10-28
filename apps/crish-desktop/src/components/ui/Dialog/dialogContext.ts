import {
  createContext,
  useContext,
  type ReactNode,
  type RefObject,
} from 'react';
import type { TransitionState } from './useAnimatedPresence';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'auto';
export type DialogRole = 'dialog' | 'alertdialog';

export interface DialogContextValue {
  open: boolean;
  state: TransitionState;
  isMounted: boolean;
  onClose: () => void;
  titleId: string;
  descriptionId: string;
  role: DialogRole;
  size: DialogSize;
  dismissible: boolean;
  closeOnBackdropClick: boolean;
  showCloseButton: boolean;
  ariaLabel?: string;
  panelRef: RefObject<HTMLDivElement | null>;
  overlayEl: HTMLElement | null;
  setOverlayEl: (node: HTMLElement | null) => void;
  classNames?: { panel?: string; overlay?: string; body?: string };
  initialFocusRef?: RefObject<HTMLElement | null>;
  portalTarget?: HTMLElement | null;
  description?: ReactNode;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialogContext(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error(
      '<Dialog.*> compound components must be rendered within a <Dialog> or <Dialog.Root>.'
    );
  }
  return ctx;
}
