/**
 * apps/crish-desktop/src/components/ui/PreviewCard/types.ts
 * PreviewCard 核心类型契约
 */
import type React from 'react';

export type PreviewCardSide = 'top' | 'bottom' | 'left' | 'right';
export type PreviewCardAlign = 'start' | 'center' | 'end';

export interface PreviewCardPositionResult {
  top: number;
  left: number;
  effectiveSide: PreviewCardSide;
  arrowOffset: number;
}

export interface PreviewCardContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  triggerRect: DOMRect | null;
  setTriggerRect: (rect: DOMRect | null) => void;
  triggerEl: HTMLElement | null;
  setTriggerEl: (el: HTMLElement | null) => void;
  contentEl: HTMLElement | null;
  setContentEl: (el: HTMLElement | null) => void;
  side: PreviewCardSide;
  effectiveSide: PreviewCardSide;
  setEffectiveSide: (side: PreviewCardSide) => void;
  align: PreviewCardAlign;
  sideOffset: number;
  alignOffset: number;
  arrow: boolean;
  delayShow: number;
  delayHide: number;
  disabled: boolean;
  cardId: string;
  arrowOffset: number;
  setArrowOffset: (offset: number) => void;
}

export interface PreviewCardProps {
  children: React.ReactNode;
  side?: PreviewCardSide;
  align?: PreviewCardAlign;
  sideOffset?: number;
  alignOffset?: number;
  arrow?: boolean;
  delayShow?: number;
  delayHide?: number;
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface PreviewCardTriggerProps
  extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactElement;
  asChild?: boolean;
}

export interface PreviewCardContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  className?: string;
  style?: React.CSSProperties;
  /** 是否挂载到指定 container DOM 节点，默认 document.body */
  container?: HTMLElement | null;
}

export interface PreviewCardTitleProps
  extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
}

export interface PreviewCardDescriptionProps
  extends React.HTMLAttributes<HTMLParagraphElement> {
  children: React.ReactNode;
}

export interface PreviewCardArrowProps
  extends React.HTMLAttributes<HTMLDivElement> {
  side: PreviewCardSide;
  offset?: number;
  className?: string;
  style?: React.CSSProperties;
}
