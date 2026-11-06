import {
  createContext,
  useContext,
  type ReactNode,
  type RefObject,
} from 'react';
import type { TransitionState } from './useAnimatedPresence';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'auto';
export type DialogRole = 'dialog' | 'alertdialog';

/**
 * G² 形状层表面规格（DialogContent 的 G2Surface 接入通道）：面板轮廓统一由
 * 基座以 modal 档（名义半径 20）生成，本规格只声明逐面色值——fill 面板底色、
 * stroke 同路径描边色。不传的字段取基座默认：fill --surface-overlay、
 * stroke --border-panel。阴影通常不走本规格：阴影 token 随主题分叉（如
 * --shadow-2xl 浅/暗两套值），形状层 filter 由 CSS 规则承载——基座近似在
 * Dialog.module.css 的 [data-g2-layer] 规则、逐面覆盖在各面模块同名规则。
 * 唯一例外 shadow='none'：用户点名去阴影的面（如删除对话确认面板，
 * 2026-11-06）经此通道声明，DialogContent 在面板落 data-surface-shadow，
 * 基座以更高特异性规则整体关掉形状层 filter（去掉，不是调淡）。
 */
export interface DialogSurfaceSpec {
  fill?: string;
  stroke?: string;
  shadow?: 'default' | 'none';
}

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
  surface?: DialogSurfaceSpec;
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
