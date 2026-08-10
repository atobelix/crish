/**
 * Markdown 轻量工具：仅 escape / 思考占位剥离，无 highlight / 全量渲染依赖。
 * Chat 行静态路径应从此入口引用，避免拖入 codeHighlight 重模块。
 */

/** HTML 属性/正文转义；null/非字符串安全降级 */
export function escapeHtml(s: string): string {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 本轮/本回合 + 可选修饰 + 总结|小结|回顾 */
const RE_ROUND_SUMMARY_ZH =
  '本(?:轮|回合)(?:工作|内容|完成)?(?:总结|小结|回顾)';
/** Round / Session / Turn summary */
const RE_ROUND_SUMMARY_EN = '(?:Round|Session|Turn)\\s+summary';

/**
 * 去掉首尾空行/BOM，但保留行尾有意义空格（如 `- ` 空列表项），
 * 避免 String.trim 把最后一项 `-\s` 吃成裸 `-` 导致匹配失败。
 */
function softTrimMarkdown(s: string): string {
  return s.replace(/^[\s\ufeff]+/, '').replace(/(?:\r?\n[ \t]*)+$/g, '');
}

/**
 * 仅去掉文档头部空白/BOM（增量路径用）。
 * 增量 strip 只对「完成行区域」逐帧处理：文档头必须做与前导空白
 * 一致的剥离，避免 BOM/前导空行残留在流式期显示。
 */
function softTrimMarkdownHead(s: string): string {
  return s.replace(/^[\s\ufeff]+/, '');
}

/**
 * 占位剥离管道（不含文档级 trim）：行锚定正则 + 空行折叠。
 * 全量版 stripThoughtPlaceholders 与增量版 IncrementalThoughtStripper
 * 共用此实现（单实现原则，08-detail 2.3），保证两版语义只有
 * 「区域切分边界」一处漂移面。
 */
export function applyThoughtPlaceholderStrips(source: string): string {
  const zh = RE_ROUND_SUMMARY_ZH;
  const en = RE_ROUND_SUMMARY_EN;
  return source
    .replace(/^(正在思考中[….\s]{0,50}|正在处理[….\s]{0,50}){1,50}/gm, '')
    // heading：## 本轮总结 / ## 本轮工作总结 · / ## 本回合小结：
    .replace(new RegExp(`^#{1,6}\\s*${zh}\\s*[:：·.\\-—–]*\\s*$`, 'gm'), '')
    // 粗体：**本轮总结** / **本轮总结：**
    .replace(
      new RegExp(
        `^\\*{1,2}\\s*${zh}\\s*[:：]?\\s*\\*{1,2}\\s*[:：·.\\-—–]*\\s*$`,
        'gm'
      ),
      ''
    )
    // 【本轮总结】 / [本轮小结]
    .replace(
      new RegExp(`^[\\[【]\\s*${zh}\\s*[\\]】]\\s*[:：·.\\-—–]*\\s*$`, 'gm'),
      ''
    )
    // 裸行
    .replace(new RegExp(`^${zh}\\s*[:：·.\\-—–]*\\s*$`, 'gm'), '')
    // 英文 Round / Session / Turn summary 标题行
    .replace(new RegExp(`^#{1,6}\\s*${en}\\s*[:：·.\\-—–]*\\s*$`, 'gim'), '')
    .replace(
      new RegExp(
        `^\\*{1,2}\\s*${en}\\s*[:：]?\\s*\\*{1,2}\\s*[:：·.\\-—–]*\\s*$`,
        'gim'
      ),
      ''
    )
    .replace(new RegExp(`^${en}\\s*[:：·.\\-—–]*\\s*$`, 'gim'), '')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 去掉模型常夹带的「正在思考…」占位与「本轮总结」类噪音标题。
 * 仅剥独立标题行（可含冒号/装饰括号/分隔点），不吞掉正文段落。
 *
 * N6 结果缓存（08-detail 3.3）：complete 后同一输入会在 onComplete /
 * scheduleFinalMarkdownHtml / 渲染路径重复 strip——同输入免重跑。
 * 有界 Map（条目 + 估算字节双上限），避免大文本（100KB 级）缓存膨胀。
 */
const STRIP_CACHE_MAX_ENTRIES = 64;
const STRIP_CACHE_MAX_BYTES = 1024 * 1024;
const stripCache = new Map<string, string>();
let stripCacheBytes = 0;

function stripCacheSet(source: string, result: string): void {
  if (stripCache.size >= STRIP_CACHE_MAX_ENTRIES || stripCacheBytes >= STRIP_CACHE_MAX_BYTES) {
    stripCache.clear();
    stripCacheBytes = 0;
  }
  stripCache.set(source, result);
  stripCacheBytes += source.length + result.length;
}

export function stripThoughtPlaceholders(text: string): string {
  if (text == null || text === '') return '';
  const source = typeof text === 'string' ? text : String(text);
  if (!source.trim()) return '';
  const cached = stripCache.get(source);
  if (cached !== undefined) return cached;
  // 头部（BOM/前导空白）先于占位正则剥离：否则 `\uFEFF## 本轮总结` 等
  // 首行占位因行锚定 `^#` 匹配失败而残留（与增量版 head trim 对齐——
  // 08-detail 2.2 doc-start 前缀不变式）
  const result = softTrimMarkdown(
    applyThoughtPlaceholderStrips(softTrimMarkdownHead(source))
  );
  stripCacheSet(source, result);
  return result;
}

export interface ThoughtStripperFrame {
  /** 本帧应 append 给 DOM 的显示增量（可为空串） */
  appended: string;
  /** 本帧全量显示文本（测试断言/诊断用） */
  display: string;
  /** true = 检测到流重启/文本收缩，调用方必须重挂载流式节点 */
  resynced: boolean;
}

/**
 * 增量思考占位剥离器（08-detail 2.2，T1.1）。
 *
 * 用「完成行窗口 + 尾行缓冲」保证 append 严格单调：
 * - 只对已换行完结的行做 strip；未完结尾行原样展示（≤1 帧延迟，D1）；
 * - 完结行一旦 strip 即被永久固定进 DOM 历史，跨帧不重算——占位标题
 *   在完成当帧即被剥离，无「先显示后消失」残留；
 * - 区域边界 `\n{3,}→\n\n` 折叠可能漏折（D2），complete 时全量 strip 收敛；
 * - finalFlush 直接复用全量版 stripThoughtPlaceholders（单实现原则）。
 *
 * 契约：next(full) 的入参 full 必须单调增长；文本收缩/流重启 → 返回
 * resynced=true 且 appended=''，调用方负责重挂载流式节点（key 变更）。
 */
export class IncrementalThoughtStripper {
  /** 已完结行区域的原始游标（raw 长度） */
  private rawLen = 0;
  /** 已完结行区域累积 append 的显示文本 */
  private displayAccum = '';
  /** 未换行尾行缓冲（原样展示） */
  private partialLine = '';
  /** 最近一次 next 输入（流重启/同长度内容替换检测） */
  private lastFull = '';
  /** 文档头部是否已处理（前导空白/BOM 只在首个区域剥离一次） */
  private headProcessed = false;
  /**
   * 最近一次返回帧：同值帧（store 同值拦截兜底 / React 19 StrictMode 双渲染）
   * 时幂等返回，保证「每次 next 推进一次、不重复产出」——DOM 侧由
   * StreamingTextBlock 的 lastDeltaRef 守卫二次拦截。
   */
  private lastFrame: ThoughtStripperFrame = {
    appended: '',
    display: '',
    resynced: false,
  };

  /**
   * 输入全文，返回本帧应 append 给 DOM 的增量。
   * @param full 累计流式原文（须单调增长）
   */
  next(full: string): ThoughtStripperFrame {
    // 同值帧：幂等返回上次结果（StrictMode 双渲染 / 无关字段触发重渲染时
    // 不得推进游标、不得重复 append——append 去重由 StreamingTextBlock 守卫）
    if (full === this.lastFull) {
      return this.lastFrame;
    }
    if (full.length < this.rawLen) {
      // 流重启 / 文本收缩：复位并通知调用方重挂载
      this.reset();
      this.lastFrame = { appended: '', display: '', resynced: true };
      return this.lastFrame;
    }
    if (full.length === this.rawLen) {
      // 同长度但内容替换（罕见）：视为重启
      this.reset();
      this.lastFrame = { appended: '', display: '', resynced: true };
      return this.lastFrame;
    }

    const isHead = !this.headProcessed;
    if (isHead) {
      // 头部只处理一次：作用于本帧「展示部分」——completedRegion 剥离 +
      // 尾行缓冲修剪。首帧可能无完成行（纯尾行），此时 BOM/前导空白
      // 必须从尾行即时剥离，否则残留在展示文本（首帧即显示、不可收回）。
      this.headProcessed = true;
    }

    const newPart = full.slice(this.rawLen);
    this.rawLen = full.length;
    this.lastFull = full;

    // 完成行窗口：最后一个 \n 处切开，之前为可 strip 区域（含换行），
    // 之后为未换行尾行（原样缓冲，逐帧增长）。
    // 注意两处语义要点：
    // 1. 区域「结尾换行」不参与 strip——行锚定正则在整文语境下 `\s*$`
    //    回溯不吞行尾换行，而区域语境（结尾即串尾）会吞——直接 strip
    //    区域会把「占位行自己的换行」吃掉（比全量版多剥一个 \n）。
    //    因此剥离在 regionBody（不含结尾换行）上进行，换行原样挂回。
    // 2. 尾行是「增量缓冲」：跨帧增长时**只 append 增长量**（partialGrowth），
    //    已展示部分不得重放——否则帧间重复文本（O(增量) 前提破坏）。
    const lastNl = newPart.lastIndexOf('\n');
    const regionBody = lastNl >= 0 ? newPart.slice(0, lastNl) : '';
    const nextPartial = lastNl >= 0 ? newPart.slice(lastNl + 1) : this.partialLine + newPart;
    const partialGrowth = lastNl >= 0 ? nextPartial : newPart;
    this.partialLine = nextPartial;

    let regionInput = regionBody;
    if (isHead) {
      // 头部区域：BOM/前导空白先于占位正则剥离——`\uFEFF## 本轮总结` 等
      // 行锚定 `^#` 因 BOM 前缀匹配失败而残留（与全量版 softTrimMarkdownHead
      // 先行一致；08-detail 2.2 doc-start 前缀不变式）
      regionInput = softTrimMarkdownHead(regionInput);
    }
    let strippedRegion = lastNl >= 0
      ? (regionInput ? applyThoughtPlaceholderStrips(regionInput) : '') + '\n'
      : '';
    let partial = partialGrowth;
    // 文档头区域：尾行缓冲同样做头部修剪（首帧可能无完成行，纯尾行场景）
    if (isHead) {
      strippedRegion = softTrimMarkdownHead(strippedRegion);
      partial = softTrimMarkdownHead(partial);
    }

    const displayPart = strippedRegion + partial;
    this.displayAccum += displayPart;

    this.lastFrame = {
      appended: displayPart,
      display: this.displayAccum,
      resynced: false,
    };
    return this.lastFrame;
  }

  /** 终态一次性输出 = 全量 strip（与全量版共用实现，无偏差） */
  finalFlush(full?: string): string {
    const text = full !== undefined ? full : this.lastFull;
    return stripThoughtPlaceholders(text);
  }

  /** 复位（msg.id 变更 / 流重启 / 文本收缩 / live=false 时调用） */
  reset(): void {
    this.rawLen = 0;
    this.displayAccum = '';
    this.partialLine = '';
    this.lastFull = '';
    this.headProcessed = false;
    this.lastFrame = { appended: '', display: '', resynced: false };
  }

  /** 当前累积显示文本（测试断言/诊断用） */
  lastDisplay(): string {
    return this.displayAccum;
  }

  /** 已处理原始长度游标（测试断言用） */
  getRawLen(): number {
    return this.rawLen;
  }
}
