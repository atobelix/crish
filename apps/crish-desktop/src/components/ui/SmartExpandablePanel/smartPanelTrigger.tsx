import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Tooltip } from '../Tooltip/Tooltip';

type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface SmartPanelTriggerOptions {
  trigger: React.ReactNode;
  anchor: React.RefObject<HTMLElement | null> | undefined;
  /** 记录真实触发元素（外部点击判定 / 层栈锚点）；原 ref 仍会被转发。 */
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  isOpen: boolean;
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => void;
  /** 点击触发器时先于原 onClick 执行（清理悬停计时器）。 */
  onClickCapture: () => void;
}

/**
 * 渲染 SmartExpandablePanel 的触发器：
 * - 有 anchor 时只放虚拟锚点；
 * - trigger 若是 Tooltip 包裹的元素，拆出 tooltip 内容并在面板打开时禁用 tooltip；
 * - 克隆真实触发元素，合并 ref 与 mouseenter/mouseleave/click 处理器后交给 Popover.Trigger。
 */
export function renderSmartPanelTrigger({
  trigger,
  anchor,
  triggerRef,
  isOpen,
  onMouseEnter: handleTriggerMouseEnter,
  onMouseLeave: handleTriggerMouseLeave,
  onClickCapture: clearHoverTimers,
}: SmartPanelTriggerOptions): React.ReactNode {
  let renderedTrigger: React.ReactNode = null;
  if (anchor) {
    renderedTrigger = <Popover.Anchor virtualRef={anchor} />;
  } else if (trigger) {
    let actualTrigger: React.ReactNode = trigger;
    let tipContent: React.ReactNode = null;
    let tipSide: TooltipSide = 'bottom';

    if (
      React.isValidElement(trigger) &&
      typeof trigger.type !== 'string' &&
      'content' in (trigger.props as Record<string, unknown>) &&
      'children' in (trigger.props as Record<string, unknown>)
    ) {
      const p = trigger.props as {
        content?: React.ReactNode;
        side?: TooltipSide;
        children?: React.ReactNode;
      };
      tipContent = p.content ?? null;
      tipSide = p.side || 'bottom';
      actualTrigger = p.children ?? trigger;
    }

    if (React.isValidElement(actualTrigger)) {
      const actualTriggerElement = actualTrigger as React.ReactElement<{
        ref?: unknown;
        onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
        onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
        onClick?: (e: React.MouseEvent<HTMLElement>) => void;
      }>;
      const originalProps = actualTriggerElement.props;

      const clonedElement = React.cloneElement(actualTriggerElement, {
        ref: (node: HTMLElement | null) => {
          triggerRef.current = node;
          const origRef = (
            actualTriggerElement as unknown as { ref?: React.Ref<HTMLElement> }
          ).ref;
          if (typeof origRef === 'function') {
            origRef(node);
          } else if (
            origRef &&
            typeof origRef === 'object' &&
            'current' in origRef
          ) {
            (origRef as React.MutableRefObject<HTMLElement | null>).current =
              node;
          }
        },
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
          originalProps?.onMouseEnter?.(e);
          handleTriggerMouseEnter(e);
        },
        onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
          originalProps?.onMouseLeave?.(e);
          handleTriggerMouseLeave(e);
        },
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          clearHoverTimers();
          originalProps?.onClick?.(e);
        },
      } as React.Attributes & {
        ref: (node: HTMLElement | null) => void;
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
        onMouseLeave: (e: React.MouseEvent<HTMLElement>) => void;
        onClick: (e: React.MouseEvent<HTMLElement>) => void;
      });

      const triggerElem = (
        <Popover.Trigger asChild>{clonedElement}</Popover.Trigger>
      );

      renderedTrigger =
        tipContent != null ? (
          <Tooltip content={tipContent} side={tipSide} disabled={isOpen}>
            {triggerElem}
          </Tooltip>
        ) : (
          triggerElem
        );
    }
  }
  return renderedTrigger;
}
