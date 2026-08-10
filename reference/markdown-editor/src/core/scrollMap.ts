/**
 * ScrollMap：逻辑↔物理滚动高度分段映射（P3 B1 scroll factor）。
 *
 * 背景：浏览器滚动高度上限约 3350 万 px——百万行 × 28px ≈ 2800 万 px 接近触顶，
 * 120 万行以上必踩。方案 B（plan-A1 §4.2）：全局固定分段线性映射——
 *   - 恒等区 [0, oneToOneEnd]：物理 = 逻辑（1:1，滚动/点击/光标零偏差）
 *   - 压缩区 [oneToOneEnd, H] → [oneToOneEnd, P_MAX]（远端压缩，分段线性）
 *   - oneToOneEnd = min(P_MAX − m, H)——以物理上限为基准（评审高危②修正：
 *     此前以 H−m 为界在 H > P_MAX 时 restPhys 为负导致不压缩超限）
 *   - 文末 H 映射到 P_MAX：滚动条拖到底 = 逻辑文末（无空白）
 *   - 恒等短路：总高 ≤ 阈值时零开销直通（f(x)=x）
 *
 * 消费方边界：HeightMap/行渲染 top/光标测量/点击定位/折叠/大纲全部保持
 * 逻辑坐标零改动；仅滚动容器层（scrollTop 读写的 13+3+3 处）经本类换算。
 */

export const SCROLL_PHYSICAL_CAP = 30_000_000; // 物理滚动高度上限（安全值，< 3350 万）
export const SCROLL_MAP_THRESHOLD = 30_000_000; // 总高超此启用映射（约 107 万行 × 28px）
const END_MARGIN = 1_000_000; // 恒等区到物理上限的保留余量（保证压缩区起点不贴顶）

export class ScrollMap {
  private logicalHeight: () => number;
  // viewportHeight 预留：动态视口锚定增强（A1 登记项）——当前分段为
  // 全局固定（恒等区以物理上限为基准），未消费视口高；保留签名兼容。
  private _viewportHeight: () => number;

  constructor(logicalHeight: () => number, viewportHeight: () => number) {
    this.logicalHeight = logicalHeight;
    this._viewportHeight = viewportHeight;
    void this._viewportHeight; // 预留字段标记（动态视口锚定增强时启用）
  }

  /** 是否启用映射（恒等短路） */
  get enabled(): boolean {
    return this.logicalHeight() > SCROLL_MAP_THRESHOLD;
  }

  /** 恒等区终点（以物理上限为基准，评审高危②修正） */
  private oneToOneEnd(): number {
    const H = this.logicalHeight();
    return Math.min(Math.max(0, SCROLL_PHYSICAL_CAP - END_MARGIN), H);
  }

  /** 逻辑 → 物理（分段线性；未启用时恒等） */
  apply(logicalTop: number): number {
    const H = this.logicalHeight();
    const x = Math.max(0, Math.min(logicalTop, H));
    if (!this.enabled) return x;
    const end = this.oneToOneEnd();
    if (x <= end) return x; // 恒等区
    const rest = H - end;
    const restPhys = SCROLL_PHYSICAL_CAP - end;
    if (rest <= 0 || restPhys <= 0) return x; // 退化恒等
    if (rest <= restPhys) return x; // 天然 fit 不压缩
    return end + (x - end) * (restPhys / rest);
  }

  /** 物理 → 逻辑（逆映射；未启用时恒等） */
  inverse(physicalTop: number): number {
    const H = this.logicalHeight();
    const p = Math.max(0, Math.min(physicalTop, SCROLL_PHYSICAL_CAP));
    if (!this.enabled) return Math.max(0, Math.min(p, H));
    const end = this.oneToOneEnd();
    if (p <= end) return p; // 恒等区
    const rest = H - end;
    const restPhys = SCROLL_PHYSICAL_CAP - end;
    if (rest <= 0 || restPhys <= 0) return p;
    if (rest <= restPhys) return p;
    return end + (p - end) * (rest / restPhys);
  }

  /** 物理总高（内容 div 高度）——恒等时 = 逻辑，否则 = 物理上限 */
  physicalTotalHeight(): number {
    const H = this.logicalHeight();
    if (!this.enabled) return H;
    const end = this.oneToOneEnd();
    if (H <= end) return H;
    const rest = H - end;
    const restPhys = SCROLL_PHYSICAL_CAP - end;
    if (rest <= 0 || restPhys <= 0) return H;
    if (rest <= restPhys) return H;
    return end + restPhys;
  }
}
