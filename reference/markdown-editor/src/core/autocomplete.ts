/**
 * 自动补全核心（B5：ruler 注册触发 + 候选生成）
 *
 * 定位（docs/analysis/plan-P2-执行方案.md B5 / status-P3）：
 * - 候选源注册表：InlineRuler.register 同款形态（静态注册 + 同名替换 +
 *   版本号）——「@mention 机制现成」即指该全局注册表范式；触发字符由
 *   注册源自带（@/:/# 等可配——宿主注册任意触发字符的源即自动启用）；
 * - findAutocompleteTriggerInLine：行内触发检测（纯函数）——光标左侧
 *   最近触发字符 + 词边界判定（触发字符前必须是行首/空白，防词中间
 *   误触）+ query 提取；只扫光标所在行（O(行)，不全文 getText join，
 *   R6-P1 性能口径）；
 * - filterAutocompleteCandidates：前缀 > 包含 > 插入文本包含的评分排序；
 * - buildAutocompleteReplace：选中候选 → 替换事务参数（from/to/insert/
 *   cursorAfter），由 ContextMenu 消费走 store.applyChange 单步 undo；
 * - 内置演示源：@mention 候选（宿主可经 registerAutocompleteSource
 *   替换/新增——「宿主接线登记」协调点，与 InlineRuler 的 @mention
 *   演示对齐）。
 * 组合期（IME）不触发的红线由 HiddenInput 接线侧保证（isComposingRef
 * 检查），本模块保持纯数据语义。
 */

/** 自动补全候选 */
export interface AutocompleteCandidate {
  /** 显示文本 */
  label: string;
  /** 插入文本（缺省 = label） */
  insertText?: string;
  /** 插入后光标相对插入文本末尾的偏移（缺省 = 末尾，即插入后光标在
   *   insertText.length 处——与 applyChange 默认落点一致） */
  cursorOffset?: number;
  /** 候选附加说明（渲染为弱化说明文字） */
  detail?: string;
  /** 候选图标种类（Alcove 补全卡片行首图标；缺省 = 无图标）。
   *   'file' = 文档（wiki 链接），'tag' = 标签，'mention' = 成员 */
  iconKind?: 'file' | 'tag' | 'mention';
}

/** 候选源：触发字符 + 候选列表 */
export interface AutocompleteSource {
  /** 触发字符（单字符；注册后即进入触发集合） */
  trigger: string;
  /** 候选列表（静态数组；宿主可在此注入动态候选） */
  candidates: AutocompleteCandidate[];
}

/** 触发检测结果（start 为行内偏移——组件侧换算全局偏移） */
export interface AutocompleteQuery {
  /** 命中的触发字符 */
  trigger: string;
  /** 触发字符后已输入部分（光标前，不含触发符；不含空白——扫描按词界停止） */
  query: string;
  /** 触发字符位置（行内偏移） */
  start: number;
  /** 光标位置（行内偏移） */
  cursorPos: number;
}

/** query 最大扫描长度：候选名通常短，防超长行无意义扫描 */
export const AUTOCOMPLETE_QUERY_MAX_LEN = 50;
/** 候选列表最大展示数（超出截断） */
export const AUTOCOMPLETE_MAX_CANDIDATES = 20;

// ============================================================
// 候选源注册表（InlineRuler.register 同款形态）
// ============================================================

/** 候选源表：trigger → 候选列表（同名注册即替换） */
const autocompleteSources = new Map<string, AutocompleteCandidate[]>();
/** 注册表版本号：register/unregister 自增（宿主缓存失效语义，对齐
 *  InlineRuler.getGlobalVersion） */
let sourceVersion = 0;

/**
 * 注册候选源。同名触发字符即替换（markdown-it at 语义，与
 * InlineRuler.register 对齐）；触发字符集合由注册表动态派生——
 * 宿主注册任意字符（@/:/# 等）即自动启用该触发。
 */
export function registerAutocompleteSource(source: AutocompleteSource): void {
  autocompleteSources.set(source.trigger, source.candidates);
  sourceVersion++;
}

/** 移除候选源（按触发字符）：返回是否命中 */
export function unregisterAutocompleteSource(trigger: string): boolean {
  const hit = autocompleteSources.delete(trigger);
  if (hit) sourceVersion++;
  return hit;
}

/** 当前全部触发字符（注册表键集合） */
export function getAutocompleteTriggers(): string[] {
  return [...autocompleteSources.keys()];
}

/** 指定触发字符的候选列表（未注册返回空数组） */
export function getAutocompleteCandidates(trigger: string): AutocompleteCandidate[] {
  return autocompleteSources.get(trigger) ?? [];
}

/** 注册表版本号（宿主缓存失效用） */
export function getAutocompleteVersion(): number {
  return sourceVersion;
}

// ============================================================
// 内置演示源：@mention 候选（宿主接线登记可替换/新增）
// ============================================================

/** 内置 @mention 演示候选（与 InlineRuler 的 @mention 演示对齐：
 *  引擎出厂自带一份可立即体验的候选，宿主可 registerAutocompleteSource
 *  同名替换为真实成员列表） */
export const MENTION_DEMO_CANDIDATES: AutocompleteCandidate[] = [
  { label: 'alice', detail: '演示成员' },
  { label: 'bob', detail: '演示成员' },
  { label: 'carol', detail: '演示成员' },
  { label: 'dave', detail: '演示成员' },
  { label: 'eve', detail: '演示成员' },
  { label: 'felix', detail: '演示成员' },
  { label: 'grace', detail: '演示成员' },
  { label: 'hank', detail: '演示成员' },
];

registerAutocompleteSource({ trigger: '@', candidates: MENTION_DEMO_CANDIDATES });

// ── Alcove 复刻（Seg C）演示源：'[' wiki 链接 + '#' 标签 ──
// 触发字符单字符（'[' 承担 '[[' wiki 语法；双括号由 findAutocompleteTriggerInLine
// 的「同字符放行」边界处理，第二个 '[' 起即视为触发点）。

/** 内置 '[[' wiki 文档候选（与视频演示文档同名，供 1:1 视觉对照） */
export const WIKI_DEMO_CANDIDATES: AutocompleteCandidate[] = [
  { label: 'Convexity', detail: '笔记', iconKind: 'file' },
  { label: 'Convex Hull', detail: '笔记', iconKind: 'file' },
  { label: 'Crossing the minimum', detail: '笔记', iconKind: 'file' },
  { label: 'Gradient methods', detail: '笔记', iconKind: 'file' },
  { label: 'Path of steepest descent', detail: '笔记', iconKind: 'file' },
];

/** 内置 '#' 标签候选 */
export const TAG_DEMO_CANDIDATES: AutocompleteCandidate[] = [
  { label: 'math/optimization', iconKind: 'tag' },
  { label: 'math/convexity', iconKind: 'tag' },
  { label: 'math/progress', iconKind: 'tag' },
  { label: 'notes/gradient-descent', iconKind: 'tag' },
];

registerAutocompleteSource({ trigger: '[', candidates: WIKI_DEMO_CANDIDATES });
registerAutocompleteSource({ trigger: '#', candidates: TAG_DEMO_CANDIDATES });

// ============================================================
// 触发检测 / 候选过滤 / 替换构建（全部纯函数，供单测）
// ============================================================

/**
 * 行内触发检测：从光标向左扫描查询词段（连续非空白字符），命中
 * 触发字符且其左侧为行首/空白（词边界）即触发。
 * - 'hello @alice' 光标在末尾 → 命中 '@'，query = 'alice'；
 * - 'foo@bar' 光标在 'r' 后 → '@' 前是 'o'（词中间）→ 不触发；
 * - query 超过 AUTOCOMPLETE_QUERY_MAX_LEN → 不触发（防超长行扫描）。
 * 返回 null = 未触发（调用方应关闭候选菜单）。
 */
export function findAutocompleteTriggerInLine(
  lineText: string,
  cursorInLine: number,
  triggers: string[]
): AutocompleteQuery | null {
  if (cursorInLine <= 0 || triggers.length === 0) return null;
  const triggerSet = new Set(triggers);
  let p = cursorInLine;
  let scanned = 0;
  while (p > 0 && scanned < AUTOCOMPLETE_QUERY_MAX_LEN) {
    const ch = lineText[p - 1];
    // 空白终止扫描（query 不含空白；\n 不会出现在行文本中，防御保留）
    if (ch === '\n' || /\s/.test(ch)) break;
    if (triggerSet.has(ch)) {
      // 词边界判定：触发字符左侧必须是行首或空白（防 'foo@bar' 误触）。
      // 例外：左侧为同一触发字符时放行——成对语法（'[[' wiki、'##' 标签
      // 速记）的第二个字符视为真正的触发点（Alcove 复刻行为）。
      const before = p > 1 ? lineText[p - 2] : '';
      if (before === '' || /\s/.test(before) || before === ch) {
        return {
          trigger: ch,
          query: lineText.substring(p, cursorInLine),
          start: p - 1,
          cursorPos: cursorInLine,
        };
      }
    }
    p--;
    scanned++;
  }
  return null;
}

/**
 * 候选过滤 + 排序：
 * - 空 query → 全量（截断到 AUTOCOMPLETE_MAX_CANDIDATES）；
 * - 非空 → 评分：label 前缀（3）> label 包含（2）> 插入文本包含（1）；
 *   同分按 label 字典序稳定排序。
 */
export function filterAutocompleteCandidates(
  query: string,
  candidates: AutocompleteCandidate[]
): AutocompleteCandidate[] {
  const q = query.toLowerCase();
  const scored = candidates
    .map((c) => ({ c, score: q ? scoreCandidate(c, q) : 0 }))
    .filter((x) => !q || x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.c.label.localeCompare(b.c.label));
  return scored.slice(0, AUTOCOMPLETE_MAX_CANDIDATES).map((x) => x.c);
}

function scoreCandidate(c: AutocompleteCandidate, q: string): number {
  const label = c.label.toLowerCase();
  const insert = (c.insertText ?? c.label).toLowerCase();
  if (label.startsWith(q)) return 3;
  if (label.includes(q)) return 2;
  if (insert.includes(q)) return 1;
  return 0;
}

/**
 * 选中候选 → 替换事务参数：替换区间 [start, cursorPos)（触发字符起、
 * 光标止），插入候选文本，光标落点 = start + cursorOffset。
 * 由 ContextMenu 的候选选择消费，直接走 store.applyChange 单步 undo。
 */
export function buildAutocompleteReplace(
  query: { start: number; cursorPos: number },
  candidate: AutocompleteCandidate
): { from: number; to: number; insert: string; cursorAfter: number } {
  const insert = candidate.insertText ?? candidate.label;
  const cursorOffset = candidate.cursorOffset ?? insert.length;
  return {
    from: query.start,
    to: query.cursorPos,
    insert,
    cursorAfter: query.start + cursorOffset,
  };
}
