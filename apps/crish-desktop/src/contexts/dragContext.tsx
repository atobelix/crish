import React, { createContext, useContext, useCallback, useRef, useState } from 'react';

interface DragOverlayPosition {
  x: number;
  y: number;
}

interface DragOverlayContextValue {
  active: boolean;
  node: React.ReactNode;
  position: DragOverlayPosition;
  setOverlay: (node: React.ReactNode, position: DragOverlayPosition) => void;
  updatePosition: (x: number, y: number) => void;
  clearOverlay: () => void;
}

const DragOverlayContext = createContext<DragOverlayContextValue | null>(null);

export function useDragOverlay(): DragOverlayContextValue {
  const ctx = useContext(DragOverlayContext);
  if (!ctx) {
    throw new Error('useDragOverlay must be used within a DragOverlayProvider');
  }
  return ctx;
}

export function DragOverlayProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false);
  const [node, setNode] = useState<React.ReactNode>(null);
  const positionRef = useRef<DragOverlayPosition>({ x: 0, y: 0 });
  const [position, setPosition] = useState<DragOverlayPosition>({ x: 0, y: 0 });

  const setOverlay = useCallback((n: React.ReactNode, pos: DragOverlayPosition) => {
    setNode(n);
    positionRef.current = pos;
    setPosition(pos);
    setActive(true);
  }, []);

  const updatePosition = useCallback((x: number, y: number) => {
    positionRef.current = { x, y };
    setPosition({ x, y });
  }, []);

  const clearOverlay = useCallback(() => {
    setActive(false);
    setNode(null);
  }, []);

  return (
    <DragOverlayContext.Provider value={{ active, node, position, setOverlay, updatePosition, clearOverlay }}>
      {children}
    </DragOverlayContext.Provider>
  );
}
