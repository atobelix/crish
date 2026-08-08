/**
 * ui/Menu/position.ts — 菜单/浮层坐标计算单源（PE-05 T05.1.4 / T05.3.1）
 *
 * 收敛说明（T05.3.1）：三套独立坐标实现全部统一到本文件——
 * 1. `clampContextMenuPosition`（SidebarContextMenus）→ `clampPosition`
 *    + `measureMenu`（先测真实尺寸再钳位）；
 * 2. `SettingsSelect updateCoords` → 由 Menu 基座 Radix 定位接管（已删除）；
 * 3. `PermissionModeMenu updateCoords`（含预估高度 140 的 hack）→
 *    由 Menu 基座 side/align 接管（已删除）。
 *
 * 纯函数：视口尺寸可注入（测试/SSR 友好），默认回退 1280×800。
 */

/** 菜单与视口边缘的最小留白 */
export const MENU_EDGE_PAD = 8;
/** 紧凑菜单预估尺寸（clamp 用；真实尺寸由布局后再微调） */
export const MENU_EST_WIDTH = 160;
export const MENU_EST_HEIGHT = 280;

export interface ClampedPosition {
  x: number;
  y: number;
  /** 进出场动画的 transform-origin（避让方向对应的锚点） */
  transformOrigin: string;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * 把请求坐标钳入视口并智能判断避让方向。
 *
 * @param x 请求横坐标（通常为鼠标 clientX 或触发器左下角）
 * @param y 请求纵坐标
 * @param menuW 菜单预估宽度
 * @param menuH 菜单预估高度
 * @param viewport 视口尺寸；缺省时读 window（不可用时回退 1280×800）
 */
export function clampPosition(
  x: number,
  y: number,
  menuW = MENU_EST_WIDTH,
  menuH = MENU_EST_HEIGHT,
  viewport?: ViewportSize
): ClampedPosition {
  const rawW = viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
  const rawH = viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
  const vw = rawW > 0 ? rawW : 1280;
  const vh = rawH > 0 ? rawH : 800;

  let finalX = x;
  let finalY = y;
  let originY = 'top';
  let originX = 'left';

  // 水平避让：右侧贴边则左翻，再钳入视口
  if (finalX + menuW > vw - MENU_EDGE_PAD) {
    finalX = finalX - menuW;
    originX = 'right';
  }
  finalX = Math.min(
    Math.max(MENU_EDGE_PAD, finalX),
    Math.max(MENU_EDGE_PAD, vw - menuW - MENU_EDGE_PAD)
  );

  // 垂直避让：底部贴边则上翻，再钳入视口
  if (finalY + menuH > vh - MENU_EDGE_PAD) {
    finalY = finalY - menuH;
    originY = 'bottom';
  }
  finalY = Math.min(
    Math.max(MENU_EDGE_PAD, finalY),
    Math.max(MENU_EDGE_PAD, vh - menuH - MENU_EDGE_PAD)
  );

  return {
    x: finalX,
    y: finalY,
    transformOrigin: `${originY} ${originX}`,
  };
}

/**
 * 先测量已渲染菜单元素的真实尺寸，再对其锚点坐标做视口钳位。
 *
 * 用途：菜单首帧挂载后（或 resize 后）按真实宽高重新钳位，
 * 替代「预估尺寸 → 渲染 → 再按真实尺寸修正」的手写两段式流程。
 * 行为与 `clampContextMenuPosition`（SidebarContextMenus）完全一致。
 */
export function measureMenu(
  el: HTMLElement,
  x: number,
  y: number,
  viewport?: ViewportSize
): ClampedPosition {
  const rect = el.getBoundingClientRect();
  // F7-F11：display:none / 未挂载元素 getBoundingClientRect 全 0——
  // 按 0 尺寸钳位等于不钳位（坐标原样放行 → 菜单溢出视口），
  // 回退预估尺寸保证钳位仍生效
  const w = rect.width > 0 ? rect.width : MENU_EST_WIDTH;
  const h = rect.height > 0 ? rect.height : MENU_EST_HEIGHT;
  return clampPosition(x, y, w, h, viewport);
}
