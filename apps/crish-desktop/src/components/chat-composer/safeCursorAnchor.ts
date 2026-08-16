/**
 * apps/crish-desktop/src/components/chat-composer/safeCursorAnchor.ts
 * 生产级四级几何安全光标探测器 (DIM-06, CRM-01, WO-13, WO-14)。
 * 四级备援回退策略：
 * 1. Tiptap view.coordsAtPos (LineBox)
 * 2. DOM Range.getClientRects (DOM Selection Range)
 * 3. Editor View DOM Content Box
 * 4. Composer Container Fallback
 * 5. 终极熔断守卫：绝不向 (0,0) / (8px, 8px) 渲染任何浮层。
 *
 * 视口边缘防溢出翻折逻辑：
 * 距离顶部或底部边界 < 120px 时智能计算 suggestedSide 与对齐防线。
 *
 * CI Guardrail: Business Logic (Max 400 lines of effective code, UTF-8 无 BOM)
 */

export interface SafeAnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
  isFallback: boolean;
  isValid: boolean;
  suggestedSide?: 'top' | 'bottom';
  nearEdge?: boolean;
}

export interface CalculateSafeAnchorOptions {
  rawCursorRect?: DOMRect | null | (() => DOMRect | null);
  editorViewDom?: HTMLElement | null;
  composerContainer?: HTMLElement | null;
  selectionRange?: Range | null;
  edgeThreshold?: number; // 默认 120px
  previousSide?: 'top' | 'bottom';
  hysteresis?: number; // 默认 24px (DEC-06)
}

/**
 * 测量 ProseMirror 文档位置处的真实物理 LineBox 包围盒。
 * 恢复真实行高与光标宽度，杜绝 0 尺寸退化。
 */
export function measureCursorLineBox(
  view:
    | {
        coordsAtPos: (
          pos: number,
          side?: number
        ) => { top: number; bottom: number; left: number; right?: number };
      }
    | null
    | undefined,
  pos: number,
  side: number = 1
): DOMRect {
  if (!view || typeof view.coordsAtPos !== 'function') {
    return new DOMRect(0, 0, 0, 0);
  }

  try {
    const coords = view.coordsAtPos(pos, side);
    const top = coords.top;
    const bottom = coords.bottom;
    const measuredHeight = bottom - top;
    const height = Math.max(
      16,
      Number.isFinite(measuredHeight) ? measuredHeight : 20
    );
    const left = coords.left;
    const measuredWidth = (coords.right ?? coords.left) - coords.left;
    const width = Math.max(
      2,
      Number.isFinite(measuredWidth) ? measuredWidth : 2
    );

    return new DOMRect(left, top, width, height);
  } catch {
    return new DOMRect(0, 0, 0, 0);
  }
}

/**
 * 严格判定 DOMRect / ClientRect 几何有效性（有限浮点数且非负尺寸）。
 */
export function isValidClientRect(rect: unknown): rect is DOMRect {
  if (!rect || typeof rect !== 'object') return false;
  const r = rect as DOMRect;
  return (
    typeof r.top === 'number' &&
    Number.isFinite(r.top) &&
    typeof r.left === 'number' &&
    Number.isFinite(r.left) &&
    typeof r.width === 'number' &&
    Number.isFinite(r.width) &&
    r.width >= 0 &&
    typeof r.height === 'number' &&
    Number.isFinite(r.height) &&
    r.height >= 0
  );
}

/**
 * 物理可见且非零的包围盒判定 (含 Epsilon 容差防噪点)。
 * 杜绝 Windows DPI 缩放下 0.000031px 亚像素噪点引发的 (0,0) 坍塌。
 */
export function isPhysicallyVisibleNonZeroRect(
  rect: unknown,
  epsilon = 0.5
): rect is DOMRect {
  if (!isValidClientRect(rect)) return false;
  const r = rect as DOMRect;

  // 必须具有真实视觉可见宽高
  const hasVisualDimensions = r.width >= epsilon || r.height >= epsilon;
  // 杜绝绝对零点噪点（坐标极度接近 0 且高度不达标者视为未就绪）
  const isNearZeroOrigin =
    Math.abs(r.top) < epsilon && Math.abs(r.left) < epsilon && r.height < 12;

  return hasVisualDimensions && !isNearZeroOrigin;
}

/**
 * 判定光标是否处于输入框容器可见滚动视口内部。
 */
export function isAnchorInsideVisibleField(
  anchorRect: DOMRect | SafeAnchorRect,
  fieldElement: HTMLElement | null | undefined,
  tolerance = 4
): boolean {
  if (!fieldElement) return true;
  try {
    const fieldRect = fieldElement.getBoundingClientRect();
    if (fieldRect.width === 0 && fieldRect.height === 0) {
      return true;
    }
    const isAbove =
      anchorRect.top + anchorRect.height < fieldRect.top - tolerance;
    const isBelow = anchorRect.top > fieldRect.bottom + tolerance;
    return !isAbove && !isBelow;
  } catch {
    return true;
  }
}

/**
 * 计算视口边界安全边距与翻折方向建议。
 * 引入 24px 迟滞回差（Hysteresis Margin，DEC-06），杜绝亚像素浮动与临界点高频颠簸闪烁。
 */
export function computeViewportEdgeAlignment(
  top: number,
  height: number,
  edgeThreshold = 120,
  previousSide?: 'top' | 'bottom',
  hysteresis = 24
): { suggestedSide: 'top' | 'bottom'; nearEdge: boolean } {
  const vh =
    typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
      ? window.innerHeight
      : 800;

  const distToTop = top;
  const distToBottom = vh - (top + height);

  // 引入迟滞回差：当 previousSide 为 'top' 时，顶部阈值收缩（偏向保持 top）
  // 当 previousSide 为 'bottom' 时，顶部阈值扩张（偏向保持 bottom）
  const sideHysteresis =
    previousSide === 'top'
      ? -hysteresis
      : previousSide === 'bottom'
        ? hysteresis
        : 0;
  const effectiveTopThreshold = Math.max(0, edgeThreshold + sideHysteresis);

  if (distToTop < effectiveTopThreshold && distToBottom >= distToTop) {
    return { suggestedSide: 'bottom', nearEdge: true };
  }
  if (
    distToBottom < edgeThreshold - sideHysteresis &&
    distToTop >= distToBottom
  ) {
    return { suggestedSide: 'top', nearEdge: true };
  }

  const nearEdge = distToTop < edgeThreshold || distToBottom < edgeThreshold;
  const suggestedSide = distToTop < distToBottom ? 'bottom' : 'top';
  return { suggestedSide, nearEdge };
}

/**
 * 四级备援回退策略与视口边缘防漂移计算引擎。
 */
export function calculateSafeCursorAnchor(
  options: CalculateSafeAnchorOptions
): SafeAnchorRect | null {
  const {
    rawCursorRect,
    editorViewDom,
    composerContainer,
    selectionRange,
    edgeThreshold = 120,
    previousSide,
    hysteresis = 24,
  } = options;

  // Level 1: 探测精确光标包围盒 (view.coordsAtPos / rawCursorRect)
  const directRect =
    typeof rawCursorRect === 'function' ? rawCursorRect() : rawCursorRect;

  if (directRect && isPhysicallyVisibleNonZeroRect(directRect)) {
    if (isAnchorInsideVisibleField(directRect, editorViewDom)) {
      const edgeInfo = computeViewportEdgeAlignment(
        directRect.top,
        directRect.height,
        edgeThreshold,
        previousSide,
        hysteresis
      );
      return {
        top: directRect.top,
        left: directRect.left,
        width: Math.max(2, directRect.width),
        height: Math.max(16, directRect.height),
        isFallback: false,
        isValid: true,
        suggestedSide: edgeInfo.suggestedSide,
        nearEdge: edgeInfo.nearEdge,
      };
    }
  }

  // Level 2: 探测 DOM Range / Selection 选区包围盒
  let rangeRect: DOMRect | null = null;
  if (
    selectionRange &&
    typeof selectionRange.getBoundingClientRect === 'function'
  ) {
    try {
      rangeRect = selectionRange.getBoundingClientRect();
    } catch {
      rangeRect = null;
    }
  } else if (
    typeof window !== 'undefined' &&
    typeof window.getSelection === 'function'
  ) {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        rangeRect = r.getBoundingClientRect();
      }
    } catch {
      rangeRect = null;
    }
  }

  if (rangeRect && isPhysicallyVisibleNonZeroRect(rangeRect)) {
    if (isAnchorInsideVisibleField(rangeRect, editorViewDom)) {
      const edgeInfo = computeViewportEdgeAlignment(
        rangeRect.top,
        rangeRect.height,
        edgeThreshold,
        previousSide,
        hysteresis
      );
      return {
        top: rangeRect.top,
        left: rangeRect.left,
        width: Math.max(2, rangeRect.width),
        height: Math.max(16, rangeRect.height),
        isFallback: true,
        isValid: true,
        suggestedSide: edgeInfo.suggestedSide,
        nearEdge: edgeInfo.nearEdge,
      };
    }
  }

  // Level 3: 探测 Editor DOM Content Box
  if (editorViewDom) {
    try {
      const edRect = editorViewDom.getBoundingClientRect();
      if (isPhysicallyVisibleNonZeroRect(edRect)) {
        const edgeInfo = computeViewportEdgeAlignment(
          edRect.top + 8,
          20,
          edgeThreshold,
          previousSide,
          hysteresis
        );
        return {
          top: edRect.top + 8,
          left: edRect.left + 12,
          width: 2,
          height: 20,
          isFallback: true,
          isValid: true,
          suggestedSide: edgeInfo.suggestedSide,
          nearEdge: edgeInfo.nearEdge,
        };
      }
    } catch {
      // ignore
    }
  }

  // Level 4: 探测 Composer 外部容器
  if (composerContainer) {
    try {
      const compRect = composerContainer.getBoundingClientRect();
      if (isPhysicallyVisibleNonZeroRect(compRect)) {
        const edgeInfo = computeViewportEdgeAlignment(
          compRect.top + 12,
          20,
          edgeThreshold,
          previousSide,
          hysteresis
        );
        return {
          top: compRect.top + 12,
          left: compRect.left + 16,
          width: 2,
          height: 20,
          isFallback: true,
          isValid: true,
          suggestedSide: edgeInfo.suggestedSide,
          nearEdge: edgeInfo.nearEdge,
        };
      }
    } catch {
      // ignore
    }
  }

  // 终极熔断防线 (Zero-Visibility Circuit Breaker)
  // 4 级探测均未能获取真实视口包围盒时，直接 return null，绝对不挂载 Portal
  return null;
}
