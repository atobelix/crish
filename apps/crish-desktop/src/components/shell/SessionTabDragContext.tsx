/**
 * 会话标签拖拽单例上下文。
 * App 层挂一次 useTopBarDrag，AppTopBar（单 unit 全局条）与
 * UnitSessionTabStrip（多 unit 分屏条）共用同一 startSessionDrag。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  useTopBarDrag,
  type UseTopBarDragResult,
} from '../binary-tree/useTopBarDrag';
import stripStyles from '../binary-tree/UnitSessionTabStrip.module.css';

const SessionTabDragContext = createContext<UseTopBarDragResult | null>(null);

const NOOP_DRAG: UseTopBarDragResult = {
  isDragging: false,
  startSessionDrag: () => {},
  startToolDrag: () => {},
  setGhostRef: () => {},
  ghostLabel: null,
};

export function SessionTabDragProvider({ children }: { children: ReactNode }) {
  const refreshSessionTabs = useCallback(() => {
    window.dispatchEvent(new CustomEvent('crish-tabs-refresh'));
  }, []);
  const drag = useTopBarDrag('', refreshSessionTabs);

  return (
    <SessionTabDragContext.Provider value={drag}>
      {children}
      {drag.isDragging &&
        drag.ghostLabel &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={drag.setGhostRef}
            className={`topbar-drag-ghost ${stripStyles.dragGhost}`}
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              transform: 'translate(-9999px, -9999px)',
            }}
            aria-hidden="true"
          >
            <span className={stripStyles.dragGhostLabel}>{drag.ghostLabel}</span>
          </div>,
          document.body
        )}
    </SessionTabDragContext.Provider>
  );
}

export function useSessionTabDrag(): UseTopBarDragResult {
  return useContext(SessionTabDragContext) ?? NOOP_DRAG;
}
