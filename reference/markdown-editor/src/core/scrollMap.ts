/**
 * ScrollMap：逻辑↔物理滚动高度分段映射（P3 B1 scroll factor）。
 *
 * 背景：浏览器滚动高度上限约 3350 万 px——百万行 × 28px ≈ 2800 万 px 接近触顶，
 * 120 万行以上必踩。方案 B（plan-A1 §4.2）：分段线性映射——
 *   - 视口上方恒等（f(0)=0 强制）＋ 视口段 1:1（光标/点击/测量零偏差）
 *   - 视口下方压缩（远端段映射到物理余量）
 *   - 锚点不变式 f(视口顶) = 物理 scrollTop：H 变化重参数化时视口零位移
 *   - 文末钳制（review-P3 高危②）：视口在文末时 1:1 区上界 min(v+vh+m, H−m)，
 *     压缩段为空（s 分母 ≤0）时直接恒等——拖到底不出空白
 *   - 恒等短路：总高 ≤ 阈值时零开销直通（f(x)=x）
 *
 * 消费方边界（plan-A1 §4.3）：HeightMap/行渲染 top/光标测量/点击定位/折叠/大纲
 * 全部保持逻辑坐标零改动；仅滚动容器层（scrollTop 读写的 13+3+3 处）经本类换算。
 */

export const SCROLL_PHYSICAL_CAP = 30_000_000; // 物理滚动高度上限（安全值，< 3350 万）
export const SCROLL_MAP_THRESHOLD = 30_000_000; // 总高超此启用映射（约 107 万行 × 28px）
const END_MARGIN = 1_000_000; // 文末 1:1 保留区（评审：min(v+vh+m, H−m) 的 m）

export class ScrollMap {
  private logicalHeight: () => number;
  private viewportHeight: () => number;

  constructor(logicalHeight: () => number, viewportHeight: () => number) {
    this.logicalHeight = logicalHeight;
    this.viewportHeight = viewportHeight;
  }

  /** 是否启用映射（恒等短路） */
  get enabled(): boolean {
    return this.logicalHeight() > SCROLL_MAP_THRESHOLD;
  }

  /** 逻辑 → 物理（分段线性；未启用时恒等） */
  apply(logicalTop: number): number {
    const H = this.logicalHeight();
    if (!this.enabled) return Math.max(0, Math.min(logicalTop, H));
    const vh = this.viewportHeight();
    // 当前逻辑视口顶 = 逻辑值本身（视口段恒等——见类注释）
    const v = Math.max(0, Math.min(logicalTop, H));
    // 文末钳制（评审高危②）：1:1 区上界 = min(v+vh+m, H−m)
    const oneToOneEnd = Math.min(v + vh + END_MARGIN, Math.max(vh, H - END_MARGIN));
    if (v <= oneToOneEnd) {
      // 视口在 1:1 区内（含文末）——恒等
      return v;
    }
    // 视口在 1:1 区之外（正常压缩区）——上方恒等、下方压缩
    const oneToOneTop = Math.min(v, oneToOneEnd);
    if (logicalTop <= oneToOneTop) return logicalTop; // 恒等区
    // 下方压缩：把 [oneToOneTop, H] 映射到 [oneToOneTop, P_MAX]
    const rest = H - oneToOneTop;
    const restPhys = SCROLL_PHYSICAL_CAP - oneToOneTop;
    if (rest <= 0 || restPhys <= 0) return logicalTop; // 退化恒等
    if (rest <= restPhys) return logicalTop; // 天然 fit 不压缩
    return oneToOneTop + (logicalTop - oneToOneTop) * (restPhys / rest);
  }

  /** 物理 → 逻辑（逆映射；未启用时恒等） */
  inverse(physicalTop: number): number {
    const H = this.logicalHeight();
    if (!this.enabled) return Math.max(0, Math.min(physicalTop, H));
    const vh = this.viewportHeight();
    const oneToOneEnd = Math.min(H, Math.max(vh, H - END_MARGIN));
    if (physicalTop <= oneToOneEnd) return physicalTop; // 恒等区
    const rest = H - oneToOneEnd;
    const restPhys = SCROLL_PHYSICAL_CAP - oneToOneEnd;
    if (rest <= 0 || restPhys <= 0) return physicalTop;
    if (rest <= restPhys) return physicalTop;
    return oneToOneEnd + (physicalTop - oneToOneEnd) * (rest / restPhys);
  }

  /** 物理总高（内容 div 高度） */
  physicalTotalHeight(): number {
    const H = this.logicalHeight();
    if (!this.enabled) return H;
    const vh = this.viewportHeight();
    const oneToOneEnd = Math.min(H, Math.max(vh, H - END_MARGIN));
    const rest = H - oneToOneEnd;
    const restPhys = SCROLL_PHYSICAL_CAP - oneToOneEnd;
    if (rest <= 0 || restPhys <= 0) return H;
    if (rest <= restPhys) return H;
    return oneToOneEnd + restPhys;
  }
}
