// ── A5 渲染分层 L3：Canvas 只读层预留接缝（P3 B5，本轮只留接口不实现）──
// 设计依据：docs/analysis/plan-A5-渲染分层.md §3.2（架构接缝：渲染器注册位，
// 复用 BlockRendererRegistry 同构的注册表模式）。Canvas 层触发条件 =
// readOnly && 行数超阈值 && 注册表存在——任一不满足走 DOM（普适性由 DOM
// 回退兜底，A5 §3.1）。DOM 实现 = 现 LineItem 通道的封装位（本轮空操作，
// 行为零变化）。与 L2 GPU 层正交：RowSurface 的 DOM 实现即「L2 之后的现
// LineItem 通道」，Canvas 行定位复用 HeightMap（已就绪，A5 §1.2-4）。

/** 引擎渲染模式：'dom' = 现 LineItem 虚拟化行通道（缺省，永不缺省路径）；
 *  'canvas' = Canvas 只读层（预留，未实现——注册表空时判定恒回落 dom）。 */
export type RenderMode = 'dom' | 'canvas';

/** 行表面操作的窗口行轻量描述（与 tanstack VirtualItem 解耦——核心层
 *  不依赖 react-virtual 类型；取 index/start/size/key 四字段即够行定位，
 *  key 为虚拟化窗口复用节点身份的语义载体）。 */
export interface RowSurfaceItem {
  /** 逻辑行号（与 HeightMap/行号坐标系一致） */
  index: number;
  /** 行首像素偏移（逻辑坐标，HeightMap 前缀和口径） */
  start: number;
  /** 行高（像素） */
  size: number;
  /** 行唯一键（虚拟化节点身份，窗口挂载/复用判定用） */
  key: string;
}

/** 行表面抽象（A5 §3.2 预留签名，四方法）：
 *  - mountRows：窗口变化挂载行（DOM 实现 = LineItem 挂载通道）；
 *  - updateRows：行内容/装饰变化（dirty/行版本 bump）增量刷新；
 *  - unmountRows：行离开窗口（卸载，纹理/节点随窗口释放）；
 *  - locateRow：像素 → 行号（走 HeightMap.indexAt 二分，A5 §3.1）。 */
export interface RowSurface {
  readonly mode: RenderMode;
  mountRows(items: readonly RowSurfaceItem[]): void;
  updateRows(changed: readonly number[]): void;
  unmountRows(indices: readonly number[]): void;
  locateRow(pixelY: number): number | null;
}

/** 行表面工厂：入参为行挂载容器（滚动内容 div）；实现内自检能力
 * （canvas.getContext/字体就绪），失败返回 null → 引擎回落 DOM——
 * 混合渲染使回退粒度天然是「行」，不是全文档二值开关（A5 §3.1）。 */
export type RowSurfaceFactory = (container: HTMLElement) => RowSurface | null;

/** Canvas 只读层启用的行数阈值（A5 §3.1 建议 ≥5 万行，或 行数 × 平均
 *  行高 > 视口高 × 100——可配置常量；编辑器模式（readOnly=false）永不启用） */
export const CANVAS_LINE_COUNT_THRESHOLD = 50_000;

// 行表面注册表（BlockRendererRegistry 同构的注册位语义：后续 Canvas 层
// 立项时经 registerRowSurface('canvas', factory) 注入实现；'dom' 键保留
// 可覆盖位——默认 DOM 实现由 createDomRowSurface 提供，不预注册）
const rowSurfaceFactories = new Map<RenderMode, RowSurfaceFactory>();

/** 注册行表面实现（'canvas' 预留；'dom' 键可覆盖默认，不推荐——DOM
 *  通道由引擎内建，覆盖仅作宿主定制）。重复注册同模式 = 覆盖。 */
export function registerRowSurface(
  mode: RenderMode,
  factory: RowSurfaceFactory
): void {
  rowSurfaceFactories.set(mode, factory);
}

/** 注销行表面实现（回落到默认 DOM 通道） */
export function unregisterRowSurface(mode: RenderMode): void {
  rowSurfaceFactories.delete(mode);
}

/** 查询行表面工厂（未注册返回 null） */
export function getRowSurfaceFactory(
  mode: RenderMode
): RowSurfaceFactory | null {
  return rowSurfaceFactories.get(mode) ?? null;
}

// 空操作实现（共享函数引用——mount/update/unmount 三方法零行为）
function noopSurfaceAction(): void {
  // DOM 行表面空操作：现 LineItem 通道已覆盖挂载/更新/卸载，接缝位
  // 不叠加任何行为（A5 §3.2 要点 1：DOM 实现 = 现 LineItem 通道原样封装）
}

/** 默认 DOM 行表面（空操作封装位）：mount/update/unmount 三方法对应
 *  现有渲染/装饰/卸载三处调用点，locateRow 走引擎既有 HeightMap 定位
 *  （此处返回 null = 未接管，调用方走既有定位链路）——本轮不改变任何
 *  渲染行为，仅把「行表面」抽象落位供后续 Canvas 层切换（A5 §5.3
 *  诚实边界：canvas 模式未启用时行为零变化）。 */
export function createDomRowSurface(_container: HTMLElement): RowSurface {
  return {
    mode: 'dom',
    mountRows: noopSurfaceAction,
    updateRows: noopSurfaceAction,
    unmountRows: noopSurfaceAction,
    locateRow: () => null,
  };
}

/** 渲染模式判定（触发条件登记，A5 §3.1/§5.2）：
 *  requested 缺省 = 自动判定：canvas = readOnly && 行数 ≥ 阈值 &&
 *  'canvas' 注册表存在——任一不满足走 DOM（缺省 'dom'，非默认路径；
 *  当前 Canvas 层未立项恒得 'dom'）。
 *  requested 显式 'dom' = 宿主强制 DOM（引擎 prop 缺省值，零行为变化）；
 *  requested 显式 'canvas' = 宿主意图声明，仍须通过上述三条件门禁，
 *  任一不满足回落 'dom'——Canvas 未实现/未注册时的登记语义（A5 §3.2
 *  要点 3：普适性由 DOM 回退兜底）。
 *  阈值经 threshold 可配置（缺省 CANVAS_LINE_COUNT_THRESHOLD）。 */
export function resolveRenderMode(opts: {
  readOnly: boolean;
  lineCount: number;
  threshold?: number;
  requested?: RenderMode;
}): RenderMode {
  if (opts.requested === 'dom') return 'dom';
  const threshold = opts.threshold ?? CANVAS_LINE_COUNT_THRESHOLD;
  if (
    opts.readOnly &&
    opts.lineCount >= threshold &&
    getRowSurfaceFactory('canvas') !== null
  ) {
    return 'canvas';
  }
  return 'dom';
}
