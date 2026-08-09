// ============================================================
// 装饰层统一：DecorationSet（R5 集成轮 R5-D，06-扩展功能-技术维度 §2）
// ============================================================
// 背景：activeState（props 逐层传）+ 选区高亮（独立矩形层）+ 未来搜索
// 高亮，此前是三个机制三套实现——加一种高亮类型就要动 props 链。
// 本模块借鉴 CM6 RangeSet 的区间装饰思路
// （reference/compare/codemirror-view/src/decoration.ts：装饰 = 带
// from/to 的区间对象，集合按位置组织供高效查询），按本引擎行级渲染
// 模型轻量化：
// - 坐标空间：from/to 为全局字符偏移，与 store 的 cursorPos/selection
//   同一坐标空间（不做行内局部坐标换算）；
// - 存储结构：按行 bucket（Map<行号, Decoration[]>）——每行 bucket 只
//   持有所覆盖行的装饰，跨行装饰在每个跨行 bucket 里持有同一对象
//   引用（区间判定由 query 统一负责，无需裁剪复制）；
// - 增量维护：add 只写新区间跨行 bucket、remove 只清该 kind 涉及的
//   行（kindLines 索引）——光标/选区/搜索变化 O(受影响行)，不触碰全文
//   （06 §2「光标/选区变化只更新 DecorationSet（O(受影响行)）」）；
// - 行边界解析：字符偏移 → 行号经宿主注入的 findLineIndex 解析器
//   （store 的 LineOffsetTree 是权威增量行边界，本类不复制行边界状态）。
//
// 接入（数据源统一）：
// - MarkdownEngine：光标/选区/搜索变化 → 维护本集 → 行渲染时
//   query(行范围) 派生 activeState / 行级 class（旧 selector 逻辑迁移）；
// - SelectionHighlight：选区矩形消费 getKind('selection')（替代 store
//   selectionStart/End 直读）；
// - 宿主搜索：addSearchRange / clearSearch（05 高频项接入点，本轮
//   渲染路径为行级 class 预留）。

/** 装饰种类：active = 光标（选区折叠）/ selection = 选区 / search = 搜索
 * 高亮 / custom = 宿主自定义（统一数据层的扩展位） */
export type DecorationKind = 'active' | 'selection' | 'search' | 'custom';

/** 单条装饰：全局字符偏移区间 + 种类 */
export interface Decoration {
  /** 装饰区间起点（全局字符偏移，含） */
  from: number;
  /** 装饰区间终点（全局字符偏移，不含；零长度合法——光标装饰） */
  to: number;
  kind: DecorationKind;
}

/** 行索引解析器（字符偏移 → 所在行号）：宿主注入 LineOffsetTree 的
 * findLineIndex（SegmentTree.ts:104 语义：pos 恰在行首时归属该行）。 */
export interface DecorationLineResolver {
  findLineIndex(pos: number): number;
}

/** 空装饰列表共享引用（getKind 对无装饰种类返回，避免逐次分配） */
const EMPTY_DECORATIONS: readonly Decoration[] = [];

/**
 * 装饰集：active/选区/搜索统一的区间装饰存储（增量维护、行级 bucket）。
 * 非响应式可变结构——维护方（引擎/独立选区组件）在光标/选区/搜索变化时
 * 调用 add/remove 更新，并经版本号驱动消费方重查（见 MarkdownEngine）。
 */
export class DecorationSet {
  /** 行级 bucket：行号 → 该行覆盖的装饰（Map 键插入序 = 首次装饰行序） */
  private readonly buckets = new Map<number, Decoration[]>();
  /** 种类 → 涉及行集合：remove(kind) 只扫该种类涉及的行，增量清除 */
  private readonly kindLines = new Map<DecorationKind, Set<number>>();
  /** 种类 → 装饰列表（插入序）：getKind O(1)（选区单例读取 / 搜索区间枚举） */
  private readonly byKind = new Map<DecorationKind, Decoration[]>();

  /** 行索引解析器（构造注入，只读） */
  private readonly resolver: DecorationLineResolver;

  constructor(resolver: DecorationLineResolver) {
    this.resolver = resolver;
  }

  /** 已装饰行 bucket 数（增量维护的规模上界，调试/巡检口径） */
  get bucketCount(): number {
    return this.buckets.size;
  }

  /**
   * 添加装饰区间 [from, to)。零长度（from === to，光标装饰）合法。
   * 防御性归一化：反向区间对调、负起点钳 0、区间整体在文档外时忽略
   * （store 侧已钳制，此处兜底）。同一区间重复 add 不去重——调用方
   * 应遵循「先 remove(kind) 再 add」的增量重建约定（applyCursorSelection
   * Decorations 即如此）。
   */
  add(from: number, to: number, kind: DecorationKind): void {
    let f = from;
    let t = to;
    if (f > t) {
      // 反向区间对调（选区/搜索区间可能反向传入）
      const tmp = f;
      f = t;
      t = tmp;
    }
    f = Math.max(0, f);
    if (t < f) return; // 区间整体在文档范围外（起点钳 0 后终点仍在前方）

    const dec: Decoration = { from: f, to: t, kind };
    // 跨行区间：从起始行到终止行逐 bucket 持有同一装饰对象引用
    // （to 为开区间：to-1 是区间最后字符；零长度时退化为单行）
    const firstLine = this.resolver.findLineIndex(f);
    const lastLine = this.resolver.findLineIndex(Math.max(f, t - 1));

    let lines = this.kindLines.get(kind);
    if (!lines) {
      lines = new Set<number>();
      this.kindLines.set(kind, lines);
    }
    let kindList = this.byKind.get(kind);
    if (!kindList) {
      kindList = [];
      this.byKind.set(kind, kindList);
    }
    for (let li = firstLine; li <= lastLine; li++) {
      let bucket = this.buckets.get(li);
      if (!bucket) {
        bucket = [];
        this.buckets.set(li, bucket);
      }
      bucket.push(dec);
      lines.add(li);
    }
    kindList.push(dec);
  }

  /**
   * 移除指定种类的全部装饰（增量：只扫该种类涉及的行 bucket，
   * 其他种类不受影响；无该种类装饰时为空操作）。幂等。
   */
  remove(kind: DecorationKind): void {
    const lines = this.kindLines.get(kind);
    if (!lines || lines.size === 0) return;
    for (const li of lines) {
      const bucket = this.buckets.get(li);
      if (!bucket) continue;
      // 原地过滤：仅剔除该种类装饰，保留其他种类（选区/搜索互不干扰）
      let w = 0;
      for (let i = 0; i < bucket.length; i++) {
        if (bucket[i].kind !== kind) bucket[w++] = bucket[i];
      }
      bucket.length = w;
      if (bucket.length === 0) this.buckets.delete(li);
    }
    lines.clear();
    const kindList = this.byKind.get(kind);
    if (kindList) kindList.length = 0;
  }

  /**
   * 区间查询：返回与 [lineStart, lineEnd] 相交的装饰（行范围 = 行的
   * 字符区间，LineItem 渲染时传 query(行首偏移, 行首偏移 + 行长)）。
   * 判定谓词与旧 LineItem selector（MarkdownEngine.tsx 迁移前）逐分支
   * 等价——闭区间语义，行为零变化：
   * - 零长度装饰（光标 [p,p]）：p ∈ [lineStart, lineEnd]（两端含）；
   * - 非零装饰 [from, to)：from ≤ lineEnd 且 (to > lineStart 或
   *   from ≥ lineStart)——即旧「选区：lineStart < e 且 lineEnd ≥ s」
   *   的不对称边界语义（选区终点恰在行首的行不活动、选区起点恰在
   *   行尾的行活动）。
   * 返回新数组（查询结果视图）；跨多行区间时合并各跨行 bucket 命中。
   */
  query(lineStart: number, lineEnd: number): Decoration[] {
    if (lineEnd < lineStart) return [];
    const firstLine = this.resolver.findLineIndex(Math.max(0, lineStart));
    const lastLine = this.resolver.findLineIndex(Math.max(Math.max(0, lineStart), lineEnd - 1));
    const out: Decoration[] = [];
    // 跨行区间去重：同一装饰对象会出现在其覆盖的每个跨行 bucket，
    // 合并查询时按对象引用去重（单行查询天然无重复，零开销）
    const seen = firstLine === lastLine ? null : new Set<Decoration>();
    for (let li = firstLine; li <= lastLine; li++) {
      const bucket = this.buckets.get(li);
      if (!bucket) continue;
      for (const dec of bucket) {
        if (dec.from <= lineEnd && (dec.to > lineStart || dec.from >= lineStart)) {
          if (seen) {
            if (seen.has(dec)) continue;
            seen.add(dec);
          }
          out.push(dec);
        }
      }
    }
    return out;
  }

  /**
   * 按种类取装饰列表（插入序；selection/active 为单例约定，search 可
   * 多区间）。返回内部引用，调用方不得就地修改；无该种类时返回共享
   * 空数组（不分配）。
   */
  getKind(kind: DecorationKind): readonly Decoration[] {
    return this.byKind.get(kind) ?? EMPTY_DECORATIONS;
  }

  /** 搜索高亮接入点（05 高频项：宿主搜索——统一进装饰层）。 */
  addSearchRange(from: number, to: number): void {
    this.add(from, to, 'search');
  }

  /** 清空全部搜索高亮（宿主搜索词清空/切换场景）。 */
  clearSearch(): void {
    this.remove('search');
  }

  /** 清空全部装饰（宿主文档重置/重载场景）。 */
  clear(): void {
    this.buckets.clear();
    this.kindLines.clear();
    this.byKind.clear();
  }
}

/**
 * 光标/选区 → active/selection 装饰的统一派生（纯函数，幂等）：
 * - 有选区（selectionStart ≠ selectionEnd）→ 只写 selection 装饰
 *   （旧语义：行活动性只看选区区间，光标位置不参与活动判定）；
 * - 选区折叠 → 只写 active 装饰（零长度光标区间，闭区间命中所在行）。
 * 引擎（MarkdownEngine 维护）与独立选区组件（SelectionHighlight
 * 自维护兜底）共用同一派生规则——同一 store 状态必然产生同一装饰集。
 */
export function applyCursorSelectionDecorations(
  decorations: DecorationSet,
  cursorPos: number,
  selectionStart: number,
  selectionEnd: number
): void {
  decorations.remove('active');
  decorations.remove('selection');
  const s = Math.min(selectionStart, selectionEnd);
  const e = Math.max(selectionStart, selectionEnd);
  if (s !== e) {
    decorations.add(s, e, 'selection');
  } else {
    decorations.add(cursorPos, cursorPos, 'active');
  }
}
