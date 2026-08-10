/**
 * 输入归一化纯函数层（P1-B1：坐标映射 / 滚轮归一化 / 修饰键 / 点击计数）。
 * 零副作用，可独立单测。对齐 12 文档 §1.3/§3.1/§3.4/§3.5。
 */

/** contain 等比缩放（12 文档 §2.3：object-fit: contain 同语义，居中留黑边）。 */
export interface ContainFit {
  /** 显示缩放比（min(cssW/imgW, cssH/imgH)） */
  scale: number;
  /** 居中偏移（CSS px） */
  offsetX: number;
  offsetY: number;
  displayWidth: number;
  displayHeight: number;
}

/**
 * 计算帧图在画布中的 contain 布局。画布尺寸为 0 或帧尺寸缺失时返回
 * 单位缩放 + 零偏移（坐标退化为画布直接映射，防御脏状态）。
 */
export function containFit(
  canvasCssWidth: number,
  canvasCssHeight: number,
  imgWidth: number,
  imgHeight: number,
): ContainFit {
  if (
    !canvasCssWidth ||
    !canvasCssHeight ||
    !imgWidth ||
    !imgHeight
  ) {
    return {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      displayWidth: imgWidth,
      displayHeight: imgHeight,
    };
  }
  const scale = Math.min(canvasCssWidth / imgWidth, canvasCssHeight / imgHeight);
  const displayWidth = imgWidth * scale;
  const displayHeight = imgHeight * scale;
  return {
    scale,
    offsetX: (canvasCssWidth - displayWidth) / 2,
    offsetY: (canvasCssHeight - displayHeight) / 2,
    displayWidth,
    displayHeight,
  };
}

/**
 * 面板 CSS 坐标 → 页面坐标（12 文档 §2.6：单一比例换算）。
 *
 * 语义：emulation 锁定 `setDeviceMetricsOverride(width=面板内容区, dsf=1)`
 * 后 pageScaleFactor=1、帧图 = 视口 CSS 像素——页面坐标与帧图同坐标系，
 * 仅需按画布显示比例换算 + 减去留边：`page = (panel - offset) / scale`。
 * 不用 metadata.scrollOffset 动态换算（锁 1:1 后恒为 0，仅留诊断）。
 */
export function panelPointToPagePoint(
  panelX: number,
  panelY: number,
  fit: ContainFit,
): { x: number; y: number } {
  return {
    x: (panelX - fit.offsetX) / fit.scale,
    y: (panelY - fit.offsetY) / fit.scale,
  };
}

/**
 * 滚轮 delta 归一化为像素（12 文档 §3.4）：
 * - deltaMode 0：像素直用；
 * - deltaMode 1：行 ×16；
 * - deltaMode 2：页 ×视口高度（前端以画布 CSS 高度近似）。
 * ctrl+wheel 保留 ctrl 修饰位 → Chrome 原生页面缩放行为（CDP 注入同样触发）。
 */
export function normalizeWheelDelta(
  deltaMode: number,
  deltaX: number,
  deltaY: number,
  viewportHeight: number,
): { deltaX: number; deltaY: number } {
  if (deltaMode === 1) {
    return { deltaX: deltaX * 16, deltaY: deltaY * 16 };
  }
  if (deltaMode === 2) {
    return { deltaX: deltaX * viewportHeight, deltaY: deltaY * viewportHeight };
  }
  return { deltaX, deltaY };
}

/** buttons 位掩码（12 文档 §3.2：1=左 2=右 4=中 8=back 16=forward）。 */
export function pointerButtonsMask(buttons: number): number {
  return buttons & 0b11111;
}

/** CDP modifiers（12 文档 §3.1：1=Alt 2=Ctrl 4=Meta 8=Shift）。 */
export function cdpModifiers(
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
  meta: boolean,
): number {
  return (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
}

/**
 * 点击计数状态机（12 文档 §3.5）：press 与上一次 press 位移 < 5px 且
 * 间隔 < 500ms → clickCount 递增；超过阈值 → 重置 1 重新起算。
 */
export class ClickCounter {
  private count = 0;
  private lastDown = { x: 0, y: 0, t: 0 };

  /** 按下事件推进：返回本次 clickCount（1=单击 2=双击 3=三击…）。 */
  down(x: number, y: number, now = Date.now()): number {
    if (
      this.count > 0 &&
      now - this.lastDown.t < 500 &&
      Math.hypot(x - this.lastDown.x, y - this.lastDown.y) < 5
    ) {
      this.count += 1;
    } else {
      this.count = 1;
    }
    this.lastDown = { x, y, t: now };
    return this.count;
  }

  /** 重置（拖出面板 / 失焦兜底）。 */
  reset(): void {
    this.count = 0;
    this.lastDown = { x: 0, y: 0, t: 0 };
  }
}
