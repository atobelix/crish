/**
 * apps/crish-desktop/src/components/ui/DropdownMenu/DropdownMenuContext.tsx
 *
 * ui/DropdownMenu 内部上下文
 * 维护多层级级联拓扑、触发器与内容区 Ref 以及单例浮层栈交互。
 */

import React, { createContext, useContext } from 'react';

export interface DropdownMenuContextValue {
  dropdownId: string | null;
  triggerRef?: React.RefObject<HTMLElement | null>;
  contentRef?: React.RefObject<HTMLDivElement | null>;
  isOpen?: boolean;
  setOpen?: (open: boolean) => void;
  portalContainer?: HTMLElement | null;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

export const DropdownMenuContext = createContext<DropdownMenuContextValue>({
  dropdownId: null,
});

export function useDropdownMenuContext(): DropdownMenuContextValue {
  return useContext(DropdownMenuContext);
}
