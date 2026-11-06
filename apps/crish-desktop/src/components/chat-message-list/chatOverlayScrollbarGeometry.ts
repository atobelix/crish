/**
 * 主聊天列表自研悬浮滚动条（S3 路线 B）的纯几何与同步判定。
 *
 * 几何真理只有一个来源：scroller 本体的 scrollTop / scrollHeight /
 * clientHeight / clientWidth。本模块只做「快照 → 滑块几何」与
 * 「前后两帧快照 → 本帧写入是否允许平滑」的纯计算，不碰 DOM、
 * 不反写滚动位置（拖拽写回由 ScrollArea 的 useThumbDrag 承担）。
 *
 * 平滑纪律（A 报告 §5.3 + S 波裁定）：
 * - 只有「总高变化」驱动的几何变化可以平滑（尺寸恒可，位置仅当
 *   本帧滚动位置未动时）；
 * - 用户滚动 / 拖拽期间明文禁止一切平滑（跟手优先）；
 * - 视口尺寸变化（侧栏布局动画、窗口缩放、抽屉挤压）一律直接跟随，
 *   不许与布局动画叠加双重平滑（S2 交叉口径）。
 */

export interface ScrollGeometrySnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
}

export interface ThumbGeometry {
  /** 内容未溢出（不需要滚动条） */
  hasOverflow: boolean;
  thumbHeightPx: number;
  thumbOffsetPx: number;
  maxTravelPx: number;
  /** 0..1，scrollTop / maxScroll */
  progress: number;
}

/** 与 ScrollArea 的 minThumbSize 同值（18px），保持仓内滑块下限单口径 */
export const CHAT_OVERLAY_MIN_THUMB_PX = 18;

export function readScrollSnapshot(el: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
}): ScrollGeometrySnapshot {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    clientWidth: el.clientWidth,
  };
}

export function computeThumbGeometry(
  snap: ScrollGeometrySnapshot
): ThumbGeometry {
  const trackHeightPx = Math.max(0, snap.clientHeight);
  const hasOverflow =
    trackHeightPx > 0 && snap.scrollHeight > snap.clientHeight;
  if (!hasOverflow) {
    return {
      hasOverflow: false,
      thumbHeightPx: 0,
      thumbOffsetPx: 0,
      maxTravelPx: 0,
      progress: 0,
    };
  }
  const rawThumb =
    (snap.clientHeight / snap.scrollHeight) * trackHeightPx;
  const thumbHeightPx = Math.min(
    trackHeightPx,
    Math.max(CHAT_OVERLAY_MIN_THUMB_PX, rawThumb)
  );
  const maxTravelPx = Math.max(0, trackHeightPx - thumbHeightPx);
  const maxScroll = Math.max(0, snap.scrollHeight - snap.clientHeight);
  const progress =
    maxScroll > 0
      ? Math.min(1, Math.max(0, snap.scrollTop / maxScroll))
      : 0;
  return {
    hasOverflow: true,
    thumbHeightPx,
    thumbOffsetPx: progress * maxTravelPx,
    maxTravelPx,
    progress,
  };
}

export interface ThumbSyncDecision {
  /** 滑块高度写入走 150ms standard 过渡 */
  sizeSmooth: boolean;
  /** 滑块位移写入走 150ms standard 过渡 */
  offsetSmooth: boolean;
}

const NO_SMOOTH: ThumbSyncDecision = {
  sizeSmooth: false,
  offsetSmooth: false,
};

/**
 * 逐帧裁决本帧几何写入是否平滑。prev 为 null（首帧）恒直接写入。
 * gestureActive 由宿主组件按 wheel / touch / 滚动键手势窗维护；
 * dragging 为滑块拖拽态。两者任一为真 → 全禁平滑。
 */
export function decideThumbSync(
  prev: ScrollGeometrySnapshot | null,
  next: ScrollGeometrySnapshot,
  opts: { gestureActive: boolean; dragging: boolean }
): ThumbSyncDecision {
  if (!prev) return NO_SMOOTH;
  if (opts.gestureActive || opts.dragging) return NO_SMOOTH;
  // 布局驱动（侧栏动画 / 窗口缩放 / 分屏挤压）：直接跟随，禁双重平滑
  if (
    next.clientHeight !== prev.clientHeight ||
    next.clientWidth !== prev.clientWidth
  ) {
    return NO_SMOOTH;
  }
  const totalChanged = next.scrollHeight !== prev.scrollHeight;
  if (!totalChanged) return NO_SMOOTH;
  const topChanged = next.scrollTop !== prev.scrollTop;
  // 纯总高阶跃（虚拟器离散提交新总高、展开/折叠落点帧）：尺寸与位置同平滑
  if (!topChanged) return { sizeSmooth: true, offsetSmooth: true };
  // 总高与位置同帧变化（流式贴底增长等）：尺寸平滑，位置 1:1 跟随已提交的
  // scrollTop——位置本身由内容侧逐帧补偿驱动，再叠过渡只会让滑块撒谎。
  return { sizeSmooth: true, offsetSmooth: false };
}

/** data-smooth 取值：与 ChatOverlayScrollbar.module.css 的过渡门控一一对应 */
export function smoothModeOf(decision: ThumbSyncDecision): 'both' | 'size' | 'none' {
  if (decision.sizeSmooth && decision.offsetSmooth) return 'both';
  if (decision.sizeSmooth) return 'size';
  return 'none';
}
