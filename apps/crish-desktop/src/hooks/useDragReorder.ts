import { useCallback, useRef, useState } from 'react';

interface DragReorderOptions<T> {
  items: T[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  keyField?: keyof T;
}

interface DragReorderState {
  dragIndex: number | null;
  dropIndex: number | null;
  dragOver: boolean;
}

export function useDragReorder<T>({ items, onReorder, keyField = 'id' as any }: DragReorderOptions<T>) {
  const [state, setState] = useState<DragReorderState>({
    dragIndex: null, dropIndex: null, dragOver: false,
  });
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const onDragStart = useCallback((index: number, e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    setState(s => ({ ...s, dragIndex: index, dragOver: true }));
    
    // Create ghost element
    const ghost = e.currentTarget.cloneNode(true) as HTMLElement;
    ghost.style.position = 'fixed';
    ghost.style.opacity = '0.5';
    ghost.style.pointerEvents = 'none';
    ghost.style.width = `${e.currentTarget.clientWidth}px`;
    ghost.style.zIndex = '9999';
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
  }, []);

  const onDragOver = useCallback((index: number, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setState(s => ({ ...s, dropIndex: index }));
    
    // Move ghost
    if (ghostRef.current) {
      ghostRef.current.style.top = `${e.clientY - 30}px`;
      ghostRef.current.style.left = `${e.clientX - 100}px`;
    }
  }, []);

  const onDrop = useCallback((index: number) => {
    setState(s => ({ ...s, dragOver: false }));
    const from = state.dragIndex;
    if (from !== null && from !== index) {
      onReorder(from, index);
    }
    cleanup();
  }, [state.dragIndex, onReorder]);

  const onDragEnd = useCallback(() => {
    setState({ dragIndex: null, dropIndex: null, dragOver: false });
    cleanup();
  }, []);

  function cleanup() {
    if (ghostRef.current) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
  }

  return { ...state, onDragStart, onDragOver, onDrop, onDragEnd };
}
