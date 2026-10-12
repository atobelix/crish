/**
 * useChatCardDragDrop — 对话卡片（子窗口）文件拖放协调器。
 *
 * 核心保证（多子窗口 / 分屏下精确归属判定）：
 * 1. 唯一归属判定：无论通过 Tauri IPC（tauri://drag-*）还是 Web 原生 DOM 事件，
 *    通过事件物理/逻辑坐标及容器边界（[data-leaf-id] / chatBody），精准识别文件属于哪个子窗口；
 * 2. 状态互斥：文件悬停在 A 子窗口时，仅 A 子窗口点亮拖放遮罩，B 子窗口绝不受干扰；
 * 3. 消费单义：文件释放在 A 子窗口时，仅向 A 子窗口注入文件/路径，其他子窗口绝对拦截；
 * 4. 默认跳页拦截：全局 window 拖放事件仅拦截浏览器默认文件导航，非目标子窗口不吞并文件。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIpcListener } from '../../hooks/useIpcListener';
import { hasFiles } from '../chat-composer/ComposerDropHost';

export interface DragCoordinates {
  x: number;
  y: number;
}

export interface UseChatCardDragDropOptions {
  /** 接收到外部系统路径时触发（Tauri） */
  handlePathsSelected: (paths: string[]) => void | Promise<void>;
  /** 接收到 DOM File 列表时触发 */
  handleDroppedFiles: (files: File[]) => void | Promise<void>;
}

/**
 * 从原始 Tauri IPC 事件 payload 中提取窗口物理坐标并转换为 CSS 逻辑像素坐标。
 */
export function getLogicalDragPosition(
  payload: unknown
): DragCoordinates | null {
  if (!payload || typeof payload !== 'object') return null;
  const rawPos = (payload as { position?: unknown }).position;
  if (!rawPos || typeof rawPos !== 'object') return null;

  let physicalX: number | undefined;
  let physicalY: number | undefined;

  const p = rawPos as {
    x?: unknown;
    y?: unknown;
    Physical?: { x?: unknown; y?: unknown };
  };

  if (
    p.Physical &&
    typeof p.Physical.x === 'number' &&
    typeof p.Physical.y === 'number'
  ) {
    physicalX = p.Physical.x;
    physicalY = p.Physical.y;
  } else if (typeof p.x === 'number' && typeof p.y === 'number') {
    physicalX = p.x;
    physicalY = p.y;
  }

  if (typeof physicalX !== 'number' || typeof physicalY !== 'number') {
    return null;
  }

  const dpr =
    typeof window !== 'undefined' && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  return {
    x: physicalX / dpr,
    y: physicalY / dpr,
  };
}

/**
 * 判断逻辑坐标点是否落在当前对话卡片（.chatBody）范围内。
 * 判定严格以 element 自身的矩形半开区间 [left, right) × [top, bottom) 为准（width > 0 && height > 0）；
 * 若 document.elementFromPoint 可用且返回非空节点 hitEl，校验 element.contains(hitEl)
 * 且不在同叶右侧抽屉 .leafToolPanel 内，且未被 Modal 遮罩层遮挡；JSDOM 环境下回退至几何半开区间。
 */
export function isPointInsideTarget(
  element: HTMLElement | null | undefined,
  pos: DragCoordinates | null
): boolean {
  if (!element || !pos) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const insideRect =
    pos.x >= rect.left &&
    pos.x < rect.right &&
    pos.y >= rect.top &&
    pos.y < rect.bottom;

  if (!insideRect) return false;

  if (
    typeof document !== 'undefined' &&
    typeof document.elementFromPoint === 'function'
  ) {
    const hitEl = document.elementFromPoint(pos.x, pos.y);
    if (
      hitEl &&
      hitEl !== document.body &&
      hitEl !== document.documentElement
    ) {
      const isInside = element === hitEl || element.contains(hitEl);
      if (!isInside) return false;

      // 遮挡排除：同叶右侧抽屉覆盖或全屏 Modal / 遮罩层
      if (
        hitEl.closest?.(
          '.leafToolPanel, [data-leaf-tool-panel], [role="dialog"], .modal, [data-modal], .dialog-backdrop'
        )
      ) {
        return false;
      }
      return true;
    }
  }

  return insideRect;
}

export function useChatCardDragDrop({
  handlePathsSelected,
  handleDroppedFiles,
}: UseChatCardDragDropOptions) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  // 1. Tauri IPC 事件通道：基于物理坐标转换判定是否命中本子窗口
  useIpcListener<{ paths?: string[]; position?: unknown }>(
    'tauri://drag-enter',
    useCallback((event) => {
      const pos = getLogicalDragPosition(event.payload);
      if (pos) {
        const inside = isPointInsideTarget(rootRef.current, pos);
        setIsDragOver(inside);
      } else {
        setIsDragOver(false);
      }
    }, [])
  );

  useIpcListener<{ position?: unknown }>(
    'tauri://drag-over',
    useCallback((event) => {
      const pos = getLogicalDragPosition(event.payload);
      if (pos) {
        const inside = isPointInsideTarget(rootRef.current, pos);
        setIsDragOver(inside);
      }
    }, [])
  );

  useIpcListener(
    'tauri://drag-leave',
    useCallback(() => {
      setIsDragOver(false);
      dragDepthRef.current = 0;
    }, [])
  );

  useIpcListener<{ paths?: string[]; position?: unknown }>(
    'tauri://drag-drop',
    useCallback(
      (event) => {
        setIsDragOver(false);
        dragDepthRef.current = 0;
        const pos = getLogicalDragPosition(event.payload);
        if (pos && isPointInsideTarget(rootRef.current, pos)) {
          const paths = event.payload?.paths ?? [];
          if (paths.length > 0) {
            void handlePathsSelected(paths);
          }
        }
      },
      [handlePathsSelected]
    )
  );

  // 2. Window 级别全局事件监听：防止浏览器跳页，且仅当落点在当前子窗口时触发消费
  useEffect(() => {
    const onWindowDragOver = (e: DragEvent) => {
      if (hasFiles(e.dataTransfer)) {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      }
    };

    const onWindowDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setIsDragOver(false);
      dragDepthRef.current = 0;

      // 仅当 drop 坐标确实命中本子窗口范围时才执行本卡片的文件载入
      const coords: DragCoordinates = { x: e.clientX, y: e.clientY };
      if (isPointInsideTarget(rootRef.current, coords)) {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) {
          void handleDroppedFiles(files);
        }
      }
    };

    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('drop', onWindowDrop);
    return () => {
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('drop', onWindowDrop);
    };
  }, [handleDroppedFiles]);

  // 3. 本地元素 DOM 拖拽处理器
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) {
        void handleDroppedFiles(files);
      }
    },
    [handleDroppedFiles]
  );

  return {
    rootRef,
    isDragOver,
    dragHandlers: {
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop,
    },
  };
}
