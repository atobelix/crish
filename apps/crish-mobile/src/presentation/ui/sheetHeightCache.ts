// Sheet 实测高度缓存与行程裁决。
// 位移、拖拽进度、速度归一必须共用同一行程高度。
// 缓存键含浮层身份、窗口几何与内容几何；旋转或内容变化不得复用旧高度。
// 进场过程中的新测量只记下来，不改在飞的行程，避免中途跳变。

export interface SheetHeightCacheKey {
  overlayId: string;
  windowWidth: number;
  windowHeight: number;
  size: string;
  contentKey: string;
}

export type SheetMeasurePhase =
  | 'idle'
  | 'waiting'
  | 'animating'
  | 'settled'
  | 'closing';

const store = new Map<string, number>();

export function sheetHeightCacheKey(key: SheetHeightCacheKey): string {
  const width = Math.round(key.windowWidth);
  const height = Math.round(key.windowHeight);
  return `${key.overlayId}|${width}x${height}|${key.size}|${key.contentKey}`;
}

export function readSheetHeight(key: string): number | null {
  const value = store.get(key);
  return value !== undefined && value > 0 ? value : null;
}

export function writeSheetHeight(key: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  store.set(key, height);
}

export function clearSheetHeightCache(): void {
  store.clear();
}

/** 有可信高度才允许进场；否则等待真实 onLayout，不用档位比例冒充面板高。 */
export function openingPlan(input: {
  cached: number | null;
  alreadyMeasured: number;
}): { travelHeight: number; reveal: boolean } {
  const measured = input.alreadyMeasured > 0 ? input.alreadyMeasured : 0;
  const cached = input.cached !== null && input.cached > 0 ? input.cached : 0;
  const travel = measured > 0 ? measured : cached;
  if (travel > 0) return { travelHeight: travel, reveal: true };
  return { travelHeight: 0, reveal: false };
}

/**
 * 进场或退场途中锁定行程。静止或尚未进场时采纳最新实测。
 * 进度为 1 时改行程不会移动面板。
 */
export function resolveTravelOnMeasure(input: {
  phase: SheetMeasurePhase;
  travelHeight: number;
  latestMeasured: number;
}): { travelHeight: number; changed: boolean } {
  const measured = input.latestMeasured;
  if (!Number.isFinite(measured) || measured <= 0) {
    return { travelHeight: input.travelHeight, changed: false };
  }
  if (input.phase === 'animating' || input.phase === 'closing') {
    return { travelHeight: input.travelHeight, changed: false };
  }
  if (Math.abs(input.travelHeight - measured) <= 0.5) {
    return { travelHeight: input.travelHeight, changed: false };
  }
  return { travelHeight: measured, changed: true };
}

/**
 * 进场完成只消费最新实测。
 * staleClosureHeight 是首帧 panelHeight=0 一类闭包，必须忽略。
 */
export function travelAfterEnterFinished(input: {
  latestMeasured: number;
  inFlightTravel: number;
  staleClosureHeight: number;
}): number {
  if (input.latestMeasured > 0) return input.latestMeasured;
  if (input.inFlightTravel > 0) return input.inFlightTravel;
  return 0;
}
