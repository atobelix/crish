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
//      光标移动直接命中；索引重建时随条目一起废弃（等价于 lines 版本失效）；
//   5. 跨视口箭头列保持（01 问题 7 §7.2）：目标行未挂载（视口外）时，
//      数据层取目标行（getLine/getLineCount 双段访问器 O(1) + LineOffsetTree
//      O(log n)——P2-A1 回修 1：不再读惰性物化视图 store.lines，流式期间
//      （尾段非空）旧路径每键触发 O(全文) concat 物化）、字符宽度 Oracle
//      列预测、滚动跟随滚入视口——不再退化为行首/行尾，
//      下一帧行挂载后由 HiddenInput 的越界滚动跟随与常规测量接管精确位置。

import { useEditorStore } from './EditorStore';

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
        for (const node of Array.from(m.addedNodes)) collectAdded(node);
        for (const node of Array.from(m.removedNodes)) collectRemoved(node);
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

/** 清除容器内所有 Token 及位置缓存（装饰/语法展开/折叠状态切换时调用） */
export function clearContainerMeasurementCache(container: HTMLElement | null): void {
  if (!container) return;
  const idx = indexMap.get(container);
  if (!idx) return;
  idx.posCache.clear();
  for (let i = 0; i < idx.tokens.length; i++) {
    const t = idx.tokens[i];
    t.measCache = null;
    t.textTable = null;
  }
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
  let lineLen = -1;

  let isGutterOrIgnored = false;
  while (el && el !== container) {
    if (el.hasAttribute('data-token-start') && foundTokenStart === -1) {
      foundTokenStart = attrInt(el, 'data-token-start', '-1');
    }
    if (el.hasAttribute('data-line-start') && lineStart === -1) {
      lineStart = attrInt(el, 'data-line-start', '-1');
      lineLen = attrInt(el, 'data-line-length', '-1');
    }
    if (
      el.classList.contains('code-gutter') ||
      el.hasAttribute('data-ignore-measure')
    ) {
      isGutterOrIgnored = true;
    }
    el = el.parentElement;
  }

  // 若点击在行号槽位（code-gutter）或明确忽略测量的元素上，直接锚定到行首
  if (isGutterOrIgnored && lineStart !== -1) {
    return lineStart;
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
    // 修复边界：当命中行元素且 offset 达到或超过子节点总数时，归入行尾而非行首
    if (!isText && offset >= node.childNodes.length && lineLen !== -1) {
      return lineStart + lineLen;
    }
    return lineStart + (isText ? offset : 0);
  }

  return null;
}

/** 物理行文本节点描述符 */
interface MountedTextNodeEntry {
  node: Text;
  globalStart: number;
  length: number;
}

/**
 * 真实 DOM 文本节点物理二分探测器（Tier 2 SSOT 物理真理源）
 * 当光标落于行首/行尾空白、Token 间隙或 Padding 时，彻底废除猜列算法，
 * 在行内已挂载的可见 Text 节点上直接执行 Range 物理二分探测。
 */
export function locateRowIndexByPhysicalBisection(
  rowEl: HTMLElement,
  clientX: number,
  lineStart: number,
  lineLen: number
): number | null {
  if (lineLen <= 0) return lineStart;

  // 1. 扫描行内可见 Text 节点
  const textEntries: MountedTextNodeEntry[] = [];
  const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      // 检查当前元素及其祖先是否隐藏或明确忽略物理测量
      const ignoreEl = p.closest(
        '.syntax-hidden, .katex-mathml, .math-preview, .code-gutter, [data-copy-button], [data-ignore-measure]'
      ) as HTMLElement | null;
      if (ignoreEl) {
        if (
          p.closest('.code-gutter, [data-copy-button], [data-ignore-measure]')
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        if (typeof window !== 'undefined' && window.getComputedStyle) {
          const disp = window.getComputedStyle(ignoreEl).display;
          if (disp === 'none') return NodeFilter.FILTER_REJECT;
        } else {
          return NodeFilter.FILTER_REJECT;
        }
      }
      const val = n.nodeValue;
      if (!val || val.length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const scrollContainer = rowEl.closest('.editor-scroll-container') as HTMLElement || document.body;
  let curr = walker.nextNode();
  while (curr) {
    const tNode = curr as Text;
    const gIdx = getGlobalIndexFromDOMNode(tNode, 0, scrollContainer);
    if (gIdx !== null) {
      textEntries.push({
        node: tNode,
        globalStart: gIdx,
        length: tNode.nodeValue?.length || 0,
      });
    }
    curr = walker.nextNode();
  }

  if (textEntries.length === 0) return null;
  textEntries.sort((a, b) => a.globalStart - b.globalStart);

  const range = getSharedRange();

  // 2. 检查整行最左边界：若点击在最左可见字符左侧，锚定到最左可见字符起点（防跳回折叠语法前缀如 ### ）
  try {
    for (let i = 0; i < textEntries.length; i++) {
      const entry = textEntries[i];
      range.setStart(entry.node, 0);
      range.setEnd(entry.node, Math.min(1, entry.length));
      const firstRect = range.getBoundingClientRect();
      if (firstRect.width > 0) {
        if (clientX <= firstRect.left) {
          return entry.globalStart;
        }
        break;
      }
    }
  } catch {}

  // 3. 检查整行最右边界：若点击在当前行最右可见字符右侧（即行内空白区域），
  // 严格统一将光标锚定到当前行末尾（lineStart + lineLen）
  try {
    for (let i = textEntries.length - 1; i >= 0; i--) {
      const entry = textEntries[i];
      range.setStart(entry.node, Math.max(0, entry.length - 1));
      range.setEnd(entry.node, entry.length);
      const lastRect = range.getBoundingClientRect();
      if (lastRect.width > 0) {
        if (clientX >= lastRect.right) {
          return lineStart + lineLen;
        }
        break;
      }
    }
  } catch {}

  // 4. 二分物理探测：找出与 clientX 欧氏距离最小的字符边界
  let bestDist = Infinity;
  let bestPos = lineStart;

  for (const entry of textEntries) {
    const len = entry.length;
    let lo = 0;
    let hi = len - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        range.setStart(entry.node, mid);
        range.setEnd(entry.node, mid + 1);
        const r = range.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          const midX = r.left + r.width / 2;
          const distToLeft = Math.abs(r.left - clientX);
          const distToRight = Math.abs(r.right - clientX);

          // 黄金分割准则：判断吸附到该字符左侧还是右侧
          if (distToLeft < bestDist) {
            bestDist = distToLeft;
            bestPos = entry.globalStart + mid;
          }
          if (distToRight < bestDist) {
            bestDist = distToRight;
            bestPos = entry.globalStart + mid + 1;
          }

          if (clientX < midX) {
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        } else {
          lo = mid + 1;
        }
      } catch {
        lo = mid + 1;
      }
    }
  }

  if (!Number.isFinite(bestDist)) {
    return null;
  }

  const lastEntry = textEntries[textEntries.length - 1];
  if (bestPos >= lastEntry.globalStart + lastEntry.length) {
    return lineStart + lineLen;
  }

  return Math.min(lineStart + lineLen, Math.max(lineStart, bestPos));
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

// ============================================================
// 跨视口箭头导航：数据层列保持（01 问题 7 §7.2）
// ============================================================

// 等宽/全角字宽缓存：字体键 → { ascii, cjk }（与 tokenFontSize 同款
// 「首次实测、其后命中」的字体度量语义；字体由应用级 CSS 变量固定，键空间有界）
interface CharWidths {
  ascii: number;
  cjk: number;
}
const charWidthCache = new Map<string, CharWidths>();

// 宽字符判定（全角字宽按 2 倍等宽近似）：
// 谚文 Jamo、CJK 部首与统一表意、谚文音节、兼容表意与全角形式、CJK 扩展 B+
function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xff60) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

// 单字符预测宽度：Tab 按 4 倍等宽近似（源码中极少见，仅用于列估计）
function charAdvance(code: number, w: CharWidths): number {
  if (code === 9) return w.ascii * 4;
  return isWideChar(code) ? w.cjk : w.ascii;
}

// 实测字宽（CM6 measureTextSize 同款）：按字体样式取样的隐藏 span 量 20 个
// 字符的平均宽；实测不可用（jsdom / display:none）时回退「0.6 × 字号」等宽
// 启发式（与 HeightMap 默认 charWidth=8.4 同口径），全角 = 2 倍等宽。
function measureCharWidths(fontEl: HTMLElement): CharWidths {
  const cs = window.getComputedStyle(fontEl);
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;pointer-events:none;';
  // 取样字体与「当前行」完全一致（等宽栈 + 字号 + 字重 + 字距）
  probe.style.fontFamily = cs.fontFamily;
  probe.style.fontSize = cs.fontSize;
  probe.style.fontWeight = cs.fontWeight;
  probe.style.letterSpacing = cs.letterSpacing;
  document.body.appendChild(probe);
  try {
    probe.textContent = 'M'.repeat(20);
    const ascii = probe.getBoundingClientRect().width / 20;
    probe.textContent = '中'.repeat(20);
    const cjk = probe.getBoundingClientRect().width / 20;
    if (ascii > 0 && cjk > 0) return { ascii, cjk };
  } finally {
    probe.remove();
  }
  const fs = parseFloat(cs.fontSize) || 14;
  const ascii = fs * 0.6;
  return { ascii, cjk: ascii * 2 };
}

// 取字符宽度 Oracle（按字体键缓存，字体为应用级 CSS 变量，缓存有界）
function getCharWidths(fontEl: HTMLElement): CharWidths {
  const cs = window.getComputedStyle(fontEl);
  const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.letterSpacing}`;
  let w = charWidthCache.get(key);
  if (!w) {
    if (charWidthCache.size >= 32) charWidthCache.clear();
    w = measureCharWidths(fontEl);
    charWidthCache.set(key, w);
  }
  return w;
}

// 目标行列预测：以「当前列 X（行左缘基准）」为参照，沿目标行文本按等宽/
// 全角字宽累加，返回与当前列 X 最接近的字符位置。相比「currentX / charWidth」
// 直接除法，累加对含全角字符的行误差更小（全角占 2 倍宽但计 1 列）；纯 ASCII
// 等宽行两者等价（01 问题 7 §7.2 colHint 公式的同构实现）。
function predictColumn(lineText: string, relX: number, w: CharWidths): number {
  if (relX <= 0) return 0;
  let best = 0;
  let bestDist = Infinity;
  let acc = 0;
  for (let p = 0; p <= lineText.length; p++) {
    if (p > 0) acc += charAdvance(lineText.charCodeAt(p - 1), w);
    const dist = Math.abs(acc - relX);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

// 目标行滚动跟随：目标行未挂载 → 无 DOM 可实测其 Y，用「当前行实测矩形」
// 估算目标行内容 Y（下移 = 当前行顶 + 当前行高；上移 = 当前行顶 − 当前行高。
// 相邻一行：下移估算精确（目标行顶 = 当前行底），上移误差 ≤ 相邻行高差），
// 把目标行整行滚到视口上沿内侧 60px（余量吸收估算误差；虚拟器 overscan 40 行
// ≫ 误差量级，目标行必然挂载）。下一帧行挂载后，HiddenInput 的越界滚动跟随
// （top<40 / 越下沿，HiddenInput.tsx:62-76）接管精确居中——该跟随只在测量
// 成功时生效，跨视口场景测量必然失败，故滚动必须在此处（测量层）完成。
function scrollTargetLineIntoView(
  container: HTMLElement,
  currentLineEl: HTMLElement,
  direction: 'up' | 'down'
): void {
  const containerRect = container.getBoundingClientRect();
  const lineRect = currentLineEl.getBoundingClientRect();
  // 当前行顶的内容 Y（与行 top 同一坐标系，滚动无关）
  const lineTop = lineRect.top - containerRect.top + container.scrollTop;
  // 目标行估算区间（目标行高暂以当前行高近似）
  const targetTop =
    direction === 'down' ? lineTop + lineRect.height : lineTop - lineRect.height;
  const targetBottom = targetTop + lineRect.height;

  const vTop = container.scrollTop;
  const vBottom = vTop + container.clientHeight;
  // 估算区间已完全在视口内则不动（避免与浏览器/后续滚动打架）
  if (targetTop >= vTop && targetBottom <= vBottom) return;

  // 目标行整行滚到视口上沿内侧 60px（下移方向以估算行顶为基准，上移方向
  // 以估算行底为基准，保证目标行整体入视口）
  const nextTop =
    direction === 'down' ? targetTop - 60 : targetBottom - 60;
  const maxTop = Math.max(0, (container.scrollHeight || 0) - container.clientHeight);
  container.scrollTop = Math.min(maxTop, Math.max(0, nextTop));
}

// 目标行未挂载（视口外）时的数据层列保持导航（01 问题 7 §7.2）：
// 1. 数据层取目标行：lines 数组 O(1) 取行文本，LineOffsetTree.getOffset O(log n) 取行偏移；
// 2. 列预测：当前列 X（currentRect.left − 行左缘）经字符宽度 Oracle（等宽/
//    全角字宽）映射为目标行内的最接近列；等宽字体下预测误差 ≤ 1 字符；
// 3. 滚动跟随：估算目标行 Y 滚入视口（scrollTargetLineIntoView），下一帧行
//    挂载后由 HiddenInput 的越界滚动跟随 + 常规 DOM 测量接管精确列位置；
// 4. 两帧校正（可选，登记复杂度）：滚动后一帧目标行进入视口时可用
//    caretRangeFromPoint 真实测量复核列位置——但校正需 measure 模块反向写
//    store 光标（测量层越权），且 HiddenInput 已把预测位吸附到 grapheme 边界
//    （snapToGraphemeBoundary），校正点与吸附结果比较存在竞态。等宽字体下
//    预测误差 ≤ 1 字符、下一次箭头即用真实测量天然校正，收益低于风险，不落地。
// 边界：首行上移 / 末行下移返回 null 保持原位（原退化分支会跳到当前行首/行尾）。
function navigateOffscreenLine(
  container: HTMLElement,
  currentRect: MeasuredRect,
  currentLineEl: HTMLElement,
  targetIdx: number,
  direction: 'up' | 'down'
): number | null {
  const store = useEditorStore.getState();
  // 行数/行文本经访问器读取（P2-A1 回修 1：不再读惰性物化视图 store.lines
  // ——流式期间（尾段非空）旧路径每次键触发 O(全文) concat 物化；getLine/
  // getLineCount 为双段 O(1) 访问，尾段非空同样零物化）
  if (targetIdx < 0 || targetIdx >= store.getLineCount()) return null;

  // 数据层取目标行文本与行内偏移
  const targetText = store.getLine(targetIdx) ?? '';
  const targetStart = store.lineOffsets.getOffset(targetIdx);

  // 1) 当前列 X：以当前行左缘为基准（视口坐标系）
  const lineRect = currentLineEl.getBoundingClientRect();
  const relX = Math.max(0, currentRect.left - lineRect.left);

  // 2) 列预测：字符宽度 Oracle（等宽/全角），目标行内累加宽度逼近 relX
  const fontEl =
    (currentLineEl.querySelector('[data-token-start]') as HTMLElement | null) ??
    currentLineEl;
  const widths = getCharWidths(fontEl);
  const col = predictColumn(targetText, relX, widths);
  const newPos = targetStart + Math.min(col, targetText.length);

  // 3) 滚动跟随：目标行估算位置滚入视口，下一帧真实测量接管
  scrollTargetLineIntoView(container, currentLineEl, direction);

  return newPos;
}

// 上下箭头跨行导航：当前行与目标行均走行索引（二分 + 属性匹配）；
// 目标行未挂载（视口外）时走「数据层列保持」（navigateOffscreenLine）：
// 字符宽度 Oracle 列预测 + 滚动跟随，不再退化为行首/行尾。
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
    // 目标行未挂载（视口外）：数据层列保持（列预测 + 滚动跟随），
    // 不再退化为行首/行尾（01 问题 7 §7.2）
    return navigateOffscreenLine(
      container,
      currentRect,
      currentLineEl,
      targetIdx,
      direction
    );
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

// ============================================================
// Bidi 感知水平移动（R4 编辑轮·bidi 骨架）
// ============================================================
// RTL 段内视觉方向反转：ArrowLeft 在 RTL 段 = 逻辑右移（视觉左移）。
// lineInfo 为 null（LTR 行快速路径）时退化为原 grapheme 语义——零行为变化。
// HiddenInput 接线点：水平方向键分支用本函数替代 findPrev/NextGraphemeBoundary
// （需取行 bidi 信息：lineBidiInfo(当前行文本)）。
import { lineBidiInfo, type LineBidiInfo } from './Bidi';
import { findNextGraphemeBoundary, findPrevGraphemeBoundary } from './EditorStore';

/**
 * bidi 感知水平移动。dir: 'left' | 'right'（视觉方向）。
 * 返回新位置（图素边界对齐）。lineInfo 为 null 时退化为原语义。
 */
export function moveHorizontallyBidi(
  index: number,
  dir: 'left' | 'right',
  lineText: string,
  lineInfo: LineBidiInfo | null
): number {
  if (!lineInfo || lineInfo.spans.length === 0) {
    // LTR 快速路径：原 grapheme 语义
    return dir === 'left'
      ? findPrevGraphemeBoundary(lineText, index)
      : findNextGraphemeBoundary(lineText, index);
  }

  // 定位 index 所在的 span（若在 RTL 段内）
  let inRtlSpan = false;
  for (const span of lineInfo.spans) {
    if (index >= span.from && index < span.to) {
      inRtlSpan = true;
      break;
    }
  }

  if (!inRtlSpan) {
    return dir === 'left'
      ? findPrevGraphemeBoundary(lineText, index)
      : findNextGraphemeBoundary(lineText, index);
  }

  // RTL 段内：视觉方向反转
  if (dir === 'left') {
    // 视觉左移 = 逻辑右移
    const next = findNextGraphemeBoundary(lineText, index);
    // 段尾跨出时回到逻辑左（段前位置由调用方下一轮处理，此处保持段内）
    return next;
  }
  // 视觉右移 = 逻辑左移
  return findPrevGraphemeBoundary(lineText, index);
}

/** 便捷：获取行 bidi 信息（null = LTR 零开销） */
export function getLineBidiInfo(lineText: string): LineBidiInfo | null {
  return lineBidiInfo(lineText);
}
