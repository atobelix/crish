/**
 * apps/crish-desktop/src/components/ui/Dialog/index.ts
 * 对话框原子设计单元统一导出
 */
export {
  Dialog,
  DialogRoot,
  StandardDialog,
  DialogPortal,
  DialogBackdrop,
  DialogViewport,
  DialogOverlay,
  DialogContent,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogClose,
  DialogTrigger,
  DialogContext,
  useDialogContext,
} from './Dialog';
export type {
  DialogProps,
  DialogSize,
  DialogRole,
  DialogPortalProps,
  DialogBackdropProps,
  DialogViewportProps,
  DialogOverlayProps,
  DialogContentProps,
  DialogTitleProps,
  DialogDescriptionProps,
  DialogBodyProps,
  DialogFooterProps,
  DialogCloseProps,
  DialogTriggerProps,
  DialogContextValue,
} from './Dialog';

export {
  DialogOverlayContext,
  useDialogOverlayContext,
} from './dialogOverlayContext';

export {
  useAnimatedPresence,
  type UseAnimatedPresenceOptions as AnimatedPresenceOptions,
} from './useAnimatedPresence';
