// ============================================================
// 光标坐标测量模块（性能优化版）
// ============================================================
// 历史背景（《01-性能帧率路线》问题 2）：旧实现每次调用
//   - querySelectorAll 全扫可见行 token 元素（视口 + overscan 数百节点）；
//   - 对每个候选 token 各读一次 getBoundingClientRect（强制 layout）；
//   - 每次调用新建 Range 对象，并对命中 token 执行一次 getComputedStyle；
//   且 CursorLayer 与 HiddenInput 各自对同一光标独立执行完整测量（双测量源），
//   被滚动产生的 layoutDeps 字符串变化高频触发。
// 本版优化（对齐《01-性能帧率路线》2.2 与《09-方案修订终版》测量契约）：
//   1. token → textNode 二分索引：索引经 WeakMap 挂在容器 DOM 上，
//      行挂载/卸载由 MutationObserver 增量维护（二分插入/批量过滤），
//      编辑/流式导致的 data-* 属性变化置脏后惰性重建，命中时校验属性自愈；
//   2. 单次 Range 测量：命中 token 后只建一次 Range（模块级单例复用），
//      fontSize 按 token 元素缓存（已测字体缓存），不再每 token 读样式；
//   3. 双测量源合并：同帧位置结果缓存（posCache），CursorLayer 与 HiddenInput
//      对同一光标的第二次调用零 DOM 读取直接命中（单测量源语义）；
//   4. token 级测量缓存：存"容器内容坐标系"（与滚动解耦），同一 token 内
//      光标移动直接命中；索引重建时随条目一起废弃（等价于 lines 版本失效）。

export interface MeasuredRect {
  top: number;
  left: number;
  height: number;
  bottom: number;
}

export interface ContainerCoords {
  top: number;
  left: number;
  height: number;
  bottom: number;
}

// 同帧位置缓存容量：滚动帧每帧一条，超限清空防止长期滚动内存膨胀
const POS_CACHE_LIMIT = 16;
// 单 token 测量缓存容量：防超长 token 内大量偏移导致内存膨胀
const TOKEN_CACHE_LIMIT = 64;

// ============================================================
// 索引数据结构
// ============================================================

// token 内"参与测量计长"的文本节点表（相对 token 起点的字符区间）
interface TokenTextNode {
  textNode: Text;
  start: number;
  end: number;
}

interface TokenEntry {
  start: number; // 全局字符偏移（缓存值，命中时与元素实时属性校验）
  length: number;
  el: HTMLElement; // token 元素（data-token-start）
  lineEl: HTMLElement | null; // 所属行元素
  textTable: TokenTextNode[] | null; // 惰性构建的文本节点表
  measCache: Map<number, MeasuredRect> | null; // 行内偏移 → 容器内容坐标系测量
}

interface LineEntry {
  start: number;
  length: number;
  el: HTMLElement; // 行元素（data-line-start）
}

interface ContainerIndex {
  container: HTMLElement;
  isLine: boolean; // 容器自身是行元素（箭头导航几何回退传入的单行模式）
  tokens: TokenEntry[]; // 按 start 升序（稳定排序，同 start 保持 DOM 序）
  lines: LineEntry[]; // 按 start 升序
  byEl: WeakMap<HTMLElement, TokenEntry>; // 元素 → 条目（增量去重）
  dirty: boolean; // MutationObserver 置位的整体失效标记（惰性重建）
  posCache: Map<string, MeasuredRect>; // `${index}:${scrollTop}:${scrollLeft}` → 视口坐标
  observer: MutationObserver | null;
}

// 容器 → 索引（WeakMap：容器被回收时索引随之释放，行级索引同理）
const indexMap = new WeakMap<HTMLElement, ContainerIndex>();

// token 元素 → 已测字号（字体度量缓存：不再每 token 每帧 getComputedStyle）
const tokenFontSizeCache = new WeakMap<HTMLElement, number>();

// 模块级单例 Range（复用实例，避免每次测量新建 Range 分配）
let sharedRangeInstance: Range | null = null;

function getSharedRange(): Range {
  if (!sharedRangeInstance) sharedRangeInstance = document.createRange();
  return sharedRangeInstance;
}

// 读取元素属性为整数（属性缺失时返回给定默认值，与旧实现 parseInt 语义一致）
function attrInt(el: Element, name: string, def: string = '0'): number {
  return parseInt(el.getAttribute(name) || def, 10);
}

// ============================================================
// 索引构建与维护
// ============================================================

// 构建容器级或行级索引：收集 token/行条目、排序、填充行归属、挂载观察器
function buildIndex(container: HTMLElement): ContainerIndex {
  const isLine = container.hasAttribute('data-line-start');
  const tokens: TokenEntry[] = [];
  const lines: LineEntry[] = [];
  const byEl = new WeakMap<HTMLElement, TokenEntry>();

  if (isLine) {
    // 单行模式：容器自身即行元素（getArrowNavigationIndex 几何回退传入的行元素）
    lines.push({
      start: attrInt(container, 'data-line-start'),
      length: attrInt(container, 'data-line-length'),
      el: container,
    });
    scanTokens(container, tokens, byEl, container);
  } else {
    const lineEls = container.querySelectorAll('[data-line-start]');
    for (let i = 0; i < lineEls.length; i++) {
      const el = lineEls[i] as HTMLElement;
      lines.push({
        start: attrInt(el, 'data-line-start'),
        length: attrInt(el, 'data-line-length'),
        el,
      });
    }
    lines.sort((a, b) => a.start - b.start);
    scanTokens(container, tokens, byEl, null);
    fillLineRefs(tokens, lines);
  }

  // 稳定排序：同 start 的条目保持 DOM 序（外层 token 在前，与旧遍历语义一致）
  tokens.sort((a, b) => a.start - b.start);

  const idx: ContainerIndex = {
    container,
    isLine,
    tokens,
    lines,
    byEl,
    dirty: false,
    posCache: new Map(),
    observer: null,
  };
  attachObserver(idx);
  return idx;
}

// 全扫子树内的 token 元素（仅构建/重建时使用）
function scanTokens(
  root: HTMLElement,
  out: TokenEntry[],
  byEl: WeakMap<HTMLElement, TokenEntry>,
  fixedLineEl: HTMLElement | null
): void {
  const els = root.querySelectorAll('[data-token-start]');
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as HTMLElement;
    if (byEl.has(el)) continue;
    const t: TokenEntry = {
      start: attrInt(el, 'data-token-start'),
      length: attrInt(el, 'data-token-length'),
      el,
      lineEl: fixedLineEl,
      textTable: null,
      measCache: null,
    };
    byEl.set(el, t);
    out.push(t);
  }
}

// 双指针：按 token 起点归属到所在行（构建时一次完成，避免逐 token 上溯祖先）
function fillLineRefs(tokens: TokenEntry[], lines: LineEntry[]): void {
  let li = 0;
  for (const t of tokens) {
    while (li + 1 < lines.length && lines[li + 1].start <= t.start) li++;
    if (li < lines.length && t.start <= lines[li].start + lines[li].length) {
      t.lineEl = lines[li].el;
    }
  }
}

// 挂载 MutationObserver：
// - childList（subtree）：行挂载/卸载的 token 增删 → 增量维护（二分插入/批量过滤）；
// - attributes（仅 data-* 定位属性）：编辑/流式导致的偏移变化 → 整体置脏，惰性重建。
function attachObserver(idx: ContainerIndex): void {
  const addedTokens: TokenEntry[] = [];
  const addedLines: LineEntry[] = [];
  const removedEls = new Set<HTMLElement>();

  const collectAdded = (node: Node): void => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.hasAttribute('data-line-start')) {
      addedLines.push({
        start: attrInt(el, 'data-line-start'),
        length: attrInt(el, 'data-line-length'),
        el,
      });
    }
    if (el.hasAttribute('data-token-start') && !idx.byEl.has(el)) {
      addedTokens.push({
        start: attrInt(el, 'data-token-start'),
        length: attrInt(el, 'data-token-length'),
        el,
        lineEl: idx.isLine ? idx.container : (el.closest('[data-line-start]') as HTMLElement | null),
        textTable: null,
        measCache: null,
      });
    }
    for (let i = 0; i < el.childNodes.length; i++) collectAdded(el.childNodes[i]);
  };

  const collectRemoved = (node: Node): void => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.hasAttribute('data-token-start') || el.hasAttribute('data-line-start')) {
      removedEls.add(el);
    }
    for (let i = 0; i < el.childNodes.length; i++) collectRemoved(el.childNodes[i]);
  };

  const observer = new MutationObserver((mutations) => {
    let structural = true;
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) collectAdded(node);
        for (const node of m.removedNodes) collectRemoved(node);
      } else {
        // 定位属性变化（编辑/流式/行插入导致的偏移平移）→ 整体失效
        structural = false;
        idx.dirty = true;
      }
    }
    if (!structural) return;

    // 应用增量：先插行、再插 token、最后批量过滤移除（保持数组有序）
    for (const l of addedLines) insertLineSorted(idx, l);
    for (const t of addedTokens) {
      idx.byEl.set(t.el, t);
      insertTokenSorted(idx, t);
    }
    if (removedEls.size > 0) {
      removeEntries(idx, removedEls);
    }
    addedTokens.length = 0;
    addedLines.length = 0;
    removedEls.clear();
  });

  observer.observe(idx.container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'data-token-start',
      'data-token-length',
      'data-line-start',
      'data-line-length',
    ],
  });
  idx.observer = observer;
}

// 行条目二分插入（按 start 升序；同 start 插入段尾，保持 DOM 序）
function insertLineSorted(idx: ContainerIndex, line: LineEntry): void {
  const arr = idx.lines;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start <= line.start) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, line);
}

// token 条目二分插入（按 start 升序；同 start 插入段尾，保持 DOM 序）
function insertTokenSorted(idx: ContainerIndex, t: TokenEntry): void {
  const arr = idx.tokens;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start <= t.start) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, t);
}

// 批量移除条目（单趟过滤，保持数组有序）
function removeEntries(idx: ContainerIndex, removedEls: Set<HTMLElement>): void {
  const tokens = idx.tokens;
  let w = 0;
  for (let r = 0; r < tokens.length; r++) {
    if (removedEls.has(tokens[r].el)) {
      idx.byEl.delete(tokens[r].el);
      continue;
    }
    tokens[w++] = tokens[r];
  }
  tokens.length = w;

  const lines = idx.lines;
  let wl = 0;
  for (let r = 0; r < lines.length; r++) {
    if (removedEls.has(lines[r].el)) continue;
    lines[wl++] = lines[r];
  }
  lines.length = wl;
}

// 取容器索引：缺失时构建，置脏时惰性重建（编辑/流式后的首帧）
function getIndex(container: HTMLElement): ContainerIndex {
  let idx = indexMap.get(container);
  if (!idx) {
    idx = buildIndex(container);
    indexMap.set(container, idx);
  } else if (idx.dirty) {
    rebuildIndex(idx);
    idx = indexMap.get(container) as ContainerIndex;
  }
  return idx;
}

// 重建索引：摘除旧观察器后整体重扫（保留缓存失效语义：新条目即新测量缓存）
function rebuildIndex(idx: ContainerIndex): void {
  idx.observer?.disconnect();
  const fresh = buildIndex(idx.container);
  indexMap.set(idx.container, fresh);
}

// ============================================================
// 命中定位（二分，替代全扫）
// ============================================================

// 二分定位：优先"包含 index"的可见 token（DOM 序第一个，即最外层），
// 其次"恰好结束于 index"的可见 token（DOM 序最后一个，对齐旧遍历语义）。
function locateToken(idx: ContainerIndex, index: number): TokenEntry | null {
  const tokens = idx.tokens;
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start <= index) lo = mid + 1;
    else hi = mid;
  }

  // 主命中：包含 index 的连续区间（数组序 = DOM 序），取第一个可见的
  let left = lo - 1;
  while (left >= 0 && tokens[left].start + tokens[left].length > index) left--;
  left++;
  for (let j = left; j < lo; j++) {
    if (isTokenVisible(tokens[j].el)) return tokens[j];
  }

  // 尾部命中：start + length === index 的条目，从右向左取第一个可见的（DOM 序最后）
  for (let j = lo - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.start + t.length < index) break;
    if (t.start + t.length === index && isTokenVisible(t.el)) return t;
  }

  return null;
}

// 可见性检查：跳过 CSS 隐藏（高度 0）的 token（如渲染替代对中的空占位元素）
function isTokenVisible(el: HTMLElement): boolean {
  return el.getBoundingClientRect().height > 0;
}

// 命中后校验元素实时属性：React 渲染已更新 data-* 而 MutationObserver
// 尚未回调（同一帧内）时，以实时属性为准并强制重建索引
function validateEntry(t: TokenEntry): boolean {
  return (
    attrInt(t.el, 'data-token-start') === t.start &&
    attrInt(t.el, 'data-token-length') === t.length
  );
}

// ============================================================
// token 内文本节点定位（惰性建表 + 二分）
// ============================================================

// 构建 token 内"参与测量计长"的文本节点表。
// 跳过渲染替代/预览内容（syntax-content / data-ignore-measure / katex /
// math-preview），与旧 findNodeAndOffset 的跳过语义保持一致；
// syntax-hidden 的源码文本计入长度（与旧实现一致）。
function buildTextTable(root: Node, table: TokenTextNode[]): void {
  for (let i = 0; i < root.childNodes.length; i++) {
    const child = root.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      const len = child.nodeValue?.length || 0;
      const prev = table[table.length - 1];
      const start = prev ? prev.end : 0;
      table.push({ textNode: child as Text, start, end: start + len });
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (
        el.classList.contains('syntax-content') ||
        el.hasAttribute('data-ignore-measure') ||
        el.classList.contains('katex') ||
        el.classList.contains('math-preview')
      ) {
        continue;
      }
      buildTextTable(child, table);
    }
  }
}

// 二分定位目标偏移所在的文本节点。
// 边界语义与旧 findNodeAndOffset 一致：偏移恰在节点边界时归属前一节点末尾。
function locateTextNode(
  entry: TokenEntry,
  offsetInToken: number
): { textNode: Text; localOffset: number } | null {
  let table = entry.textTable;
  if (!table) {
    table = [];
    buildTextTable(entry.el, table);
    entry.textTable = table;
  }
  if (table.length === 0) return null;

  let lo = 0;
  let hi = table.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid].start < offsetInToken) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (ans === -1) {
    // 偏移在首个文本节点之前（token 开头）
    const node = table[0];
    return { textNode: node.textNode, localOffset: 0 };
  }
  const node = table[ans];
  if (node.end < offsetInToken) {
    // 偏移落在节点间隙（渲染替代处）：归到该节点末尾
    return { textNode: node.textNode, localOffset: node.end - node.start };
  }
  return { textNode: node.textNode, localOffset: offsetInToken - node.start };
}

// ============================================================
// 测量
// ============================================================

// 视口坐标系 → 容器内容坐标系（滚动无关，可跨滚动帧缓存）
function viewportToContent(r: MeasuredRect, container: HTMLElement): MeasuredRect {
  const cr = container.getBoundingClientRect();
  return {
    top: r.top - cr.top + container.scrollTop,
    left: r.left - cr.left + container.scrollLeft,
    height: r.height,
    bottom: r.bottom - cr.top + container.scrollTop,
  };
}

// 容器内容坐标系 → 视口坐标系（缓存命中时还原）
function contentToViewport(c: MeasuredRect, container: HTMLElement): MeasuredRect {
  const cr = container.getBoundingClientRect();
  return {
    top: c.top + cr.top - container.scrollTop,
    left: c.left + cr.left - container.scrollLeft,
    height: c.height,
    bottom: c.bottom + cr.top - container.scrollTop,
  };
}

// 已测字体缓存：token 元素 → 计算字号（首次读取 getComputedStyle，其后命中缓存）
function tokenFontSize(el: HTMLElement): number {
  let fs = tokenFontSizeCache.get(el);
  if (fs === undefined) {
    fs = parseFloat(window.getComputedStyle(el).fontSize) || 14;
    tokenFontSizeCache.set(el, fs);
  }
  return fs;
}

// 对命中 token 执行单次 Range 测量（字体度量走缓存）
function measureTokenOffset(
  idx: ContainerIndex,
  entry: TokenEntry,
  offsetInToken: number
): MeasuredRect | null {
  // 容器级走 token 级测量缓存（内容坐标系）；行级索引（箭头导航几何回退）不缓存
  if (!idx.isLine) {
    let cache = entry.measCache;
    if (!cache) {
      cache = new Map();
      entry.measCache = cache;
    }
    if (cache.size >= TOKEN_CACHE_LIMIT) cache.clear();
    const hit = cache.get(offsetInToken);
    if (hit) return contentToViewport(hit, idx.container);
  }

  const rect = measureTokenExact(entry, offsetInToken);
  if (!rect) return null;

  if (!idx.isLine) {
    const content = viewportToContent(rect, idx.container);
    (entry.measCache as Map<number, MeasuredRect>).set(offsetInToken, content);
  }
  return rect;
}

// 精确测量：文本节点定位 → 单次 Range（复用单例）→ 光标矩形
function measureTokenExact(
  entry: TokenEntry,
  offsetInToken: number
): MeasuredRect | null {
  const located = locateTextNode(entry, offsetInToken);
  let rect: {
    left: number;
    top: number;
    width: number;
    height: number;
    bottom?: number;
  } | null = null;

  if (located) {
    const range = getSharedRange();
    try {
      range.setStart(located.textNode, located.localOffset);
      range.setEnd(located.textNode, located.localOffset);
      const r = range.getBoundingClientRect();
      // 折叠 Range 返回 0x0（行尾等场景）时退回元素矩形，与旧实现一致
      if (r.height !== 0 || r.width !== 0) rect = r;
    } catch (e) {
      console.error('测量失败', e);
      rect = null;
    }
  }

  if (!rect) {
    const er = entry.el.getBoundingClientRect();
    if (er.height === 0) return null;
    const isStart = offsetInToken === 0;
    rect = {
      left: isStart ? er.left : er.right,
      top: er.top,
      width: 0,
      height: er.height,
      bottom: er.bottom,
    };
  }

  const fontSize = tokenFontSize(entry.el);
  const cursorHeight = fontSize * 1.15; // 略高于字体（与旧实现一致）
  return {
    top: rect.top + (rect.height - cursorHeight) / 2,
    left: rect.left,
    height: cursorHeight,
    bottom: rect.bottom ?? rect.top + rect.height,
  };
}

// 行级回退：空行/行尾无 token 命中时，用行矩形测量光标（空行统一标准字号）
function measureLineFallback(idx: ContainerIndex, index: number): MeasuredRect | null {
  const lines = idx.lines;
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= index) lo = mid + 1;
    else hi = mid;
  }
  for (let j = lo - 1; j >= 0; j--) {
    const line = lines[j];
    if (line.start + line.length < index) break;
    if (index <= line.start + line.length) {
      const rect = line.el.getBoundingClientRect();
      // 空行统一用标准字号，避免出现 28px 大光标（旧实现注释同款）
      const cursorHeight = 14 * 1.15;
      const topOffset = rect.top + ((rect.height || 28) - cursorHeight) / 2;
      return {
        top: topOffset,
        left: rect.left,
        height: cursorHeight,
        bottom: rect.bottom,
      };
    }
  }
  return null;
}

// 单次测量（含同帧结果缓存：合并 CursorLayer 与 HiddenInput 双测量源）
function measureOnce(idx: ContainerIndex, index: number): MeasuredRect | null {
  const container = idx.container;
  // 视口坐标对滚动敏感，缓存键带上滚动位置；同帧内第二次调用（双测量源）
  // 直接命中，零 DOM 读取
  const cacheKey = index + ':' + container.scrollTop + ':' + container.scrollLeft;
  if (idx.posCache.size >= POS_CACHE_LIMIT) idx.posCache.clear();
  const hit = idx.posCache.get(cacheKey);
  if (hit) return hit;

  const entry = locateToken(idx, index);
  let rect: MeasuredRect | null = null;
  if (entry) {
    // 命中后校验实时属性：编辑渲染已更新 data-* 而 MutationObserver 尚未
    // 回调（同一帧内）时强制重建，保证测量结果不基于过期偏移
    if (!validateEntry(entry)) {
      rebuildIndex(idx);
      return null;
    }
    rect = measureTokenOffset(idx, entry, index - entry.start);
  }
  if (!rect) rect = measureLineFallback(idx, index);
  if (rect) idx.posCache.set(cacheKey, rect);
  return rect;
}

// ============================================================
// 对外接口
// ============================================================

// 获取光标 index 处的物理坐标（视口坐标系）。
// 命中 token 后走索引二分 + 单次 Range；同一帧内重复调用（双测量源）
// 命中同帧位置缓存，实现"单次测量、结果共享"。
export function getCoordinatesFromIndex(
  index: number,
  container: HTMLElement | null
): MeasuredRect | null {
  if (!container) return null;
  const idx = getIndex(container);
  const rect = measureOnce(idx, index);
  if (rect) return rect;
  // 索引因失效重建后重试一次（重建发生在 measureOnce 内部时）
  const fresh = indexMap.get(container);
  if (fresh && fresh !== idx) return measureOnce(fresh, index);
  return null;
}

// 视口坐标 → 容器内容坐标（CursorLayer / HiddenInput 共享换算，消除重复代码）
export function toContainerCoords(
  rect: MeasuredRect,
  container: HTMLElement
): ContainerCoords {
  const cr = container.getBoundingClientRect();
  return {
    top: rect.top - cr.top + container.scrollTop,
    left: rect.left - cr.left + container.scrollLeft,
    height: rect.height,
    bottom: rect.bottom - cr.top + container.scrollTop,
  };
}

// 从 DOM 节点（含偏移）反推全局字符索引（选区/点击定位使用，非热路径）
export function getGlobalIndexFromDOMNode(
  node: Node,
  offset: number,
  container: HTMLElement
): number | null {
  let targetNode = node;
  const isText = node.nodeType === Node.TEXT_NODE;

  // 元素节点时偏移为子节点下标，指向子节点以正确解析 data-sub-offset
  if (!isText && offset >= 0 && offset < node.childNodes.length) {
    targetNode = node.childNodes[offset];
  }

  let el: HTMLElement | null =
    targetNode.nodeType === Node.TEXT_NODE
      ? targetNode.parentElement
      : (targetNode as HTMLElement);
  let foundTokenStart = -1;
  let lineStart = -1;

  while (el && el !== container) {
    if (el.hasAttribute('data-token-start') && foundTokenStart === -1) {
      foundTokenStart = attrInt(el, 'data-token-start', '-1');
    }
    if (el.hasAttribute('data-line-start') && lineStart === -1) {
      lineStart = attrInt(el, 'data-line-start', '-1');
    }
    el = el.parentElement;
  }

  if (foundTokenStart !== -1) {
    let subOffset = 0;
    let currentEl: HTMLElement | null =
      targetNode.nodeType === Node.TEXT_NODE
        ? targetNode.parentElement
        : (targetNode as HTMLElement);

    while (currentEl && currentEl !== container) {
      if (currentEl.hasAttribute('data-sub-offset')) {
        subOffset = attrInt(currentEl, 'data-sub-offset');
        break;
      }
      if (currentEl.hasAttribute('data-token-start')) {
        break;
      }
      currentEl = currentEl.parentElement;
    }

    return foundTokenStart + subOffset + (isText ? offset : 0);
  }

  if (lineStart !== -1) {
    return lineStart + (isText ? offset : 0);
  }

  return null;
}

export interface ActiveState {
  cursor: number;
  selStart?: number;
  selEnd?: number;
}

export function checkIsActive(
  start: number,
  len: number,
  activeState: ActiveState | null
): boolean {
  if (!activeState) return false;
  const end = start + len;
  if (activeState.selStart !== undefined && activeState.selEnd !== undefined) {
    return start < activeState.selEnd && end > activeState.selStart;
  } else {
    return activeState.cursor >= start && activeState.cursor <= end;
  }
}

// 上下箭头跨行导航：当前行与目标行均走行索引（二分 + 属性匹配），
// 目标行未挂载（视口外）时退回行首/行尾（与旧实现一致）。
export function getArrowNavigationIndex(
  cursorPos: number,
  direction: 'up' | 'down',
  container: HTMLElement
): number | null {
  const currentRect = getCoordinatesFromIndex(cursorPos, container);
  if (!currentRect) return null;

  const idx = getIndex(container);
  const lines = idx.lines;

  // 当前行：行索引二分（start <= cursorPos <= start + length）
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= cursorPos) lo = mid + 1;
    else hi = mid;
  }
  let currentLineEl: HTMLElement | null = null;
  let currentLineIdx = -1;
  for (let j = lo - 1; j >= 0; j--) {
    const line = lines[j];
    if (line.start + line.length < cursorPos) break;
    if (cursorPos <= line.start + line.length) {
      const di = attrInt(line.el, 'data-index', '-1');
      if (di !== -1) {
        currentLineEl = line.el;
        currentLineIdx = di;
      }
      break;
    }
  }
  if (!currentLineEl || currentLineIdx === -1) return null;

  const targetIdx = direction === 'up' ? currentLineIdx - 1 : currentLineIdx + 1;

  // 目标行：行索引内线性匹配 data-index（视口内行数有限，避免 DOM 查询）
  let targetLineEl: HTMLElement | null = null;
  for (const line of lines) {
    if (attrInt(line.el, 'data-index', '-1') === targetIdx) {
      targetLineEl = line.el;
      break;
    }
  }

  if (!targetLineEl) {
    // 目标行未挂载（视口外）：退回行首/行尾（旧实现同款）
    if (direction === 'up') {
      return attrInt(currentLineEl, 'data-line-start');
    } else {
      const start = attrInt(currentLineEl, 'data-line-start');
      const len = attrInt(currentLineEl, 'data-line-length');
      return start + len;
    }
  }

  const targetRect = targetLineEl.getBoundingClientRect();

  // 目标行中心 Y（用于 caretRangeFromPoint 命中文档位置）
  const targetY =
    direction === 'up'
      ? targetRect.bottom - targetRect.height / 2
      : targetRect.top + targetRect.height / 2;

  if (typeof document.caretRangeFromPoint === 'function') {
    // 目标中心位于视口内时优先用浏览器命中测试（最精确）
    if (targetY >= 0 && targetY <= window.innerHeight) {
      const range = document.caretRangeFromPoint(currentRect.left, targetY);
      if (range) {
        const index = getGlobalIndexFromDOMNode(
          range.startContainer,
          range.startOffset,
          container
        );
        if (index !== null) {
          return index;
        }
      }
    }
  }

  // 几何回退：目标行内二分找最接近当前列 X 的字符位置（行级索引，无全扫）
  const targetStart = attrInt(targetLineEl, 'data-line-start');
  const targetLen = attrInt(targetLineEl, 'data-line-length');

  let bestDist = Infinity;
  let bestIndex = targetStart;

  let low = 0;
  let high = targetLen;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const globalIdx = targetStart + mid;
    const r = getCoordinatesFromIndex(globalIdx, targetLineEl);
    if (!r) break;

    const dist = Math.abs(r.left - currentRect.left);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = globalIdx;
    }

    if (r.left === currentRect.left) {
      break; // 精确匹配
    } else if (r.left < currentRect.left) {
      low = mid + 1; // 需要右移
    } else {
      high = mid - 1; // 需要左移
    }
  }

  // 邻近 ±2 字符复核（字体局部 kerning/宽度波动时的兜底）
  for (let offset = -2; offset <= 2; offset++) {
    const checkIdx = bestIndex + offset;
    if (checkIdx >= targetStart && checkIdx <= targetStart + targetLen) {
      const r = getCoordinatesFromIndex(checkIdx, targetLineEl);
      if (r) {
        const dist = Math.abs(r.left - currentRect.left);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = checkIdx;
        }
      }
    }
  }

  return bestIndex;
}
