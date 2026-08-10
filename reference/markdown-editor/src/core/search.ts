// ============================================================
// 搜索本体：search.ts（B2 查找替换，05 高频项 N6）
// ============================================================
// 背景：引擎数据模型是「行数组 + 全局偏移树」（lineOffsets），搜索
// 采用行级扫描天然匹配（N6 方案 §1：行级全文扫描，命中偏移直接进
// DecorationSet.addSearchRange 高亮）。
//
// 设计：
// 1. 行级分批不卡帧（RL-05 #10 红线：主线程分批，不走 worker）：
//    大文档搜索每批处理 BATCH 行后经调度器让出主线程（默认
//    setTimeout 0 分帧，与 EditorStore 的 requestIdleCallback 分批
//    先例同目标——EditorStore.ts:1546 区域），下一批在后续宏任务
//    继续，滚动/输入帧不被整段搜索阻塞；
// 2. 取消信号（AbortSignal）：UI 输入变化/关闭面板即中止扫描，
//    中止后 reject AbortError，调用方静默吞掉——大文档搜索
//    「不得卡帧」的另一半是「可随时放弃」；
// 3. 选项：caseSensitive（大小写）/ wholeWord（全词）。全词边界
//    与词级导航（HiddenInput Ctrl+Arrow/双击）共用同一词类判定
//    wordClassAt（字母数字连续段/中文连续段/符号段/空白段），
//    词边界语义单源——搜索与导航不出现两套「词」的定义；
// 4. 边界约定：跨行命中（query 含 \n）明确不支持——搜索词按
//    单行词面处理（UI 输入框单行），含 \n 的 query 返回空命中。
//    大小写不敏感匹配对「toLowerCase 后长度变化」的罕见字符
//    （ß → ss 等）退化为大小写敏感，防偏移错乱。
//
// 产出：命中全局字符偏移数组（每个命中起点 from；高亮区间为
// [from, from + query.length)），与 store 的 cursorPos 同一坐标空间。

/** 词类（词级导航与全词匹配的共享判定单元）：
 * - word：字母数字连续段（含下划线，主流编辑器 wordChar 惯例）；
 * - cjk：中文连续段（含日文假名/全角符号等宽字符区，作为独立
 *   段整体跳过——中文无空格分词，段 = 连续汉字串）；
 * - symbol：符号段（标点/运算符/emoji 等非词非空白字符）；
 * - space：空白段（空白/制表/全角空格/零宽等）。 */
export type WordClass = 'word' | 'cjk' | 'symbol' | 'space';

/** 词字符判定（全词匹配边界用）：仅字母数字下划线属于「词字符」。
 * 中文/符号/空白都不是词字符——中文段内任意位置都是合法全词
 * 边界（搜「引擎」在「渲染引擎」中全词命中，与 VS Code 对 CJK
 * 的 wholeWord 行为一致：CJK 不参与词边界阻挡）。 */
export function isWordChar(ch: string): boolean {
  if (ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    ch === '_'
  );
}

// 中文连续段判定区间（与 isWideChar 同族：CJK 统一表意 + 扩展 +
// 假名 + 全角符号 + 兼容表意，HiddenInput.tsx:83 镜像同族口径）
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u20000-\u3FFFD]/;
// 空白段判定（含全角空格/零宽空格等 Unicode 空白）
const SPACE_RE = /\s/u;

/** 单字符词类判定（空白字符 / 空串 → 'space'；字母数字 → 'word'；
 * 中文区 → 'cjk'；其余 → 'symbol'）。O(1) 正则单字符测试。 */
export function wordClassAt(ch: string): WordClass {
  if (ch === '' || SPACE_RE.test(ch)) return 'space';
  if (isWordChar(ch)) return 'word';
  if (CJK_RE.test(ch)) return 'cjk';
  return 'symbol';
}

/**
 * 行内词边界导航（Ctrl+Arrow / 双击选词的共享词步长）：
 * - dir='left'：从 pos 向左跳过空白 → 定位到最近词段（word/cjk/
 *   symbol 段）的段首；pos 已在段首/行首时原地不动（行内语义，
 *   跨行由调用方处理）；
 * - dir='right'：从 pos 向右跳过空白 → 定位到最近词段的段尾；
 *   pos 已在段尾/行尾时原地不动。
 * 返回 [0, text.length] 内的行内偏移。pos 越界时钳制到行边界。
 */
export function wordBoundary(
  text: string,
  pos: number,
  dir: 'left' | 'right'
): number {
  const len = text.length;
  if (dir === 'left') {
    let p = Math.max(0, Math.min(pos, len));
    // 先越过光标左侧的空白（词段之间的间隔）
    while (p > 0 && wordClassAt(text[p - 1]) === 'space') p--;
    if (p === 0) return 0;
    const cls = wordClassAt(text[p - 1]);
    // 再按词段整体跳过（字母数字段 / 中文段 / 符号段各自连续）
    while (p > 0 && wordClassAt(text[p - 1]) === cls) p--;
    return p;
  }
  let p = Math.max(0, Math.min(pos, len));
  // 先越过光标右侧的空白
  while (p < len && wordClassAt(text[p]) === 'space') p++;
  if (p >= len) return len;
  const cls = wordClassAt(text[p]);
  while (p < len && wordClassAt(text[p]) === cls) p++;
  return p;
}

/** 搜索选项 */
export interface SearchOptions {
  /** 大小写敏感（默认 false：不区分大小写） */
  caseSensitive?: boolean;
  /** 全词匹配（默认 false）：命中两侧不得为词字符（字母数字
   *  下划线；中文/符号/空白均不阻挡——见 isWordChar 注释） */
  wholeWord?: boolean;
}

/** 单行内搜索（纯函数，供 searchAll 复用与单测）：
 * - lineStart 为该行全局起始偏移，命中返回全局偏移（lineStart + 行内位置）；
 * - query 为空或含换行 → 空命中（跨行查询不支持，见文件头注释）；
 * - 命中互不重叠（indexOf 顺次推进），返回起点偏移升序数组。 */
export function searchLine(
  lineText: string,
  lineStart: number,
  query: string,
  opts: SearchOptions = {}
): number[] {
  const out: number[] = [];
  collectLineMatches(out, lineText, lineStart, query, opts);
  return out;
}

// 行内命中收集（写入目标数组，避免每行分配——行级扫描热路径）
function collectLineMatches(
  out: number[],
  lineText: string,
  lineStart: number,
  query: string,
  opts: SearchOptions
): void {
  if (!query || query.includes('\n')) return;
  // 大小写不敏感路径：对整行 toLowerCase 后扫描；toLowerCase 可能
  // 改变字符数（ß → ss），此时长度不一致说明字符映射非 1:1，
  // 退化为大小写敏感匹配（防偏移错乱，见文件头注释第 4 点）
  const lower = lineText.toLowerCase();
  const q = opts.caseSensitive ? query : query.toLowerCase();
  const haystack = opts.caseSensitive || lower.length === lineText.length
    ? (opts.caseSensitive ? lineText : lower)
    : lineText;
  const needle = opts.caseSensitive || q.length === query.length ? q : query;
  const wholeWord = opts.wholeWord === true;

  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    if (!wholeWord || isWholeWordMatch(haystack, needle, idx)) {
      out.push(lineStart + idx);
    }
    idx = haystack.indexOf(needle, idx + 1);
  }
}

// 全词边界判定（needle 基于 haystack 的实例化，字符映射 1:1）：
// 命中 [idx, idx + qlen) 的两侧不得是词字符；行首/行尾视为边界。
// 注意索引空间 = haystack（lower 或原文），长度不变故与原文对齐。
function isWholeWordMatch(
  haystack: string,
  needle: string,
  idx: number
): boolean {
  const qlen = needle.length;
  // 左侧边界：行首或左侧字符非词字符
  if (idx > 0 && isWordChar(haystack[idx - 1])) return false;
  // 右侧边界：行尾或右侧字符非词字符
  const right = idx + qlen;
  if (right < haystack.length && isWordChar(haystack[right])) return false;
  return true;
}

/** 同步行级全文搜索（小文档/测试/纯函数入口）：
 * 逐行 searchLine，全局偏移按「行长 + 1（换行符）」累计。
 * 返回全部命中起点偏移（升序）。 */
export function searchAllSync(
  lines: readonly string[],
  query: string,
  opts: SearchOptions = {}
): number[] {
  const out: number[] = [];
  if (!query) return out;
  let lineStart = 0;
  for (const line of lines) {
    collectLineMatches(out, line, lineStart, query, opts);
    lineStart += line.length + 1; // +1 = 换行符（与 lineOffsets 口径一致）
  }
  return out;
}

/** 每批处理行数（让出主线程的粒度；大文档分批不卡帧的默认批次，
 *  与分块加载 1000/2000 常量同量级——单批行级 indexOf 扫描开销
 *  在亚毫秒级，帧间隔内可安全完成） */
export const DEFAULT_SEARCH_BATCH = 2_000;

/** 分批搜索进度回调载荷 */
export interface SearchProgress {
  /** 是否全部完成（最后一批后为 true；用于 UI 展示「搜索中/完成」） */
  done: boolean;
  /** 已处理行数 */
  processedLines: number;
  /** 总行数 */
  totalLines: number;
  /** 当前累计命中数 */
  matchCount: number;
}

/** 分批搜索选项（SearchOptions 扩展） */
export interface SearchBatchedOptions extends SearchOptions {
  /** 每批行数（默认 DEFAULT_SEARCH_BATCH） */
  batchSize?: number;
  /** 取消信号：abort 后扫描立即中止并 reject AbortError */
  signal?: AbortSignal;
  /** 每批结束的进度回调（含完成标志） */
  onProgress?: (progress: SearchProgress) => void;
  /** 批次调度器（默认 setTimeout 0 分帧；测试注入同步调度器
   *  (fn) => fn() 驱动，脱离真实计时器） */
  scheduler?: (fn: () => void) => void;
}

// AbortError 构造（jsdom 与浏览器均可用；统一命名供调用方识别）
function abortError(): DOMException {
  return new DOMException('搜索已取消', 'AbortError');
}

// 默认批次调度器：优先 requestIdleCallback（浏览器空闲期执行，不抢占
// 渲染帧——繁忙/滚动期间批被压缩，空闲时快速跑完；timeout 50ms 保证
// 不被饿死）；无 rIC 环境（Node/jsdom）回退 setTimeout 0 分帧。
// 与 EditorStore 的 requestIdleCallback 分批先例同目标（RL-05 #10
// 主线程分批红线：不走 worker，分批让出主线程）。
function defaultScheduler(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => fn(), { timeout: 50 });
  } else {
    setTimeout(fn, 0);
  }
}

/**
 * 行级分批全文搜索（任务书 searchAll 形态）：
 * - 每批 BATCH 行扫描后经调度器让出主线程（默认 rIC 空闲期执行，
 *   回退分帧）——大文档搜索全程不阻塞主线程渲染/输入（RL-05 #10
 *   主线程分批红线）；
 * - 取消信号：abort 后下一批起始检查并 reject AbortError（进行中
 *   的单批内也会在本批结束后立刻中止，不继续后续批）；
 * - 进度回调每批触发（UI 可显示「已扫描 X/Y 行」）；
 * - 返回全部命中起点偏移（升序），与 searchAllSync 结果一致
 *   （同步/分批只是调度形态差异，扫描语义相同）。
 */
export function searchAll(
  lines: readonly string[],
  query: string,
  opts: SearchBatchedOptions = {}
): Promise<number[]> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_SEARCH_BATCH);
  const scheduler = opts.scheduler ?? defaultScheduler;
  const signal = opts.signal;
  const onProgress = opts.onProgress;
  const matches: number[] = [];

  if (!query) return Promise.resolve(matches);

  // 取消信号登记：abort 置标志，下一批起始检查（不打断单批内循环）
  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  if (signal) {
    if (signal.aborted) return Promise.reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let processed = 0;
  let lineStart = 0;

  const cleanup = () => {
    signal?.removeEventListener('abort', onAbort);
  };

  return new Promise<number[]>((resolve, reject) => {
    const step = () => {
      if (aborted) {
        cleanup();
        reject(abortError());
        return;
      }
      // 本批扫描：连续 batchSize 行（行级 indexOf，无跨行状态）
      const end = Math.min(lines.length, processed + batchSize);
      for (; processed < end; processed++) {
        const line = lines[processed];
        collectLineMatches(matches, line, lineStart, query, opts);
        lineStart += line.length + 1;
      }
      const done = processed >= lines.length;
      if (onProgress) {
        onProgress({
          done,
          processedLines: processed,
          totalLines: lines.length,
          matchCount: matches.length,
        });
      }
      if (done) {
        cleanup();
        resolve(matches);
        return;
      }
      // 让出主线程：下一批经调度器在后续宏任务执行（不阻塞帧）
      scheduler(step);
    };
    step();
  });
}
