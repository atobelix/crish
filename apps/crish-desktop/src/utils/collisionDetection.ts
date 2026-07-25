export interface PointerPosition { x: number; y: number; }
export interface CardRect {
  left: number; top: number; right: number; bottom: number;
  width: number; height: number;
}
export type FiveZone = 'leftEdge' | 'top' | 'center' | 'bottom' | 'rightEdge';

export interface DropTarget {
  type: 'insert-col-left' | 'insert-col-right'
      | 'insert-group-top' | 'insert-group-bottom'
      | 'merge-to-group'
      | 'new-col-right' | 'new-col-left';
  wsId: string;
  colIdx: number;
  groupIdx: number;
  cardId?: string;
  rect: CardRect;
}

export interface CascadeResult {
  level: 1 | 2 | 3 | 4;
  cardId: string;
  rect: CardRect;
  zone: FiveZone;
  distance: number;
}

export function isPointerInRect(pointer: PointerPosition, rect: CardRect, padding = 0): boolean {
  return pointer.x >= rect.left - padding && pointer.x <= rect.right + padding
      && pointer.y >= rect.top - padding && pointer.y <= rect.bottom + padding;
}

export function rectIntersection(
  pointer: PointerPosition,
  cardRects: Array<{ id: string; rect: CardRect }>,
  padding = 0,
): Array<{ id: string; rect: CardRect; distance: number }> {
  return cardRects
    .filter(({ rect }) => isPointerInRect(pointer, rect, padding))
    .map(({ id, rect }) => ({ id, rect, distance: distanceToCenter(pointer, rect) }))
    .sort((a, b) => a.distance - b.distance);
}

function distanceToCenter(pointer: PointerPosition, rect: CardRect): number {
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  return Math.sqrt((pointer.x - cx) ** 2 + (pointer.y - cy) ** 2);
}

export function closestCenter(
  pointer: PointerPosition,
  cardRects: Array<{ id: string; rect: CardRect }>,
  limit = 3,
): Array<{ id: string; rect: CardRect; distance: number }> {
  return cardRects
    .map(({ id, rect }) => ({ id, rect, distance: distanceToCenter(pointer, rect) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

export function fiveZoneDetection(pointer: PointerPosition, rect: CardRect): FiveZone {
  const relX = (pointer.x - rect.left) / rect.width;
  const relY = (pointer.y - rect.top) / rect.height;
  if (rect.width > 200) {
    if (relX < 0.125) return 'leftEdge';
    if (relX > 0.875) return 'rightEdge';
  }
  if (relY < 0.2) return 'top';
  if (relY > 0.8) return 'bottom';
  return 'center';
}

export function edgeDetection(
  pointer: PointerPosition,
  cardRects: Array<{ id: string; rect: CardRect }>,
): { id: string; rect: CardRect; edge: 'left' | 'right' | 'top' | 'bottom'; distance: number } | null {
  let closest: {
    id: string;
    rect: CardRect;
    edge: 'left' | 'right' | 'top' | 'bottom';
    distance: number;
  } | null = null;
  for (const { id, rect } of cardRects) {
    const edges = [
      { edge: 'left' as const, distance: Math.abs(pointer.x - rect.left) },
      { edge: 'right' as const, distance: Math.abs(pointer.x - rect.right) },
      { edge: 'top' as const, distance: Math.abs(pointer.y - rect.top) },
      { edge: 'bottom' as const, distance: Math.abs(pointer.y - rect.bottom) },
    ];
    for (const { edge, distance } of edges) {
      if (!closest || distance < closest.distance) closest = { id, rect, edge, distance };
    }
  }
  return closest;
}

export function nestedCollisionDetection(
  pointer: PointerPosition,
  cardRects: Array<{ id: string; rect: CardRect }>,
  threshold = 20,
): CascadeResult | null {
  const hits = rectIntersection(pointer, cardRects);
  if (hits.length > 0) {
    const { id, rect, distance } = hits[0]!;
    const zone = fiveZoneDetection(pointer, rect);
    return { level: 1, cardId: id, rect, zone, distance };
  }
  const nearest = closestCenter(pointer, cardRects, 1);
  if (nearest.length > 0 && nearest[0]!.distance < threshold) {
    const { id, rect, distance } = nearest[0]!;
    const zone = fiveZoneDetection(pointer, rect);
    return { level: 2, cardId: id, rect, zone, distance };
  }
  const edge = edgeDetection(pointer, cardRects);
  if (edge) {
    const zone = edge.edge === 'left' ? 'leftEdge' : edge.edge === 'right' ? 'rightEdge'
      : edge.edge === 'top' ? 'top' : 'bottom';
    return { level: 3, cardId: edge.id, rect: edge.rect, zone, distance: edge.distance };
  }
  return null;
}

export function computeDropIndicatorRect(
  target: DropTarget,
  canvasRect: CardRect,
): { left: number; top: number; width: number; height: number; className: string } {
  switch (target.type) {
    case 'insert-col-left': case 'insert-col-right': {
      const x = target.type === 'insert-col-left' ? target.rect.left : target.rect.right;
      return { left: x - 1.5, top: canvasRect.top, width: 3, height: canvasRect.height, className: 'drop-indicator-line-v' };
    }
    case 'insert-group-top': case 'insert-group-bottom': {
      const y = target.type === 'insert-group-top' ? target.rect.top : target.rect.bottom;
      return { left: target.rect.left, top: y - 1.5, width: target.rect.width, height: 3, className: 'drop-indicator-line-h' };
    }
    case 'merge-to-group':
      return { left: target.rect.left, top: target.rect.top, width: target.rect.width, height: target.rect.height, className: 'drop-indicator-merge' };
    case 'new-col-right':
      return { left: canvasRect.right - 300, top: canvasRect.top, width: 300, height: canvasRect.height, className: 'drop-indicator-col-preview' };
    case 'new-col-left':
      return { left: canvasRect.left, top: canvasRect.top, width: 300, height: canvasRect.height, className: 'drop-indicator-col-preview' };
  }
}
