/**
 * 编辑器测距公共入口。
 *
 * 源码与 DOM 一律经 SourceProjection，物理位置一律取原生 Range；
 * 测量不读取文档 store，不按源码长度分摊控件宽度。
 */
import { type SourceAffinity } from './sourceProjection';
import {
  getMeasurementContext,
  readCaretRect,
  type ProjectionRect,
} from './sourceProjectionCache';
import { indexFromNativePoint, navigateVisualLine } from './sourceProjectionGeometry';
import { lineBidiInfo, type LineBidiInfo } from './Bidi';

export {
  clearContainerMeasurementCache,
  invalidateMeasurementLines,
  disposeContainerMeasurementCache,
} from './sourceProjectionCache';

export interface MeasuredRect extends ProjectionRect {}
export interface ContainerCoords extends ProjectionRect {}

export function getCoordinatesFromIndex(
  index: number,
  container: HTMLElement | null,
  affinity: SourceAffinity = 'forward',
): MeasuredRect | null {
  return container ? readCaretRect(index, container, affinity) : null;
}

export function toContainerCoords(rect: MeasuredRect, container: HTMLElement): ContainerCoords {
  const origin = container.getBoundingClientRect();
  const top = origin.top + container.clientTop - container.scrollTop;
  return { top: rect.top - top, left: rect.left - origin.left - container.clientLeft + container.scrollLeft,
    height: rect.height, bottom: rect.bottom - top };
}

export function getGlobalIndexFromDOMNode(
  node: Node, offset: number, container: HTMLElement, affinity: SourceAffinity = 'forward',
): number | null {
  return getMeasurementContext(container).projection.domToSource(node, offset, affinity);
}

export function getDOMPointFromIndex(
  index: number, container: HTMLElement, affinity: SourceAffinity = 'forward',
) {
  return getMeasurementContext(container).projection.sourceToDOM(index, affinity);
}

/** 视觉字符移动由原生Selection解释；无宿主能力或目标未挂载时明确返回null。 */
export function getAdjacentSourceCaret(
  index: number, direction: 'left' | 'right', container: HTMLElement, documentLength?: number,
): number | null {
  return getMeasurementContext(container).projection.moveVisualCaret(index, direction, documentLength);
}

/** 原生端点与模型投影等价时，不让异步 selectionchange 规范化隐藏源码端点。 */
export function domSelectionMatchesModel(
  container: HTMLElement, anchor: number, head: number,
  selection: Selection | null = container.ownerDocument.defaultView?.getSelection() ?? null,
): boolean {
  if (!selection?.anchorNode || !selection.focusNode) return false;
  const projection = getMeasurementContext(container).projection;
  const a = projection.sourceToDOM(anchor);
  const h = projection.sourceToDOM(head);
  if (!a || !h) return false;
  return projection.domToSource(selection.anchorNode, selection.anchorOffset) === a.index &&
    projection.domToSource(selection.focusNode, selection.focusOffset) === h.index;
}

/** 三参数依次为容器、锚点、活动端；保留选择方向，且相同端点不重复写原生选区。 */
export function syncDOMSelection(container: HTMLElement | null, anchor: number, head: number): void {
  if (!container) return;
  const selection = container.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const projection = getMeasurementContext(container).projection;
  const a = projection.sourceToDOM(anchor);
  const h = projection.sourceToDOM(head);
  if (!a || !h) return;
  if (selection.anchorNode === a.node && selection.anchorOffset === a.offset &&
    selection.focusNode === h.node && selection.focusOffset === h.offset) return;
  selection.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
}

/** 原生命中接口供点击、拖选和控件编辑面共用。 */
export function getSourceIndexFromPoint(
  clientX: number, clientY: number, container: HTMLElement, affinity: SourceAffinity = 'forward',
): number | null {
  return indexFromNativePoint(clientX, clientY, container, affinity);
}


export function getArrowNavigationIndex(
  cursorPos: number, direction: 'up' | 'down', container: HTMLElement,
  contentX?: number,
): number | null {
  if (contentX !== undefined) getMeasurementContext(container).navigation = { head: cursorPos, contentX };
  return navigateVisualLine(cursorPos, direction, container);
}

export interface ActiveState { cursor: number; selStart?: number; selEnd?: number }

export function checkIsActive(start: number, len: number, active: ActiveState | null): boolean {
  if (!active) return false;
  if (active.selStart !== undefined && active.selEnd !== undefined && active.selStart !== active.selEnd) {
    return start < Math.max(active.selStart, active.selEnd) && start + len > Math.min(active.selStart, active.selEnd);
  }
  return active.cursor >= start && active.cursor <= start + len;
}


const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 行内方向信息的纯数据接口；实际鼠标与垂直移动使用原生 DOM 几何。 */
export function moveHorizontallyBidi(
  index: number, direction: 'left' | 'right', text: string, info: LineBidiInfo | null,
): number {
  const rtl = info?.spans.some(span => index >= span.from && index < span.to) ?? false;
  const forward = rtl ? direction === 'left' : direction === 'right';
  const boundaries = [...Array.from(graphemes.segment(text), part => part.index), text.length];
  return forward ? boundaries.find(offset => offset > index) ?? text.length
    : boundaries.findLast(offset => offset < index) ?? 0;
}

export function getLineBidiInfo(text: string): LineBidiInfo | null {
  return lineBidiInfo(text);
}
