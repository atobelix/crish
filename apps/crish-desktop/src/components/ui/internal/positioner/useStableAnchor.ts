/**
 * apps/crish-desktop/src/components/ui/internal/positioner/useStableAnchor.ts
 *
 * 稳定化 Anchor 引用 Hook —— 基于值语义数值比对（x, y, width, height），
 * 彻底消除字面量 `{ x, y }` 引发的 React 185 (Maximum update depth exceeded) 死循环 (DEF-02)
 */

import { useRef } from 'react';
import type { PositionerAnchor, VirtualPoint } from './types';

/**
 * 稳定化 Anchor 引用
 *
 * 在右键菜单、光标选区等场景下，调用方普遍传入 `<ContextMenu anchor={{ x: e.clientX, y: e.clientY }} />`。
 * 每次父组件重渲染都会创建新的对象引用；若直接用作依赖，将造成 useLayoutEffect -> setState 无限死循环。
 * 本 Hook 通过深度值语义比对，在数值相同时保持上一轮引用不变。
 */
export function useStableAnchor(anchor: PositionerAnchor): PositionerAnchor {
  const stableRef = useRef<PositionerAnchor>(anchor);

  const isSame = (prev: PositionerAnchor, next: PositionerAnchor): boolean => {
    if (prev === next) return true;
    if (!prev || !next) return false;

    // 1. 比对虚拟点 VirtualPoint: { x, y, width?, height? }
    if (
      typeof prev === 'object' &&
      typeof next === 'object' &&
      'x' in prev &&
      'x' in next &&
      'y' in prev &&
      'y' in next
    ) {
      const p1 = prev as VirtualPoint;
      const p2 = next as VirtualPoint;
      return (
        p1.x === p2.x &&
        p1.y === p2.y &&
        (p1.width ?? 0) === (p2.width ?? 0) &&
        (p1.height ?? 0) === (p2.height ?? 0)
      );
    }

    // 2. 比对 React RefObject: { current }
    if (
      typeof prev === 'object' &&
      typeof next === 'object' &&
      'current' in prev &&
      'current' in next
    ) {
      return (
        (prev as { current: unknown }).current ===
        (next as { current: unknown }).current
      );
    }

    // 3. 比对 DOMRect / 矩形对象: { left, top, right, bottom }
    if (
      typeof prev === 'object' &&
      typeof next === 'object' &&
      'left' in prev &&
      'left' in next &&
      'top' in prev &&
      'top' in next &&
      'right' in prev &&
      'right' in next &&
      'bottom' in prev &&
      'bottom' in next
    ) {
      const r1 = prev as unknown as {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width?: number;
        height?: number;
      };
      const r2 = next as unknown as {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width?: number;
        height?: number;
      };
      return (
        r1.left === r2.left &&
        r1.top === r2.top &&
        r1.right === r2.right &&
        r1.bottom === r2.bottom &&
        (r1.width ?? r1.right - r1.left) === (r2.width ?? r2.right - r2.left) &&
        (r1.height ?? r1.bottom - r1.top) === (r2.height ?? r2.bottom - r2.top)
      );
    }

    return false;
  };

  if (!isSame(stableRef.current, anchor)) {
    stableRef.current = anchor;
  }

  return stableRef.current;
}
