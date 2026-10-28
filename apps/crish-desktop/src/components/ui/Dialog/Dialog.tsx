/**
 * ui/Dialog 弹窗基座与复合原语体系（原生 inert 模态栈与现代 Headless 架构）
 *
 * 方案依据:
 * - docs/frontend-systemic-refactor/plans/05-ui-primitives-and-headless-refactor.md §3.2 与 §4.2
 * - docs/frontend-systemic-refactor/01-前端系统性重构与架构根治总方案.md
 *
 * 核心架构进化:
 * 1. 单一真理底座: 全面接入 FocusTrap 原生 inert 模态栈中枢与 internal/modal.ts 正交分层模型；
 * 2. 彻底拔除 FocusTrap 白名单: 物理清退 35+ 选择器硬编码，由 HTML 原生 inert 属性接管焦点隔离；
 * 3. 根除 AST 探测与多程渲染: 淘汰 Children.toArray 动态探测与 registerTitle 状态倒灌，静态 Context 单程渲染；
 * 4. 纯 CSS 进出场与原生退场状态机: 基于 useAnimatedPresence (150ms) 与 data-dialog-state，出场平滑过渡后卸载；
 * 5. 复合组件（Compound Components）+ 平铺式兼容 API:
 *    Dialog.Root, Dialog.Trigger, Dialog.Portal, Dialog.Backdrop, Dialog.Viewport,
 *    Dialog.Content, Dialog.Title, Dialog.Description, Dialog.Close,
 *    Dialog.Header, Dialog.Body, Dialog.Footer, Dialog.Overlay
 */
import React, { useId, useRef, useState, useCallback } from 'react';
import { cn } from '../internal/cn';
import {
  useLayerRegistration,
  LayerProvider,
} from '../internal/layer-registration/useLayerRegistration';
import { useAnimatedPresence } from './useAnimatedPresence';
import {
  DialogContext,
  type DialogSize,
  type DialogRole,
  type DialogContextValue,
} from './dialogContext';
import {
  DialogPortal,
  DialogBackdrop,
  DialogViewport,
  DialogOverlay,
} from './DialogPortal';
import { DialogContent, DialogPopup } from './DialogContent';
import { DialogHeader } from './DialogHeader';
import { DialogTitle } from './DialogTitle';
import { DialogDescription } from './DialogDescription';
import { DialogBody } from './DialogBody';
import { DialogFooter } from './DialogFooter';
import { DialogClose } from './DialogClose';
import { DialogTrigger } from './DialogTrigger';

export interface DialogProps {
  /** 受控开关 */
  open?: boolean;
  /** 非受控默认开启 */
  defaultOpen?: boolean;
  /** 关闭回调（Esc/backdrop/关闭按钮统一归口） */
  onClose?: () => void;
  /** 开关状态变化回调 */
  onOpenChange?: (open: boolean) => void;
  /** 标题（aria-labelledby 关联；可传带图标的 ReactNode） */
  title?: React.ReactNode;
  /** 描述文案（aria-describedby 关联） */
  description?: React.ReactNode;
  /** 语义角色：alertdialog 供危险操作确认 */
  role?: DialogRole;
  /** 尺寸档（classNames.panel 可再以 --dialog-width / 自定尺寸覆盖） */
  size?: DialogSize;
  /** 初始聚焦元素；不传则聚焦弹窗内首个可交互元素 */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** 是否允许 Esc/backdrop 关闭（向导强制步进时置 false） */
  dismissible?: boolean;
  /**
   * 点击本弹窗自身遮罩是否关闭，默认随 dismissible。
   */
  closeOnBackdropClick?: boolean;
  /** 是否渲染头部关闭按钮 */
  showCloseButton?: boolean;
  /** 无 title 时的可访问名称（aria-label） */
  ariaLabel?: string;
  /** Portal 挂载目标；默认 document.body */
  portalTarget?: HTMLElement | null;
  /** 底部操作区 */
  footer?: React.ReactNode;
  /** 内容区 */
  children?: React.ReactNode;
  /**
   * 自定义类名收敛对象：
   * - panel 追加到弹窗面板
   * - overlay 追加到遮罩壳
   * - body 追加到内容区
   */
  classNames?: { panel?: string; overlay?: string; body?: string };
  /** 面板自定义类名快捷属性 */
  className?: string;
  /** 遮罩自定义类名快捷属性 */
  overlayClassName?: string;
  /**
   * LayerStack 到达本层时的 Esc 钩子。
   * 返回 true / preventDefault 则中枢不再走默认 dismiss。
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => boolean | void;
  /** 是否模态（锁定背景与焦点限制），默认 true */
  modal?: boolean | 'trap-focus';
}

/* -------------------------------------------------------------------------- */
/* 核心控制器与根组件: Dialog / Dialog.Root                                    */
/* -------------------------------------------------------------------------- */
export function Dialog({
  open = false,
  defaultOpen,
  onOpenChange,
  onClose,
  title,
  description,
  role = 'dialog',
  size = 'md',
  initialFocusRef,
  dismissible = true,
  closeOnBackdropClick = dismissible,
  showCloseButton = true,
  ariaLabel,
  portalTarget,
  footer,
  children,
  classNames,
  className,
  overlayClassName,
  onEscapeKeyDown,
  modal = true,
}: DialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    defaultOpen ?? false
  );
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;

  const handleClose = useCallback(() => {
    if (!isControlled) {
      setUncontrolledOpen(false);
    }
    onClose?.();
    onOpenChange?.(false);
  }, [isControlled, onClose, onOpenChange]);

  const { state, isMounted } = useAnimatedPresence({
    visible: Boolean(isOpen),
    exitDurationMs: 150,
  });

  const titleId = useId();
  const descriptionId = useId();
  const dialogId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [overlayEl, setOverlayEl] = useState<HTMLElement | null>(null);

  const mergedClassNames = {
    ...classNames,
    ...(className ? { panel: cn(classNames?.panel, className) } : {}),
    ...(overlayClassName
      ? { overlay: cn(classNames?.overlay, overlayClassName) }
      : {}),
  };

  useLayerRegistration(
    {
      id: dialogId,
      type: role === 'alertdialog' ? 'confirm-dialog' : 'modal-dialog',
      modal: Boolean(modal),
      dismissible,
      elementRef: panelRef,
      onDismiss: () => handleClose(),
      onEscapeKeyDown,
    },
    Boolean(isOpen)
  );

  const ctxValue: DialogContextValue = {
    open: Boolean(isOpen),
    state,
    isMounted,
    onClose: handleClose,
    titleId,
    descriptionId,
    role,
    size,
    dismissible,
    closeOnBackdropClick,
    showCloseButton,
    ariaLabel,
    panelRef,
    overlayEl,
    setOverlayEl,
    classNames: mergedClassNames,
    initialFocusRef,
    portalTarget,
    description,
  };

  if (!isMounted) {
    return null;
  }

  // 检测直接传入的复合原语
  const childrenArray = React.Children.toArray(children);
  const hasDirectOverlay = childrenArray.some(
    (c) =>
      React.isValidElement(c) &&
      (c.type === DialogOverlay || (c.type as any) === Dialog.Overlay)
  );
  const hasDirectContent = childrenArray.some(
    (c) =>
      React.isValidElement(c) &&
      (c.type === DialogContent || (c.type as any) === Dialog.Content)
  );
  const hasDirectPortal = childrenArray.some(
    (c) =>
      React.isValidElement(c) &&
      (c.type === DialogPortal || (c.type as any) === Dialog.Portal)
  );

  return (
    <LayerProvider layerId={dialogId} tier="modal">
      <DialogContext.Provider value={ctxValue}>
        {hasDirectPortal ? (
          children
        ) : (
          <DialogPortal container={portalTarget ?? undefined}>
            {hasDirectOverlay ? (
              children
            ) : hasDirectContent ? (
              <DialogOverlay>{children}</DialogOverlay>
            ) : (
              <DialogOverlay>
                <DialogContent>
                  {(title != null || (dismissible && showCloseButton)) && (
                    <DialogHeader>
                      {title != null && <DialogTitle>{title}</DialogTitle>}
                      {dismissible && showCloseButton && <DialogClose />}
                    </DialogHeader>
                  )}
                  {description != null && (
                    <DialogDescription>{description}</DialogDescription>
                  )}
                  <DialogBody>{children}</DialogBody>
                  {footer != null && <DialogFooter>{footer}</DialogFooter>}
                </DialogContent>
              </DialogOverlay>
            )}
          </DialogPortal>
        )}
      </DialogContext.Provider>
    </LayerProvider>
  );
}

// 复合原语绑定导出
Dialog.Root = Dialog;
Dialog.Trigger = DialogTrigger;
Dialog.Portal = DialogPortal;
Dialog.Backdrop = DialogBackdrop;
Dialog.Viewport = DialogViewport;
Dialog.Content = DialogContent;
Dialog.Popup = DialogPopup;
Dialog.Title = DialogTitle;
Dialog.Description = DialogDescription;
Dialog.Close = DialogClose;
Dialog.Header = DialogHeader;
Dialog.Body = DialogBody;
Dialog.Footer = DialogFooter;
Dialog.Overlay = DialogOverlay;

export const DialogRoot = Dialog;
export const StandardDialog = Dialog;

// 浮层层叠上下文导出，供局部提权消费
export { DialogOverlayContext } from './dialogOverlayContext';

// 导出所有子组件与类型契约（100% 向后兼容）
export {
  DialogContext,
  useDialogContext,
  type DialogSize,
  type DialogRole,
  type DialogContextValue,
} from './dialogContext';
export {
  DialogPortal,
  DialogBackdrop,
  DialogViewport,
  DialogOverlay,
  type DialogPortalProps,
  type DialogBackdropProps,
  type DialogViewportProps,
  type DialogOverlayProps,
} from './DialogPortal';
export {
  DialogContent,
  DialogPopup,
  type DialogContentProps,
} from './DialogContent';
export { DialogHeader, type DialogHeaderProps } from './DialogHeader';
export { DialogTitle, type DialogTitleProps } from './DialogTitle';
export {
  DialogDescription,
  type DialogDescriptionProps,
} from './DialogDescription';
export { DialogBody, type DialogBodyProps } from './DialogBody';
export { DialogFooter, type DialogFooterProps } from './DialogFooter';
export { DialogClose, type DialogCloseProps } from './DialogClose';
export { DialogTrigger, type DialogTriggerProps } from './DialogTrigger';
