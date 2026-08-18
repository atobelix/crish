/**
 * layout-tree 几何基础类型（geometry primitives）。
 *
 * ## 为何独立成模块
 *
 * `Rect` / `Pointer` 是纯几何值对象，不依赖任何 services / store。
 * 此前与 `dropDetection.ts` 同文件，而 dropDetection 因 `isPrimary` 判定
 * 引入了 `services/view-registry` 反向边（store → services）。
 * 将几何类型上移到本独立模块，让 dropDetection / operations / conversationUnit
 * 等消费方经 `./geometry` 取类型，斩断「类型消费 → services 反向边」的隐式传播。
 *
 * ## 边界
 *
 * - 本文件**只**放无依赖的纯几何类型与几何纯函数。
 * - 禁止 import store / services / api 任何模块。
 * - `dropDetection.ts` 的 DropZone / detectDropZone 等检测算法仍留在原处
 *   （它们消费 Rect 但本身不是几何原语）。
 */

/** 矩形（viewport 坐标，与 DOMRect 字段对齐） */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 指针位置（viewport 坐标） */
export interface Pointer {
  x: number;
  y: number;
}
