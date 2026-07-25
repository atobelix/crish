import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SessionState } from '../../../store/layoutStore';
import { useDragReorder } from '../../../hooks/useDragReorder';
import styles from '../SidebarSessionList.module.css';

export interface DragReorderSectionProps {
  sessions: SessionState[];
  folderName?: string | undefined;
  isPinned?: boolean | undefined;
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
  renderRow: (s: SessionState) => React.ReactNode;
}

/**
 * 内部组件：给一个会话列表注入 drag-reorder（useDragReorder + FLIP）。
 * 每个实例持有一个独立的 drag 状态。
 * 保留 React.cloneElement 处理器注入机制。
 */
export function DragReorderSection({
  sessions,
  folderName,
  isPinned,
  onMoveSessionRealtime,
  renderRow,
}: DragReorderSectionProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const flipRectsRef = useRef<Map<string, DOMRect>>(new Map());

  const items = useMemo(() => sessions.map((s) => ({ id: s.id })), [sessions]);

  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      const list = listRef.current;
      if (list) {
        const rects = new Map<string, DOMRect>();
        list
          .querySelectorAll<HTMLElement>('[data-session-id]')
          .forEach((el) => {
            const id = el.getAttribute('data-session-id');
            if (id) rects.set(id, el.getBoundingClientRect());
          });
        flipRectsRef.current = rects;
      }
      const fromSession = sessions[fromIndex];
      const toSession = sessions[toIndex];
      if (!fromSession) return;
      onMoveSessionRealtime(
        fromSession.id,
        toSession?.id ?? null,
        folderName ?? fromSession.folder ?? '会话',
        isPinned ?? fromSession.isPinned
      );
    },
    [sessions, folderName, isPinned, onMoveSessionRealtime]
  );

  const { dragIndex, dropIndex, onDragStart, onDragOver, onDrop, onDragEnd } =
    useDragReorder({
      items,
      onReorder: handleReorder,
    });

  const handleKeyboardReorder = useCallback(
    (sessionId: string, dir: -1 | 1) => {
      const idx = sessions.findIndex((s) => s.id === sessionId);
      if (idx < 0) return;
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= sessions.length) return;
      handleReorder(idx, targetIdx);
    },
    [sessions, handleReorder]
  );

  // FLIP animation on reorder
  useEffect(() => {
    const rects = flipRectsRef.current;
    if (rects.size === 0) return;
    const list = listRef.current;
    if (!list) return;
    requestAnimationFrame(() => {
      list.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => {
        const id = el.getAttribute('data-session-id');
        if (!id) return;
        const prev = rects.get(id);
        if (!prev) return;
        const curr = el.getBoundingClientRect();
        const dx = prev.left - curr.left;
        const dy = prev.top - curr.top;
        if (dx === 0 && dy === 0) return;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.transition = 'none';
        requestAnimationFrame(() => {
          el.style.transform = '';
          el.style.transition = 'transform 200ms ease';
          el.addEventListener(
            'transitionend',
            () => {
              el.style.transition = '';
            },
            { once: true }
          );
        });
      });
      flipRectsRef.current = new Map();
    });
  }, [sessions]);

  return (
    <div ref={listRef} style={{ display: 'contents' }}>
      {sessions.map((s, idx) => {
        const isDropTarget =
          dragIndex !== null && dragIndex !== idx && dropIndex === idx;
        return (
          <React.Fragment key={s.id}>
            {isDropTarget && (
              <div
                className={`${styles.dropIndicator} ${styles.dropIndicatorActive}`}
              />
            )}
            {React.cloneElement(
              renderRow(s) as React.ReactElement<Record<string, unknown>>,
              {
                dragHandlers: {
                  draggable: true,
                  onDragStart: (e: React.DragEvent) => onDragStart(idx, e),
                  onDragEnd,
                },
                dropHandlers: {
                  onDragOver: (e: React.DragEvent) => onDragOver(idx, e),
                  onDrop: () => onDrop(idx),
                },
                onReorderKeyboard: handleKeyboardReorder,
              }
            )}
          </React.Fragment>
        );
      })}
      {dragIndex !== null && dropIndex === sessions.length && (
        <div
          className={`${styles.dropIndicator} ${styles.dropIndicatorActive}`}
        />
      )}
    </div>
  );
}
