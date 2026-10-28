/**
 * ui/Popover 浮层弹出原语（现代化 Headless 基座）
 *
 * 方案依据: docs/ui-infra-evolution/plans/03-headless-primitives-and-stability.md §2.3-2.4
 * 底层原语: @base-ui/react/popover
 * 浮层规范: 接入 ui/internal/floating.ts 统一浮层定位与 z-index 体系
 *
 * 核心设计：
 * 1. 纯声明式 React 19 拓扑，完全淘汰命令式 DOM 强拆与手写坐标解算；
 * 2. 物理支持复合组件模式（Popover.Root, Popover.Trigger, Popover.Portal, Popover.Positioner, Popover.Popup...）；
 * 3. 兼具极简平铺 Props 高级封装模式（<Popover trigger={...} content={...}>）；
 * 4. CSS @starting-style 驱动硬件加速进出场动效；
 * 5. 样式包裹在 @layer components 中，SSOT Tokens 严格对齐，视觉零变化。
 */

import React, { useState, useId, useRef } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { splitFloatingProps } from '../internal/floating';
import {
  useLayerRegistration,
  LayerProvider,
  useLayerContext,
} from '../internal/layer-registration/useLayerRegistration';
import styles from './Popover.module.css';

export interface PopoverProps {
  /** 受控开关 */
  open?: boolean;
  /** 默认非受控开关 */
  defaultOpen?: boolean;
  /** 开关状态变化回调 */
  onOpenChange?: (
    open: boolean,
    eventDetails?: { reason?: string; event?: Event }
  ) => void;
  /** 触发器元素 */
  trigger?: React.ReactNode;
  /** 显式锚点（RefObject 或 Element） */
  anchor?: React.RefObject<Element | null> | Element | null;
  /** 弹出内容区（content 或 children 任一即可） */
  content?: React.ReactNode;
  /** 弹出子内容 */
  children?: React.ReactNode;
  /** 弹出方向 */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** 对齐方式 */
  align?: 'start' | 'center' | 'end';
  /** 侧边偏移量 (px) */
  sideOffset?: number;
  /** 对齐偏移量 (px) */
  alignOffset?: number;
  /** Popup 自定义类名 */
  className?: string;
  /** Positioner 自定义类名 */
  positionerClassName?: string;
  /** Portal 挂载目标容器 */
  portalContainer?: HTMLElement | null;
  /** 是否进入模态隔离状态（默认 false，允许与外部交互） */
  modal?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 点击外部回调 */
  onInteractOutside?: (event: Event) => void;
  /** 按下 Esc 回调 */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** 是否渲染指示箭头 */
  showArrow?: boolean;
}

interface PopoverComponent extends React.FC<PopoverProps> {
  Root: typeof BasePopover.Root;
  Trigger: typeof BasePopover.Trigger;
  Portal: typeof BasePopover.Portal;
  Positioner: typeof BasePopover.Positioner;
  Popup: typeof BasePopover.Popup;
  Arrow: typeof BasePopover.Arrow;
  Backdrop: typeof BasePopover.Backdrop;
  Title: typeof BasePopover.Title;
  Description: typeof BasePopover.Description;
  Close: typeof BasePopover.Close;
  Viewport: typeof BasePopover.Viewport;
}

export const Popover: PopoverComponent = Object.assign(
  function Popover({
    open: externalOpen,
    defaultOpen = false,
    onOpenChange: externalOnOpenChange,
    trigger,
    anchor,
    content,
    children,
    side = 'bottom',
    align = 'center',
    sideOffset = 6,
    alignOffset = 0,
    className,
    positionerClassName,
    portalContainer,
    modal = false,
    disabled = false,
    onInteractOutside,
    onEscapeKeyDown,
    showArrow = false,
    ...restProps
  }: PopoverProps) {
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const isControlled = externalOpen !== undefined;
    const isOpen = isControlled ? externalOpen : internalOpen;

    const handleOpenChange = (
      nextOpen: boolean,
      eventDetails?: { reason?: string; event?: Event }
    ) => {
      if (disabled && nextOpen) return;
      if (!nextOpen) {
        if (eventDetails?.reason === 'escape-key') {
          onEscapeKeyDown?.(eventDetails.event as KeyboardEvent);
        } else if (eventDetails?.reason === 'outside-press') {
          onInteractOutside?.(eventDetails.event as Event);
        }
      }
      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      externalOnOpenChange?.(nextOpen, eventDetails);
    };

    const popoverId = useId();
    const parentLayer = useLayerContext();
    const popupRef = useRef<HTMLDivElement | null>(null);

    useLayerRegistration(
      {
        id: popoverId,
        type: 'popover',
        parentId: parentLayer.layerId ?? undefined,
        dismissible: true,
        modal,
        elementRef: popupRef,
        onDismiss: (reason) => {
          if (reason === 'escape') {
            handleOpenChange(false, {
              reason: 'escape-key',
              event: new KeyboardEvent('keydown', { key: 'Escape' }),
            });
          } else if (reason === 'outside-pointer') {
            handleOpenChange(false, {
              reason: 'outside-press',
              event: new PointerEvent('pointerdown'),
            });
          } else {
            handleOpenChange(false);
          }
        },
        onEscapeKeyDown: (event) => {
          onEscapeKeyDown?.(event);
        },
      },
      Boolean(isOpen)
    );

    const { positioner: extraPos, popup: extraPopup } = splitFloatingProps(
      restProps as Record<string, unknown>
    );

    let renderedTrigger: React.ReactNode = null;
    if (trigger) {
      if (React.isValidElement(trigger)) {
        renderedTrigger = (
          <BasePopover.Trigger render={trigger as React.ReactElement} />
        );
      } else {
        renderedTrigger = <BasePopover.Trigger>{trigger}</BasePopover.Trigger>;
      }
    }

    const popupContent = content ?? children;

    if (anchor && !isOpen) {
      return null;
    }

    return (
      <BasePopover.Root
        open={isOpen}
        onOpenChange={handleOpenChange}
        modal={modal}
      >
        {renderedTrigger}
        <BasePopover.Portal container={portalContainer ?? undefined}>
          <BasePopover.Positioner
            side={side}
            align={align}
            sideOffset={sideOffset}
            alignOffset={alignOffset}
            anchor={anchor}
            className={`${styles.positioner} ${positionerClassName || ''}`.trim()}
            {...extraPos}
          >
            <BasePopover.Popup
              ref={popupRef}
              className={`${styles.popup} ${className || ''}`.trim()}
              {...extraPopup}
            >
              {showArrow && <BasePopover.Arrow className={styles.arrow} />}
              <LayerProvider layerId={popoverId} tier="popover">
                {popupContent}
              </LayerProvider>
            </BasePopover.Popup>
          </BasePopover.Positioner>
        </BasePopover.Portal>
      </BasePopover.Root>
    );
  },
  {
    Root: BasePopover.Root,
    Trigger: BasePopover.Trigger,
    Portal: BasePopover.Portal,
    Positioner: BasePopover.Positioner,
    Popup: BasePopover.Popup,
    Arrow: BasePopover.Arrow,
    Backdrop: BasePopover.Backdrop,
    Title: BasePopover.Title,
    Description: BasePopover.Description,
    Close: BasePopover.Close,
    Viewport: BasePopover.Viewport,
  }
);
