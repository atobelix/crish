import type { LineNode, InlineNode, MarkdownDocument, CalloutType } from './ast';
import { LRUCache } from './LRUCache';
// 行内规则插件体系（06 分析 §1）：INLINE_RULES 数组迁移为 ruler 注册表——
// 内置规则初始注册见 buildInlineRuler，宿主自定义语法（@mention 等）经
// InlineRuler.register 全局注册，无需改动 parser 核心。
import { InlineRuler } from './InlineRuler';
import type { InlineRule, InlineRuleContext } from './InlineRuler';

export type CodeState =
  | 'none'
  | 'fence_start'
  | 'code'
  | 'fence_end'
  | 'math_fence_start'
  | 'math_fence_end'
  | 'math_block'
  | 'indent_code'
  // HTML 块（02 §2.5）：CommonMark 7 类 HTML 块（type 1-7）的跨行状态——
  // type 1-6 块内行与结束行均标记 'html_block'；type 7 单行块同理。
  | 'html_block';

/**
 * computeLineOffsets 缩进代码判定的「上一非空白行块级形态」记忆
 * （02 §2.2 冲突点：段落打断 / 列表延续 / 表格优先都需要前一行上下文）：
 * - body/table/list → 缩进 4 空格的下一行是延续内容，不是代码；
 * - 其余（blank/heading/hr/code/other）→ 允许缩进代码块开始。
 */
type BlockKind =
  'blank' | 'body' | 'list' | 'table' | 'heading' | 'hr' | 'code' | 'other';

/**
 * 列表上下文（R1.5-B 正确性回补）：computeLineOffsets 在列表标记行记忆的
 * 「列表项内容缩进列」（markerWidth）——CommonMark §5.2：列表项后续块必须
 * 缩进到「标记后首个内容字符所在列」（例 256/258 实证：`- one` 需 2 列、
 * ` -    one` 需 6 列、`1.  foo` 需 4 列）。空行后首行与之比较：
 * - 缩进 ≥ markerWidth → 列表项延续（新段落，例 256/258/262/277）；
 * - 缩进 ≥ markerWidth + 4 → li 内缩进代码块（例 264/270/271）；
 * - 缩进 < markerWidth → 出列表（例 255/257）。
 * listContexts 数组逐行携带延续标志（indent 供 parseNormalLine 输出
 * listIndent 与 listContinuation）；行级缓存键包含上下文，防同文本行
 * 跨文档串扰。
 */
export interface ListContext {
  /** 列表标记行的前导缩进列（延续行 listIndent 的输出值） */
  indent: number;
  /** 列表项内容缩进列（出列表判定的基准列） */
  markerWidth: number;
}

/** scanTokens 返回：ok 携带 token 列表与消费长度；失败时由调用方按失败签名记忆 */
type ScanOutcome =
  { ok: true; tokens: InlineNode[]; length: number } | { ok: false };

/** scanTokens 递归帧的起止符规则形态：ruler 内起止符规则经 ctx.recurse 进入递归 */
interface InlineCloseRule {
  start: string;
  close: string;
  type: string;
}

/**
 * 命名实体表（02 §2.6）：HTML5 常用命名实体的子集，覆盖 CommonMark 0.31.2
 * 官方套件全部用例（nbsp/amp/copy/AElig/Dcaron/frac34/HilbertSpace/
 * DifferentialD/ClockwiseContourIntegral/ngE/ouml/quot 等）与常用 Latin-1、
 * 希腊字母、标点符号实体。值统一用 Unicode 转义序列，规避源码编码风险。
 */
const NAMED_ENTITIES: Record<string, string> = {
  // 基础
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  // Latin-1 常用
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  cent: '\u00A2',
  pound: '\u00A3',
  yen: '\u00A5',
  euro: '\u20AC',
  curren: '\u00A4',
  sect: '\u00A7',
  para: '\u00B6',
  micro: '\u00B5',
  middot: '\u00B7',
  times: '\u00D7',
  divide: '\u00F7',
  deg: '\u00B0',
  plusmn: '\u00B1',
  sup1: '\u00B9',
  sup2: '\u00B2',
  sup3: '\u00B3',
  frac12: '\u00BD',
  frac14: '\u00BC',
  frac34: '\u00BE',
  iexcl: '\u00A1',
  iquest: '\u00BF',
  laquo: '\u00AB',
  raquo: '\u00BB',
  ordf: '\u00AA',
  ordm: '\u00BA',
  not: '\u00AC',
  shy: '\u00AD',
  macr: '\u00AF',
  acute: '\u00B4',
  cedil: '\u00B8',
  uml: '\u00A8',
  circ: '\u02C6',
  tilde: '\u02DC',
  szlig: '\u00DF',
  // Latin-1 字母
  AElig: '\u00C6',
  Aacute: '\u00C1',
  Acirc: '\u00C2',
  Agrave: '\u00C0',
  Aring: '\u00C5',
  Atilde: '\u00C3',
  Auml: '\u00C4',
  Ccedil: '\u00C7',
  ETH: '\u00D0',
  Eacute: '\u00C9',
  Ecirc: '\u00CA',
  Egrave: '\u00C8',
  Euml: '\u00CB',
  Iacute: '\u00CD',
  Icirc: '\u00CE',
  Igrave: '\u00CC',
  Iuml: '\u00CF',
  Ntilde: '\u00D1',
  Oacute: '\u00D3',
  Ocirc: '\u00D4',
  Ograve: '\u00D2',
  Oslash: '\u00D8',
  Otilde: '\u00D5',
  Ouml: '\u00D6',
  THORN: '\u00DE',
  Uacute: '\u00DA',
  Ucirc: '\u00DB',
  Ugrave: '\u00D9',
  Uuml: '\u00DC',
  Yacute: '\u00DD',
  aacute: '\u00E1',
  acirc: '\u00E2',
  agrave: '\u00E0',
  aring: '\u00E5',
  atilde: '\u00E3',
  auml: '\u00E4',
  ccedil: '\u00E7',
  eth: '\u00F0',
  eacute: '\u00E9',
  ecirc: '\u00EA',
  egrave: '\u00E8',
  euml: '\u00EB',
  iacute: '\u00ED',
  icirc: '\u00EE',
  igrave: '\u00EC',
  iuml: '\u00EF',
  ntilde: '\u00F1',
  oacute: '\u00F3',
  ocirc: '\u00F4',
  ograve: '\u00F2',
  oslash: '\u00F8',
  otilde: '\u00F5',
  ouml: '\u00F6',
  thorn: '\u00FE',
  uacute: '\u00FA',
  ucirc: '\u00FB',
  ugrave: '\u00F9',
  uuml: '\u00FC',
  yacute: '\u00FD',
  yuml: '\u00FF',
  // 希腊字母
  Alpha: '\u0391',
  Beta: '\u0392',
  Gamma: '\u0393',
  Delta: '\u0394',
  Epsilon: '\u0395',
  Zeta: '\u0396',
  Eta: '\u0397',
  Theta: '\u0398',
  Iota: '\u0399',
  Kappa: '\u039A',
  Lambda: '\u039B',
  Mu: '\u039C',
  Nu: '\u039D',
  Xi: '\u039E',
  Omicron: '\u039F',
  Pi: '\u03A0',
  Rho: '\u03A1',
  Sigma: '\u03A3',
  Tau: '\u03A4',
  Upsilon: '\u03A5',
  Phi: '\u03A6',
  Chi: '\u03A7',
  Psi: '\u03A8',
  Omega: '\u03A9',
  alpha: '\u03B1',
  beta: '\u03B2',
  gamma: '\u03B3',
  delta: '\u03B4',
  epsilon: '\u03B5',
  zeta: '\u03B6',
  eta: '\u03B7',
  theta: '\u03B8',
  iota: '\u03B9',
  kappa: '\u03BA',
  lambda: '\u03BB',
  mu: '\u03BC',
  nu: '\u03BD',
  xi: '\u03BE',
  omicron: '\u03BF',
  pi: '\u03C0',
  rho: '\u03C1',
  sigmaf: '\u03C2',
  sigma: '\u03C3',
  tau: '\u03C4',
  upsilon: '\u03C5',
  phi: '\u03C6',
  chi: '\u03C7',
  psi: '\u03C8',
  omega: '\u03C9',
  // 常用符号
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  bull: '\u2022',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  infin: '\u221E',
  sum: '\u2211',
  prod: '\u220F',
  radic: '\u221A',
  int: '\u222B',
  part: '\u2202',
  nabla: '\u2207',
  isin: '\u2208',
  notin: '\u2209',
  ni: '\u220B',
  forall: '\u2200',
  exist: '\u2203',
  empty: '\u2205',
  and: '\u2227',
  or: '\u2228',
  equiv: '\u2261',
  cong: '\u2245',
  sim: '\u223C',
  asymp: '\u2248',
  prop: '\u221D',
  lowast: '\u2217',
  minus: '\u2212',
  lowbar: '\u005F',
  prime: '\u2032',
  Prime: '\u2033',
  // 套件特殊实体（0.31.2 用例所需）
  HilbertSpace: '\u210B',
  DifferentialD: '\u2146',
  ClockwiseContourIntegral: '\u2232',
  ngE: '\u2267\u0338',
  Dcaron: '\u010E',
};

/**
 * 引用链接定义表（02 §2.3）：label 归一化（3.1.4：去首尾空白、内部空白折叠
 * 为单空格、ASCII/Unicode 大小写折叠、实体解码；反斜杠转义不折叠）后的键 →
 * 目标与可选标题。定义表随 parse 调用创建（文档级隔离，review-02 §7.3）。
 */
export interface RefDefinition {
  url: string;
  title?: string;
}
export interface RefDefTable {
  /** 定义表快照 id：进 parseLine 缓存键（review-02 §7.3 缓存污染修复） */
  id: number;
  table: Map<string, RefDefinition>;
}

/**
 * 失败规则位图记忆（跨递归层共享）：
 * - failedAt：位置级失败签名 `ruleKey@position`——「从该位置起该规则无法成功闭合」已确认失败，
 *   再次遇到同位置同规则的尝试直接跳过（2^n 爆炸的根治：每个位置每规则只尝试一次）。
 * - noClose：规则级闭包缺失表——indexOf 确认「位置 p 之后不存在闭合标记」是文本事实（与解析上下文无关），
 *   因此任何 q >= p 的尝试窗口 (q, EOF) 都不含闭合标记，可直接跳过；p 取已确认的最小值。
 */
type ScanFailureMemo = {
  failedAt: Set<string>;
  noClose: Map<string, number>;
};

// —— 围栏关闭判定（P2-A1 fence 单源化，评审裁决：parser.ts 导出共享函数）——
// 完整关闭条件（spec 0.31.2 Fenced code blocks）：关闭行必须
//   1) 与开栏同字符（反引号/波浪线不可混用，` ``` ` 不能关 `~~~` 开栏）；
//   2) run 长度 ≥ 开栏长度（```` 开栏不能被 ``` 关闭——"at least as long as"）；
//   3) 行内除尾随空白外无 info 串（closing fence 不能有 info string——
//      ` ``` js` 保持 code；` ```INS`（fence_end 行尾插入的 info）同样不闭合）。
// 单源化：parser 全量重扫（computeLineOffsets）与 EditorStore 增量状态机
// （updateLinesIncremental / appendText 段状态机）共用本函数，消除两套状态机
// 在 fence_end 行尾插入场景的分歧（KNOWN-DEFECT，P2 现状盘点项 2）。
// 入参约定：trimmed = 已剥离块引用前缀并 trim 的行（与 computeLineOffsets
// 的判定基线一致——trim 后判定的既有行为保留，`    ``` ` 四空格缩进仍按
// 围栏处理，02 §7.2 登记偏差不动）；openMarker = 开栏标记字符（'`' | '~'），
// openLen = 开栏 run 长度（≥3）。
export function isFenceClose(
  trimmed: string,
  openMarker: string,
  openLen: number
): boolean {
  const close = /^(`+|~+)[ \t]*$/.exec(trimmed);
  return (
    close !== null && close[1][0] === openMarker && close[1].length >= openLen
  );
}

export class MarkdownParser {
  private static idCounter = 0;
  private static generateId(): string {
    return 'line_' + (this.idCounter++).toString(36);
  }

  public static parse(text: string): MarkdownDocument {
    const {
      offsets,
      codeBlockState,
      setextLevels,
      listContexts,
      lazyContinuation,
      fenceLangs,
      calloutTypes,
      calloutTitles,
      isCalloutHeaders,
    } = this.computeLineOffsets(text);
    const lines = text.split('\n');
    const lineNodes: LineNode[] = new Array(lines.length);
    // 引用链接定义预扫描（02 §2.3）：定义表随 parse 调用创建（文档级隔离——
    // 多文档各 parse 各建，不跨文档共享）；返回每行「是否为定义行」标志。
    const { refs, flags } = this.collectReferenceDefinitions(
      lines,
      codeBlockState
    );
    for (let i = 0; i < lines.length; i++) {
      // 定义行不是段落：修正 Setext 预扫描的误判
      // （`[foo]: /url\n===` → `===` 是正文而非 Setext 下划线，spec 例 25）。
      if (flags[i] && setextLevels[i] > 0) {
        setextLevels[i] = 0;
        if (i + 1 < setextLevels.length) setextLevels[i + 1] = 0;
      }
      // Setext 上下文标志（0=普通行 / 1|2=Setext 标题内容行 / -1=Setext 下划线行）
      // 由预扫描 computeSetextContexts 产出，随 parseLine 传入——
      // 「标题身份由上下文决定、而非解析后回写」是 review-02 §7.1 的修正要求。
      lineNodes[i] = this.parseLine(
        lines[i],
        offsets[i],
        codeBlockState[i],
        setextLevels[i],
        refs,
        flags[i],
        // 列表项延续上下文（R1.5-B）：computeLineOffsets 判定为「空行后
        // 列表项延续」的行携带列表缩进，parseLine 据此标记 listIndent/
        // listContinuation（普通行为 null）。
        listContexts[i],
        // 懒延续继承层级（B8a）：无块引用标记（或标记层数不足）的段落
        // 延续行继承前一非空白块引用段落行的容器层级（null = 非懒延续）。
        lazyContinuation[i],
        // B8c：行尾硬换行上下文——本行是否为「块结束」（无后继行或下一行
        // 为空白行）：硬换行不发生在块末尾（spec 例 644/645），块末行尾的
        // 尾随空白/反斜杠保持文本语义。近似判定（列表项/标题后紧邻行的
        // 精确块边界超出行级模型，登记偏差）。
        i === lines.length - 1 || lines[i + 1].trim() === '',
        // W2-5：围栏代码行的高亮语言键（computeLineOffsets 扫描产出；
        // 非代码行/无语言围栏为 null）
        fenceLangs[i],
        calloutTypes ? calloutTypes[i] : null,
        calloutTitles ? calloutTitles[i] : null,
        isCalloutHeaders ? isCalloutHeaders[i] : false
      );
    }
    return {
      lines: lineNodes,
    };
  }

  /** 引用定义表快照 id 计数器（文档级隔离 + 缓存键区分） */
  private static refTableCounter = 0;

  /**
   * 引用链接定义预扫描（02 §2.3 / review-02 §7.3）：
   * - 收集 `[label]: destination "title"`（≤3 前导空格；label 不含未转义 `]`），
   *   label 归一化（3.1.4：空白折叠 + 大小写折叠 + 实体解码，转义不折叠）后入表；
   * - 定义行与参与行标记 flags（parseLine 零输出为 'empty' 行）；
   * - 支持 destination/title 跨行（`[foo]:\n/url`、`[foo]:\n<url>\n'title'`、
   *   title 跨行到闭合引号）与「首次定义优先」（重复 label 只记第一处）；
   * - 不支持 label 跨行（`[\nfoo\n]:`，02 登记偏差）；
   * - 定义不能打断段落（`Foo\n[bar]: /baz` → 段落延续，spec 例 22）；
   * - 代码块（fence/indent）内不收集。
   * 返回值：refs（无定义时为 null，渲染路径 parseLine 不传表即按文本回退）。
   */
  private static collectReferenceDefinitions(
    lines: string[],
    codeBlockState: CodeState[]
  ): { refs: RefDefTable | null; flags: boolean[] } {
    const n = lines.length;
    const flags: boolean[] = new Array(n).fill(false);
    const table = new Map<string, RefDefinition>();
    let anyDef = false;
    // 多行定义状态机：needDest（`[foo]:` 后等 destination 行）/
    // needTitle（dest 行后等 title 行）/ inTitle（title 跨行收集）
    let mode: 'none' | 'needDest' | 'needTitle' | 'inTitle' = 'none';
    let defLabel = '';
    let defUrl = '';
    let defStart = -1;
    let titleQuote = '';
    let titleContent = '';
    // title 跨行收集时，开引号后紧跟行尾换行（例 5）→ 首个续行前补 `\n`
    let titleLeadNewline = false;
    // 上一非代码行是否为「段落形态」（定义不能打断段落）
    let prevParagraphish = false;

    const register = (label: string, url: string, title?: string) => {
      const key = this.normalizeRefLabel(label);
      if (!table.has(key)) {
        table.set(key, {
          // 目标/标题：实体解码（跳过 \&）→ 转义还原（\* → *、\b 保留）
          url: this.unescapePunctuation(this.decodeEntitiesInString(url)),
          ...(title !== undefined
            ? {
                title: this.unescapePunctuation(
                  this.decodeEntitiesInString(title)
                ),
              }
            : {}),
        });
        anyDef = true;
      }
    };

    for (let i = 0; i < n; i++) {
      const inCode = codeBlockState[i] !== 'none';
      const stripped = this.stripBlockquoteContext(lines[i]);
      const content = stripped.content;
      const isBlank = content.trim() === '';

      if (inCode) {
        mode = 'none';
        prevParagraphish = false;
        continue;
      }

      if (mode === 'inTitle') {
        // title 跨行：当前行找闭合引号（例 5：`'title\nline1\nline2\n'`）
        const closeIdx = content.indexOf(titleQuote);
        if (closeIdx !== -1) {
          titleContent += content.slice(0, closeIdx);
          register(defLabel, defUrl, titleContent);
          flags[i] = true;
          mode = 'none';
          prevParagraphish = false;
          titleLeadNewline = false;
        } else {
          // 开引号在行尾（例 5）：首个续行前补 `\n`
          titleContent += (titleLeadNewline ? '\n' : '') + content + '\n';
          titleLeadNewline = false;
          flags[i] = true;
        }
        continue;
      }

      if (mode === 'needTitle') {
        // dest 行之后：可选 title 行（引号形式，可跨行）
        const t = content.match(
          /^ {0,3}("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))[ \t]*$/
        );
        if (t) {
          const q = t[1][0];
          const inner = t[1].slice(1, -1);
          if (t[1].endsWith(q)) {
            register(defLabel, defUrl, inner);
            mode = 'none';
            prevParagraphish = false;
          } else {
            // 未闭合（行尾是开引号）：进入跨行收集
            titleQuote = q;
            titleContent = inner;
            mode = 'inTitle';
            prevParagraphish = false;
          }
          flags[i] = true;
        } else if (isBlank) {
          // 空行：定义无 title 结束（空行本身不是定义行）
          register(defLabel, defUrl);
          mode = 'none';
          prevParagraphish = false;
        } else {
          // 非法续行：整条定义作废，撤销已标行
          for (let j = defStart; j < i; j++) flags[j] = false;
          mode = 'none';
          prevParagraphish = true;
        }
        continue;
      }

      if (mode === 'needDest') {
        // `[foo]:` 之后：当前行必须是 destination（`<...>` 或裸 URL 单段）
        const d = content.match(
          /^ {0,3}(<[^<>\n\x00-\x1F]*>|[^ \t\n\r\f<>]+)[ \t]*$/
        );
        if (d && !isBlank) {
          defUrl = d[1];
          if (defUrl.startsWith('<')) defUrl = defUrl.slice(1, -1);
          flags[i] = true;
          mode = 'needTitle';
          prevParagraphish = false;
        } else {
          // 空行或非法行：定义作废（例 8：`[foo]:` + 空行 → 正文）
          flags[defStart] = false;
          mode = 'none';
          prevParagraphish = !isBlank;
        }
        continue;
      }

      // —— 普通行：尝试单行定义 / 进入 pending ——
      // label 支持转义 `\]`（`[Foo*bar\]]:...`，spec 例 3）
      const single = content.match(/^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(.*)$/);
      if (single && !prevParagraphish) {
        const label = single[1];
        const rest = single[2].trim();
        if (rest === '') {
          // `[foo]:` 空目标：等待下一行 destination（例 2/4/7）
          defLabel = label;
          defStart = i;
          flags[i] = true;
          mode = 'needDest';
          prevParagraphish = false;
          continue;
        }
        const full = rest.match(
          /^(<[^<>\n\x00-\x1F]*>|[^ \t\n\r\f<>]+)(?:[ \t]+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\)))?[ \t]*$/
        );
        if (full) {
          let url = full[1];
          if (url.startsWith('<')) url = url.slice(1, -1);
          const titleRaw = full[2];
          if (titleRaw) {
            const q = titleRaw[0];
            if (titleRaw.endsWith(q)) {
              register(label, url, titleRaw.slice(1, -1));
            } else {
              // 行尾未闭合开引号：跨行收集（例 5 `[foo]: /url '`）
              defLabel = label;
              defUrl = url;
              defStart = i;
              titleQuote = q;
              // 开引号后紧跟行尾换行：续行前需补 `\n`（title 以换行开头）
              titleContent = titleRaw.length > 1 ? titleRaw.slice(1) : '';
              titleLeadNewline = true;
              mode = 'inTitle';
              flags[i] = true;
              prevParagraphish = false;
              continue;
            }
          } else {
            register(label, url);
          }
          flags[i] = true;
          prevParagraphish = false;
          continue;
        }
        // 非法（例 10 `<bar>(baz)`、例 18 多余内容）：按正文。
        // 例外：dest 后跟单个未闭合开引号 → title 跨行收集（例 5 `[foo]: /url '`）
        const openTitle = rest.match(
          /^(<[^<>\n\x00-\x1F]*>|[^ \t\n\r\f<>]+)[ \t]+('|")$/
        );
        if (openTitle) {
          let url = openTitle[1];
          if (url.startsWith('<')) url = url.slice(1, -1);
          defLabel = label;
          defUrl = url;
          defStart = i;
          titleQuote = openTitle[2];
          titleContent = '';
          titleLeadNewline = true;
          mode = 'inTitle';
          flags[i] = true;
          prevParagraphish = false;
          continue;
        }
        prevParagraphish = true;
        continue;
      }
      mode = 'none';
      prevParagraphish = !isBlank && this.isParagraphishLine(content);
    }

    return {
      refs: anyDef ? { id: ++this.refTableCounter, table } : null,
      flags,
    };
  }

  /**
   * 行首形态是否为「段落」（引用定义打断判定 + 定义行/标题等排除）：
   * 空行、hr、Setext 下划线形态（`===`/`---`）、ATX 标题、列表、表格、
   * 已标记的定义行都不是段落。
   */
  private static isParagraphishLine(content: string): boolean {
    const s = content.replace(/^ {0,3}/, '');
    if (!s.trim()) return false;
    if (/^([-*+_]){3,}[ \t]*$/.test(s)) return false;
    if (/^(=+|-+)[ \t]*$/.test(s)) return false;
    if (/^#{1,6}(?:[ \t]|$)/.test(s)) return false;
    if (/^([-*+]\s*\[[xX\s]\])\s+/.test(s)) return false;
    if (/^([-*+])\s+/.test(s)) return false;
    if (/^(\d+\.)\s+/.test(s)) return false;
    if (/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(s)) return false;
    const pipeCount = (s.match(/\|/g) || []).length;
    if ((pipeCount >= 1 && s.trim().startsWith('|')) || pipeCount >= 2) {
      return false;
    }
    return true;
  }

  /**
   * label 归一化（CommonMark 3.1.4）：去首尾空白、内部空白折叠为单空格、
   * 大小写折叠（toLowerCase）、实体解码；反斜杠转义不折叠（例 64：
   * `[foo\!]` 不匹配 `[foo!]` 定义）。
   */
  private static normalizeRefLabel(s: string): string {
    return this.decodeEntitiesInString(
      s.replace(/\s+/g, ' ').trim().toLowerCase()
    );
  }

  public static computeLineOffsets(text: string): {
    offsets: number[];
    codeBlockState: CodeState[];
    setextLevels: number[];
    listContexts: (ListContext | null)[];
    // B8a：懒延续行继承的块引用层级（null = 非懒延续行）——无块引用标记
    // （或标记层数不足）的段落延续行按 spec 5.2 Laziness 规则继承前一
    // 非空白块引用段落行的容器层级，供 parseLine 覆盖文本前缀计算值。
    lazyContinuation: (number | null)[];
    // W2-5：围栏代码行的高亮语言键（python/sql/bash，null = 无语言回退
    // JS 关键字集）——围栏扫描在 fence_start 行从 info 串提取，块内
    // code 行继承（含空行），fence_end 归 null。供 parseLine 按语言
    // 分发关键字表（S-T-2-08）。
    fenceLangs: (string | null)[];
    // Callout 提示块类型与标题追踪（> [!NOTE] 等）
    calloutTypes: (CalloutType | null)[];
    calloutTitles: (string | null)[];
    isCalloutHeaders: boolean[];
  } {
    const lines = text.split('\n');
    const offsets = new Array(lines.length);
    const codeBlockState: CodeState[] = new Array(lines.length);
    // R1.5-B：逐行列表延续上下文（仅「空行后列表项延续」行非 null）
    const listContexts: (ListContext | null)[] = new Array(lines.length).fill(
      null
    );
    // B8a：逐行懒延续层级（默认非懒延续）
    const lazyContinuation: (number | null)[] = new Array(lines.length).fill(
      null
    );
    // W2-5：逐行围栏语言键（默认无语言；仅围栏代码内容行非 null）
    const fenceLangs: (string | null)[] = new Array(lines.length).fill(null);
    const calloutTypes: (CalloutType | null)[] = new Array(lines.length).fill(
      null
    );
    const calloutTitles: (string | null)[] = new Array(lines.length).fill(null);
    const isCalloutHeaders: boolean[] = new Array(lines.length).fill(false);
    let currentCallout: {
      type: CalloutType;
      title: string;
      level: number;
    } | null = null;

    let currentOffset = 0;
    let inCodeBlock = false;
    let inMathBlock = false;
    // 围栏状态（02 §7.3/§7.4 修复）：记录开围栏的标记字符与长度——
    // CommonMark 关闭围栏必须同字符（反引号/波浪线不可混用）且长度 ≥ 开栏长度
    // （```` 开栏不能被 ``` 关闭，spec Fenced code "at least as long as"）；
    // 取代旧的 `startsWith('```')` 布尔切换（3 反引号会错误关闭 4 反引号、
    // ` ``` js` 信息串行被错误当作关闭行，02 §7.2 实证 FENCE34/FENCEINFO）。
    // B8a：增加 level 字段——围栏跨行要求块引用层级一致（spec 例 237：
    // 引用内开栏后无标记行 → 围栏随容器结束，无前缀行是新围栏/普通行）。
    let fenceState: {
      marker: string;
      length: number;
      level: number;
    } | null = null;
    // W2-5：当前打开的围栏的（规范化）语言键——fence_start 行从 info 串
    // 提取，块内 code 行（含空行）继承；fence 关闭/强制终止时归 null。
    let fenceLang: string | null = null;
    // 数学块起始行的块引用层级（B8a：与围栏同一致性语义）
    let mathFenceLevel = 0;
    // 缩进代码块状态（02 §2.2）：连续 ≥4 空格缩进行合并为一个代码块，
    // 块内空行保持状态（CommonMark：空行仍是代码块的一部分）。
    // B8a：增加 level 字段——缩进代码跨行同样要求块引用层级一致
    // （spec 例 252：`>     code` 的块止于空行，`>    not code` 是新容器）。
    let inIndentCode = false;
    let indentCodeLevel = 0;
    // 上一非空白行的块级形态记忆（见 BlockKind 注释）——行级模型无容器状态，
    // 用轻量行首形态分类近似「上一行是什么」，不依赖 parseLine（避免递归依赖）。
    let prevBlockKind: BlockKind = 'blank';
    // HTML 块状态（02 §2.5 / R1-D）：inHtmlBlock 为块内标记，htmlType 记录
    // 当前块类型（1-7，决定结束条件）——type 1-5 遇匹配闭合行退出、
    // type 6/7 遇空行退出（空行本身不是块，标记 'none'，CommonMark 4.6）。
    let inHtmlBlock = false;
    let htmlType = 0;
    // R1.5-B 列表上下文记忆：最近列表标记行的内容缩进列（markerWidth）——
    // 空行后首行缩进与之比较，判定「列表项延续 / li 内代码块 / 出列表」。
    let listCtx: ListContext | null = null;
    // 上一行是否为空白行：列表延续与 li 内代码块的判定只作用于
    // 「空行后首行」（紧邻延续由 prevBlockKind === 'list' 单独接管，
    // 代码块不能打断段落——spec §5.2 例 264 语义）。
    let justBlank = false;
    // B8a：懒延续判定的「前一非空白行是块引用内打开的段落」记忆——
    // prevParagraphOpen = 前一行是 body 行且其块引用层级 ≥1（段落已打开）；
    // prevBqLevel = 该行继承后的层级（懒延续行继续传递，例 233 三行链）。
    let prevParagraphOpen = false;
    let prevBqLevel = 0;

    for (let i = 0; i < lines.length; i++) {
      offsets[i] = currentOffset;
      // 块引用前缀剥离（与 parseNormalLine 同一正则 `^ {0,3}>\s?`）：缩进判定发生
      // 在前缀剥离之后（`>     code` → 块引用内缩进代码）。B8a：前缀限至多
      // 3 空格缩进（spec 例 231——`    > foo` 是缩进代码块，不再是块引用）。
      const { level: bqSelfLevel, content: bqContent } =
        this.stripBlockquoteContext(lines[i]);
      const trimmed = bqContent.trim();

      // Callout 提示块判定与延续（CommonMark / GFM Alert 语法）
      const calloutMatch = trimmed.match(
        /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i
      );
      if (bqSelfLevel > 0 && calloutMatch) {
        currentCallout = {
          type: calloutMatch[1].toLowerCase() as CalloutType,
          title: calloutMatch[2]?.trim() || '',
          level: bqSelfLevel,
        };
        calloutTypes[i] = currentCallout.type;
        calloutTitles[i] = currentCallout.title;
        isCalloutHeaders[i] = true;
      } else if (
        currentCallout &&
        bqSelfLevel >= currentCallout.level &&
        lines[i].trim() !== ''
      ) {
        calloutTypes[i] = currentCallout.type;
        calloutTitles[i] = currentCallout.title;
        isCalloutHeaders[i] = false;
      } else if (
        bqSelfLevel < (currentCallout?.level ?? 1) ||
        lines[i].trim() === ''
      ) {
        currentCallout = null;
      }

      // —— B8a：懒延续判定（spec 5.2 Laziness 规则 2）——
      // 前一非空白行是块引用内打开的段落（body 且层级 ≥1）且本行非空行后的
      // 首行（空行阻断懒延续，例 248），且本行的标记层数**不足**（bqSelfLevel
      // < prevBqLevel——标记层数足够时按自身层级解析，`> q\n> > deep` 的
      // 第二行自身 2 层不懒延续），且本行剥离自身标记后的内容属于
      // 「段落延续文本」（缩进代码不能打断段落、hr/ATX/表格/列表/围栏/
      // HTML 块等块结构可打断）→ 本行继承前一行的块引用层级。
      // 例 250/251：嵌套引用中可省略任意数量的 `>`（`> bar` 自身 1 层、
      // 懒延续到 `>>> foo` 的 3 层容器——继承以段落层级为准）。
      let lazyInherit: number | null = null;
      if (prevParagraphOpen && !justBlank && bqSelfLevel < prevBqLevel) {
        if (this.isParagraphContinuationText(bqContent, prevBlockKind)) {
          lazyInherit = prevBqLevel;
          lazyContinuation[i] = lazyInherit;
        }
      }

      // 围栏形态判定（开/关共用，trim 后行）：反引号 run ≥3（info 串不允许
      // 含反引号——spec 原文：backtick fences 的 info string 不能含 backtick，
      // ` ``` aa `` ` 整行不是围栏，退化为段落）或波浪线 run ≥3（info 串无限制，
      // `~~~ aa ``` ~~~` 合法）。
      // B8c（spec 例 134/137）：开/闭围栏行允许至多 3 空格缩进——前导缩进
      // ≥4 列（tab 按停靠 4 展开）的行不是围栏形态（`    ``` 是缩进代码块
      // 的内容，spec 例 134）；开围栏行 1-3 空格缩进合法（spec 例 131-133，
      // 开行缩进量的内容剥除属投影器配合项）。indentCols 在剥离块引用
      // 前缀后的内容行上计算（`> ``` 为 0 列、`>   ``` 为 2 列）。
      const indentCols = this.leadingIndentColumns(bqContent);
      const fenceOpen =
        indentCols <= 3 ? /^(```+)([^`]*)$|^(~~~+).*$/.exec(trimmed) : null;
      // HTML 块内行：优先级最高——fence/math/缩进代码判定全部让路
      // （spec 4.6：「HTML 块内的 HTML 若可被识别为 start condition 将
      // 原样透传、不改变解析器状态」——`<div>` 块内的 ``` 围栏行、`<pre>`
      // 形态行均按 html 原样处理，spec 例 161/148）。
      if (inHtmlBlock) {
        if (this.htmlBlockEndCondition(htmlType, bqContent)) {
          inHtmlBlock = false;
          htmlType = 0;
          if (bqContent.trim() === '') {
            // type 6/7 空行结束块：空行本身不是块内容，按普通空行处理
            // （`<hr>\n\nok` 的中间空行是 'none'，spec：end condition 是
            // 「line is followed by a blank line」——块止于空行之前）。
            codeBlockState[i] = 'none';
            justBlank = true;
            if (prevBlockKind !== 'list') prevBlockKind = 'blank';
          } else {
            // type 1-5 结束行（行内含闭合标记）：该行仍是块的最后一行。
            codeBlockState[i] = 'html_block';
            prevBlockKind = 'code';
          }
        } else {
          codeBlockState[i] = 'html_block';
          // 块形态记作 code 类：块后 ≥4 空格行允许开始缩进代码
          // （type 7 单行块后 `    foo` → 缩进代码，与 CommonMark 一致）。
          prevBlockKind = 'code';
        }
      } else if (
        inCodeBlock &&
        fenceState &&
        bqSelfLevel !== fenceState.level &&
        // 空行不在此强制关闭（空行懒匹配所有容器——fence 内空行保持，
        // 后续非空行若不匹配容器则触发关闭并回写这些空行，见下）
        trimmed !== ''
      ) {
        // —— B8a：围栏跨行容器层级不匹配（spec 例 237）——
        // 引用内开栏（`> ```` ）后紧跟无标记行：块引用容器在无标记行处
        // 结束，围栏随容器一起终止（围栏内容必须全在容器内），本行
        // 重新按普通行判定（可能自身开启新围栏，如例 237 的第三行 ````）。
        // spec（Fenced code blocks 章节）实证：`> ````\n> aaa\n\nbbb` 的
        // 空行也不属于 fence 内容——关闭时回写 fence 内尾随空行为 none。
        inCodeBlock = false;
        fenceState = null;
        fenceLang = null;
        this.closeBlockTrailingBlanks(lines, codeBlockState, i);
        if (!inMathBlock && fenceOpen) {
          codeBlockState[i] = 'fence_start';
          fenceState = {
            marker: fenceOpen[1] !== undefined ? '`' : '~',
            length: (fenceOpen[1] ?? fenceOpen[3]).length,
            level: bqSelfLevel,
          };
          // W2-5：从 info 串提取语言（反引号 info 在 [2]；波浪线开栏的
          // info 无捕获组——原正则 `^(~~~+).*$` 未捕获，从 trimmed 剥 run）
          fenceLang = this.normalizeFenceLang(
            fenceOpen[1] !== undefined
              ? fenceOpen[2]
              : trimmed.replace(/^~+/, '')
          );
          fenceLangs[i] = fenceLang;
          inCodeBlock = true;
        } else {
          // 非围栏形态行：落到下方的普通行判定链
          codeBlockState[i] = 'none';
          prevBlockKind = this.guessBlockKind(bqContent, prevBlockKind);
          inIndentCode = false;
        }
      } else if (
        inMathBlock &&
        bqSelfLevel !== mathFenceLevel &&
        trimmed !== ''
      ) {
        // —— B8a：数学块跨行容器层级不匹配（与围栏同一致性语义）——
        // `> $$` 开数学块后无标记行 → 数学块随容器终止，本行按普通行处理；
        // 数学块内尾随空行同样回写（与围栏规则一致）。
        inMathBlock = false;
        this.closeBlockTrailingBlanks(lines, codeBlockState, i);
        if (trimmed === '$$') {
          codeBlockState[i] = 'math_fence_start';
          mathFenceLevel = bqSelfLevel;
          inMathBlock = true;
        } else if (trimmed === '') {
          codeBlockState[i] = 'none';
          justBlank = true;
          if (prevBlockKind !== 'list') prevBlockKind = 'blank';
        } else {
          codeBlockState[i] = 'none';
          prevBlockKind = this.guessBlockKind(bqContent, prevBlockKind);
          inIndentCode = false;
        }
      } else if (!inMathBlock && fenceOpen) {
        if (!inCodeBlock) {
          // 开围栏：记录标记字符、run 长度与起始行块引用层级（B8a——
          // 后续行的关闭/跨容器判定以「同字符 + run 长度 ≥ 开栏长度 +
          // 层级一致」为准，spec 例 237）。
          codeBlockState[i] = 'fence_start';
          fenceState = {
            marker: fenceOpen[1] !== undefined ? '`' : '~',
            length: (fenceOpen[1] ?? fenceOpen[3]).length,
            level: bqSelfLevel,
          };
          // W2-5：从 info 串提取语言（反引号 info 在 [2]；波浪线开栏的
          // info 无捕获组——原正则 `^(~~~+).*$` 未捕获，从 trimmed 剥 run）
          fenceLang = this.normalizeFenceLang(
            fenceOpen[1] !== undefined
              ? fenceOpen[2]
              : trimmed.replace(/^~+/, '')
          );
          fenceLangs[i] = fenceLang;
          inCodeBlock = true;
        } else if (fenceState) {
          // 代码块内：仅「同字符 + run 长度 ≥ 开栏长度 + 行内除尾随空白
          // 无信息串」才关闭；` ``` js`（信息串）与 3 反引号关 4 反引号
          // 均保持 code（spec：closing fence 不能有 info string）。
          // 判定经 isFenceClose 共享函数（P2-A1 fence 单源化：与 EditorStore
          // 增量状态机共用同一完整关闭条件，消除 fence_end 行尾插入的
          // 增量/重扫分歧——见 isFenceClose 定义注释）。
          if (isFenceClose(trimmed, fenceState.marker, fenceState.length)) {
            codeBlockState[i] = 'fence_end';
            fenceState = null;
            fenceLang = null;
            fenceLangs[i] = null;
            inCodeBlock = false;
          } else {
            codeBlockState[i] = 'code';
            fenceLangs[i] = fenceLang;
          }
        } else {
          // 防御：理论上不会出现「inCodeBlock 但无状态」的中间态
          codeBlockState[i] = 'code';
          fenceLangs[i] = fenceLang;
        }
        // 围栏代码块内缩进不生效（CommonMark）；fence 判定先于缩进代码，
        // 且 `    ```（4 空格）已由 B8c 围栏缩进门挡在围栏形态之外——
        // 落入下方缩进代码判定（spec 例 134，02 §7.2 登记偏差已修复）。
        inIndentCode = false;
        prevBlockKind = 'code';
      } else if (!inCodeBlock && trimmed === '$$') {
        if (!inMathBlock) {
          codeBlockState[i] = 'math_fence_start';
          // B8a：记录数学块起始行的块引用层级（跨容器一致性判定用）
          mathFenceLevel = bqSelfLevel;
          inMathBlock = true;
        } else {
          codeBlockState[i] = 'math_fence_end';
          inMathBlock = false;
        }
        inIndentCode = false;
        prevBlockKind = 'code';
      } else if (inCodeBlock) {
        codeBlockState[i] = 'code';
        // W2-5：围栏内行（含空行）继承当前围栏语言键
        fenceLangs[i] = fenceLang;
        inIndentCode = false;
        prevBlockKind = 'code';
      } else if (inMathBlock) {
        codeBlockState[i] = 'math_block';
        inIndentCode = false;
        prevBlockKind = 'code';
      } else {
        // —— 缩进代码块判定（02 §2.2）——
        const indent = this.leadingIndentColumns(bqContent);
        if (inIndentCode) {
          // —— B8a：缩进代码块跨行容器层级不匹配（spec 例 252）——
          // 引用内缩进代码（`>     code`）止于容器变化处：无标记行/空行
          // 的层级与开块行不同 → 代码块结束，本行重新走下方判定链
          // （空行按空行处理、`    bar` 在文档根开新代码块，例 236）。
          if (indentCodeLevel !== 0 && bqSelfLevel !== indentCodeLevel) {
            inIndentCode = false;
            indentCodeLevel = 0;
          }
        }
        if (inIndentCode) {
          // 块内：空行与 ≥4 空格缩进行保持状态；非缩进行结束代码块。
          if (trimmed === '' || indent >= 4) {
            codeBlockState[i] = 'indent_code';
          } else {
            // 非缩进行结束代码块：该行按普通行处理（可能开启 HTML 块——
            // CommonMark 中缩进代码块后的 `</div>` 行是 type 6 块）。
            inIndentCode = false;
            indentCodeLevel = 0;
            const htmlStart = this.matchHtmlBlockStart(
              bqContent,
              prevBlockKind
            );
            if (htmlStart) {
              codeBlockState[i] = 'html_block';
              inHtmlBlock = true;
              htmlType = htmlStart.type;
              if (this.htmlBlockEndCondition(htmlStart.type, bqContent)) {
                inHtmlBlock = false;
                htmlType = 0;
              }
              prevBlockKind = 'code';
            } else {
              codeBlockState[i] = 'none';
              prevBlockKind = this.guessBlockKind(bqContent, prevBlockKind);
            }
          }
        } else if (trimmed === '') {
          // 空行：不进入缩进代码；段落/表格上下文重置（段落打断规则失效，
          // `para\n\n    code` 是代码块），列表上下文保持
          // （`- item\n\n    bar` 仍是松散列表延续）。
          codeBlockState[i] = 'none';
          justBlank = true;
          if (prevBlockKind !== 'list') prevBlockKind = 'blank';
        } else if (indent >= 4) {
          const afterIndent = this.stripFourColumns(bqContent);
          if (lazyInherit !== null) {
            // —— B8a：懒延续行（spec 例 238）——
            // `> foo\n    - bar`：4 空格缩进行在前一非空白行是块引用段落时
            // 是「段落延续文本」（缩进代码不能打断段落、列表标记缩进过深
            // 无法开项——spec 说明实证），必须按 body 延续解析，嵌套列表/
            // 缩进代码判定全部让路（缩进代码块只在段落未打开时成立）。
            codeBlockState[i] = 'none';
            inIndentCode = false;
            prevBlockKind = 'body';
          } else if (this.isListMarkerStart(afterIndent)) {
            // 去缩进后以列表标记开头 → 嵌套列表/列表延续，按 body 解析。
            // 任务书简化：无条件列表优先（登记偏差——CommonMark 中文档级
            // `    - foo` 期望缩进代码，行级模型无列表容器状态无法区分）。
            codeBlockState[i] = 'none';
            inIndentCode = false;
            prevBlockKind = 'list';
            // R1.5-B：嵌套列表标记 → 列表上下文更新为嵌套列表（空行后
            // 延续以嵌套列表的内容缩进列为基准，而非外层列表）。
            const nestedInfo = this.listMarkerInfo(afterIndent);
            if (nestedInfo) {
              const ctxIndent = this.leadingIndentColumns(bqContent);
              listCtx = {
                indent: ctxIndent,
                markerWidth: ctxIndent + nestedInfo.markerWidth,
              };
            }
          } else if (prevBlockKind === 'list' && justBlank && listCtx) {
            // —— R1.5-B：空行后的列表上下文（spec 例 255-258/264 语义）——
            if (indent >= listCtx.markerWidth + 4) {
              // 缩进 ≥ 内容缩进 + 4：li 内缩进代码块（例 264：`- Foo\n\n
              //       bar` → 6 列 = 内容缩进 2 + 4）。空行分隔是必要条件——
              // 紧邻缩进行（R1-A2b）按段落延续处理，代码块不能打断段落。
              codeBlockState[i] = 'indent_code';
              inIndentCode = true;
              indentCodeLevel = bqSelfLevel;
              prevBlockKind = 'code';
            } else if (indent >= listCtx.markerWidth) {
              // 内容缩进 ≤ 缩进 < 内容缩进 + 4：列表项延续（例 256/258）——
              // 行按 body 解析并携带列表上下文（listIndent + listContinuation）。
              codeBlockState[i] = 'none';
              inIndentCode = false;
              listContexts[i] = {
                indent: listCtx.indent,
                markerWidth: listCtx.markerWidth,
              };
              prevBlockKind = 'list';
            } else {
              // 缩进 < 内容缩进：出列表（例 255/257）。≥4 缩进的出列行按
              // 缩进代码块处理（例 257：`     two` → `<pre><code> two`）。
              listCtx = null;
              inIndentCode = false;
              codeBlockState[i] = 'indent_code';
              inIndentCode = true;
              indentCodeLevel = bqSelfLevel;
              prevBlockKind = 'code';
            }
          } else if (
            prevBlockKind === 'body' ||
            prevBlockKind === 'list' ||
            prevBlockKind === 'table'
          ) {
            // 段落打断规则（`Foo\n    bar` → 段落延续）、列表延续
            // （`- item\n    cont`）、表格优先（GFM 允许缩进表格）→ 均不进代码；
            // prevBlockKind 保持不变（延续可能有多行）。
            codeBlockState[i] = 'none';
            inIndentCode = false;
          } else {
            // 进入缩进代码块（上一行是空行 / 标题 / 分隔线 / 代码 / 块引用等）。
            codeBlockState[i] = 'indent_code';
            inIndentCode = true;
            indentCodeLevel = bqSelfLevel;
            prevBlockKind = 'code';
          }
        } else {
          // HTML 块 start 判定（缩进 <4、非空行）：type 1-6 可打断段落，
          // 判定独立于 prevBlockKind（`Foo\n<div>` 中 div 是新块，spec 例 185）；
          // type 7 段落保护在 matchHtmlBlockStart 内部（prevBlockKind 为
          // body/list 时禁用——`Foo\n<a href="bar">` 中 a 行是段落延续，
          // spec 例 187；列表延续同理由行级模型无容器状态登记为偏差）。
          const htmlStart = this.matchHtmlBlockStart(bqContent, prevBlockKind);
          if (htmlStart) {
            codeBlockState[i] = 'html_block';
            inHtmlBlock = true;
            htmlType = htmlStart.type;
            // 首行同时满足 end condition → 单行块（`<!-- c -->`、
            // `<!DOCTYPE html>`、`<style>p{color:red;}</style>` 等）。
            if (this.htmlBlockEndCondition(htmlStart.type, bqContent)) {
              inHtmlBlock = false;
              htmlType = 0;
            }
            prevBlockKind = 'code';
          } else {
            // 先做轻量块级形态分类：列表标记行记录列表上下文（R1.5-B）；
            // 「段落形态」行在空行后且缩进 ≥ 内容缩进时是列表项延续
            // （例 256/258/262/277）——hr/ATX/表格等形态让路（保持既有语义）。
            const g = this.guessBlockKind(bqContent, prevBlockKind);
            if (g === 'list') {
              const info = this.listMarkerInfo(
                this.stripFourColumns(bqContent)
              );
              if (info) {
                // 内容缩进列 = 前导缩进 + 标记段列宽（spec §5.2 例 257/258）
                listCtx = {
                  indent,
                  markerWidth: indent + info.markerWidth,
                };
              }
              codeBlockState[i] = 'none';
              prevBlockKind = 'list';
            } else if (
              g === 'body' &&
              prevBlockKind === 'list' &&
              justBlank &&
              listCtx &&
              indent >= listCtx.markerWidth
            ) {
              // 空行后首行缩进 ≥ 内容缩进：列表项延续（新段落）——
              // 行按 body 解析并携带列表上下文（listIndent + listContinuation）。
              codeBlockState[i] = 'none';
              listContexts[i] = {
                indent: listCtx.indent,
                markerWidth: listCtx.markerWidth,
              };
              prevBlockKind = 'list';
            } else {
              if (
                prevBlockKind === 'list' &&
                justBlank &&
                listCtx &&
                indent < listCtx.markerWidth
              ) {
                // 缩进 < 内容缩进：出列表（例 255），记忆清除防后续误续
                listCtx = null;
              }
              codeBlockState[i] = 'none';
              prevBlockKind = g;
            }
          }
        }
      }

      // R1.5-B：非空行在迭代末尾重置「上一行空白」记忆——justBlank 语义是
      // 「上一行（i-1）为空白行」，必须在下一行迭代开始时保持有效，
      // 因此重置放在迭代末尾而非开头。
      // B8a：同步维护懒延续判定的「块引用段落打开」记忆——非空行按本行
      // 最终形态（prevBlockKind 由各分支设置）更新；空行关闭段落
      // （`> bar\n\nbaz` 中 baz 不懒延续，spec 例 248）。懒延续行自身
      // 也是 body 段落（例 233 三行链由此逐行传递）。
      if (trimmed !== '') {
        justBlank = false;
        prevBqLevel = lazyInherit !== null ? lazyInherit : bqSelfLevel;
        prevParagraphOpen = prevBlockKind === 'body' && prevBqLevel >= 1;
      } else {
        prevParagraphOpen = false;
        prevBqLevel = 0;
      }

      currentOffset += lines[i].length + 1; // +1 for \n
    }

    // Setext 预扫描（紧随 computeLineOffsets 状态机，单趟 O(n)）：
    // 产出每行的 Setext 上下文标志，供 parseLine 消费（见 §2.1 与 review-02 §7.1）。
    // B8a：懒延续行不参与 Setext——`> bar\nbaz\n---` 中 baz 是块引用段落
    // 的延续行，`---` 对其不构成 Setext 下划线（否则 baz 被误升级为标题）。
    const setextLevels = this.computeSetextContexts(
      lines,
      codeBlockState,
      lazyContinuation
    );

    return {
      offsets,
      codeBlockState,
      setextLevels,
      listContexts,
      lazyContinuation,
      fenceLangs,
      calloutTypes,
      calloutTitles,
      isCalloutHeaders,
    };
  }

  /**
   * 围栏 info 串 → 高亮语言键（W2-5）：取首个空白分隔 token 并小写化；
   * python/sql/bash（含常见别名）返回规范化键，其余（含 js 系别名与
   * 未识别语言）一律归 null——null 回退 JS 关键字集（与语言无关的
   * 既有高亮行为完全一致），且与行级渲染路径（LineItem 不传 lang）
   * 共享同一缓存键，无重复缓存条目。
   */
  private static normalizeFenceLang(info: string): string | null {
    const first = info.trim().split(/\s+/)[0]?.toLowerCase();
    if (!first) return null;
    if (first === 'python' || first === 'py') return 'python';
    if (first === 'sql') return 'sql';
    if (first === 'bash' || first === 'sh' || first === 'shell') return 'bash';
    return null;
  }

  /**
   * W2-5：围栏语言 → 关键字表（S-T-2-08）。基础关键字集（启发式定位，
   * 跨语言正确性不追求完美——总方案 §4.6）。JS 集为 W2-5 之前的既有
   * 行为基线（无语言/未识别语言围栏与行级渲染路径共用），不得削减。
   */
  private static readonly CODE_KEYWORD_JS =
    'function|const|let|var|if|else|for|while|return|class|import|export|from|yield|await|async|switch|case|break|continue|default|typeof|instanceof|new|delete|try|catch|finally|throw|void|with';

  private static readonly CODE_KEYWORD_SETS: Record<string, string> = {
    python:
      'def|import|class|if|elif|else|for|while|return|self|None|True|False|and|or|not|in|is|lambda|try|except|finally|with|as|pass|break|continue|global|nonlocal|yield|assert|del|from|raise|async|await',
    // SQL 关键字经 'i' 标志大小写不敏感匹配（SELECT/from 同样命中）
    sql: 'select|from|where|insert|update|delete|create|alter|drop|table|join|left|right|inner|outer|on|group|by|order|having|limit|into|values|set|and|or|not|null|as|distinct|union|index|primary|key',
    bash: 'if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|echo|return|export|local|read|cd|source',
  };

  /** 语言键 → 关键字表源串；未知/空键一律回退 JS 集（null 语义） */
  private static getCodeKeywordSource(codeLang: string | null): string {
    return codeLang
      ? (this.CODE_KEYWORD_SETS[codeLang] ?? this.CODE_KEYWORD_JS)
      : this.CODE_KEYWORD_JS;
  }

  /**
   * 回写围栏/数学块内尾随空行（B8a，spec「A code block can have all empty
   * lines」的对偶）：容器因层级不匹配而强制关闭时，块内尾随的空白行
   * 不属于块内容（spec 实证：`> ````\n> aaa\n\nbbb` 的 fence 内容只有
   * `aaa`，空行随容器终止归文档根）。从 i-1 起向前把连续的空行 code/
   * math_block 状态回写为 none（空行懒匹配所有容器——容器在下一非空行
   * 处回溯闭合，空行随之出块）。
   */
  private static closeBlockTrailingBlanks(
    lines: string[],
    codeBlockState: CodeState[],
    i: number
  ): void {
    for (let j = i - 1; j >= 0; j--) {
      if (codeBlockState[j] !== 'code' && codeBlockState[j] !== 'math_block') {
        break;
      }
      if (lines[j].trim() !== '') break;
      codeBlockState[j] = 'none';
    }
  }

  /**
   * 剥离块引用前缀（与 parseLine / parseNormalLine / parseCodeLine 同一
   * 正则 `^ {0,3}>\s?`），返回前缀层级与剥离后的内容——Setext 判定必须
   * 发生在前缀剥离之后（02-解析器正确性.md §2.1 冲突点）。
   * B8c（spec 例 231）：marker 前至多 3 空格缩进——`    > foo`（4 空格）
   * 不再是块引用，落入缩进代码块判定（CommonMark：>3 空格缩进的 `>`
   * 行按缩进代码块处理）。贪婪 `\s*` 吞缩进的旧行为（`> >     > Even`
   * 剥成 3 层）为非 CommonMark 注册行为，B8a 已登记偏差，本轮收紧——
   * tests/unit/fuzz-document-typography.test.ts 的 3 层断言需同步
   * （测试断言更新登记，tests/ 域禁碰）；投影器 stripBlockquotePrefix
   * 同步收紧属 B8c 登记配合项（tests/commonmark/ 只读域）。
   */
  private static stripBlockquoteContext(line: string): {
    level: number;
    content: string;
  } {
    let level = 0;
    let content = line;
    let m: RegExpMatchArray | null;
    while ((m = content.match(/^ {0,3}>\s?/))) {
      level++;
      content = content.substring(m[0].length);
    }
    return { level, content };
  }

  /**
   * 计算行首缩进列宽（spec §Tabs：tab 按停靠 4 展开——`  →foo` = 2+4 = 6 列 ≥4 → 代码；
   * ` →foo` = 1+4 = 5 列 ≥4 → 代码；`  foo` = 2 列 <4 → 普通行）。
   * 只扫描行首连续空格/tab，遇到首个非空白字符即停。
   */
  private static leadingIndentColumns(s: string): number {
    let col = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === ' ') {
        col++;
      } else if (s[i] === '\t') {
        col += 4 - (col % 4);
      } else {
        break;
      }
    }
    return col;
  }

  /**
   * 剥离 4 列缩进（CommonMark：缩进代码块内容 = 行内容减去 4 空格缩进；
   * 超过 4 列的缩进保留进内容，如 8 空格 → 内容 `    foo`）。
   * 供「去缩进后行首是否为列表标记」判定使用。
   */
  private static stripFourColumns(s: string): string {
    let col = 0;
    let i = 0;
    while (i < s.length && col < 4) {
      if (s[i] === ' ') {
        col++;
        i++;
      } else if (s[i] === '\t') {
        col += 4 - (col % 4);
        i++;
      } else {
        break;
      }
    }
    return s.substring(i);
  }

  /**
   * 去缩进后行首是否为列表标记（task / 项目符号 / 有序，与 parseNormalLine 的
   * 列表判定正则一致）。行首必须是标记本身（无 `\s*` 前缀）——剥 4 列后
   * 仍以空格开头的内容（如 6 空格缩进）不算列表标记，文档级进入缩进代码。
   */
  private static isListMarkerStart(s: string): boolean {
    return (
      /^([-*+]\s*\[[xX\s]\])\s+/.test(s) ||
      /^([-*+])\s+/.test(s) ||
      /^(\d+\.)\s+/.test(s)
    );
  }

  /**
   * 列表标记信息（R1.5-B）：行首为列表标记（task / 项目符号 / 有序，与
   * parseNormalLine / guessBlockKind 同一正则族——task 优先于项目符号、
   * 项目符号优先于有序）时，返回标记前缀与「标记段列宽」（标记字符 +
   * 标记后空白，tab 按停靠 4 展开）。列表项内容缩进列 = 前导缩进 +
   * 标记段列宽（CommonMark §5.2 例 257/258 实证：`-    one` 的延续块需
   * 缩进 5 列、` -    one` 需 6 列、`1.  foo` 需 4 列）。
   * 特例（规范规则 #2/#3）：标记后无内容（空项，`-   `）或标记后空白
   * ≥5 列（首块为缩进代码，`1.     x`）时，内容缩进列 = 标记宽 W + 1
   * （例 273/274/279 语义）。
   */
  private static listMarkerInfo(
    content: string
  ): { prefix: string; markerWidth: number } | null {
    const m = /^([-*+]\s*\[[xX\s]\])[ \t]+|^([-*+])[ \t]+|^(\d+\.)[ \t]+/.exec(
      content
    );
    if (!m) return null;
    const prefix = m[1] ?? m[2] ?? m[3];
    // 标记段 = 标记字符 + 标记后空白（W + N 列）
    const markerSeg = m[0];
    const wPlusN = this.textColumns(markerSeg);
    const n = wPlusN - prefix.length;
    // 标记后无内容（空项）或空白 ≥5 列（首块为缩进代码）→ 内容缩进 = W + 1
    if (n >= 5 || content.slice(markerSeg.length) === '') {
      return { prefix, markerWidth: prefix.length + 1 };
    }
    return { prefix, markerWidth: wPlusN };
  }

  /** 字符串的渲染列宽（tab 按停靠 4 展开，与 leadingIndentColumns 同语义） */
  private static textColumns(s: string): number {
    let col = 0;
    for (const ch of s) {
      if (ch === ' ') {
        col++;
      } else if (ch === '\t') {
        col += 4 - (col % 4);
      } else {
        col++;
      }
    }
    return col;
  }

  /**
   * 段落延续文本判定（B8a，spec 5.2 Laziness 规则 2）：
   * 行（已剥离自身块引用标记）在「块引用段落已打开」的上下文中是否属于
   * 段落延续文本——是则允许懒延续（无标记行继承块引用层级）。
   * 判定语义「若补上块引用标记后会被解析为段落内容」：
   * - ≥4 空格缩进：一律是段落延续文本——缩进代码块不能打断段落，
   *   列表标记缩进过深无法开项（spec 例 238：`> foo\n    - bar`）；
   * - <4 空格：排除可打断段落的块结构——hr / ATX 标题 / Setext 下划线
   *   （前一行是段落时）/ 表格 / 列表标记 / 围栏 / HTML 块（type 1-6）。
   * 空行不算段落延续文本（懒延续要求紧跟段落，例 248）。
   */
  private static isParagraphContinuationText(
    content: string,
    prevBlockKind: BlockKind
  ): boolean {
    if (!content.trim()) return false;
    if (this.leadingIndentColumns(content) >= 4) return true;
    const s = content.replace(/^ {0,3}/, '');
    // 围栏形态（与 computeLineOffsets 的 fenceOpen 同一判定基线：
    // trim 后反引号 run ≥3 且 info 串不含反引号 / 波浪线 run ≥3）
    if (/^(```+)([^`]*)$/.test(s) || /^(~~~+).*$/.test(s)) return false;
    // HTML 块 start（type 1-6 可打断段落；type 7 在段落后是段落延续——
    // matchHtmlBlockStart 对 prevBlockKind==='body' 已禁用 type 7）
    if (this.matchHtmlBlockStart(content, prevBlockKind)) return false;
    return this.guessBlockKind(content, prevBlockKind) === 'body';
  }

  /**
   * 轻量行首形态分类（computeLineOffsets 专用，供缩进代码判定的「上一行」上下文）：
   * 与 parseNormalLine 的块级判定顺序一致（hr → ATX → 表格 → 列表），
   * 只做行首前缀匹配、不解析内容——避免 computeLineOffsets 依赖 parseLine（递归）。
   * prev 为上一非空白行的形态，用于 Setext 下划线形态（`====`）的两行级判定：
   * 上一行是段落 → 该行为 Setext 标题（heading），否则只是普通段落（body）。
   */
  private static guessBlockKind(line: string, prev: BlockKind): BlockKind {
    const s = line.replace(/^ {0,3}/, '');
    if (!s.trim()) return 'blank';
    if (/^([-*+_]){3,}\s*$/.test(s)) return 'hr';
    if (/^=+[ \t]*$/.test(s)) return prev === 'body' ? 'heading' : 'body';
    if (/^#{1,6}\s/.test(s)) return 'heading';
    const pipeCount = (s.match(/\|/g) || []).length;
    if (
      /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(s) ||
      (pipeCount >= 1 && s.trim().startsWith('|')) ||
      pipeCount >= 2
    ) {
      return 'table';
    }
    if (/^([-*+]\s*\[[xX\s]\])\s+/.test(s)) return 'list';
    if (/^([-*+])\s+/.test(s)) return 'list';
    if (/^(\d+\.)\s+/.test(s)) return 'list';
    return 'body';
  }

  // —— HTML 块判定（02 §2.5 / R1-D，CommonMark 4.6 spec 0.31.2）——
  // type 1-5 的 start condition（下标 + 1 = 类型号）：
  // 1. <script|<pre|<style|<textarea + 空白/>/行尾（大小写不敏感，
  //    `<scripting>` 的 `<script` 后跟 `i` 不匹配，spec 例 170）；
  // 2. <!--；3. <?；4. <! + ASCII 大写字母（`<!doctype>` 小写不匹配）；
  // 5. <![CDATA[（`<!` 后是 `[`，与 type 4 的 `[A-Z]` 天然互斥）。
  private static HTML_BLOCK_START_RE: RegExp[] = [
    /^ {0,3}<(script|pre|style|textarea)(?=[ \t]|>|$)/i,
    /^ {0,3}<!--/,
    /^ {0,3}<\?/,
    /^ {0,3}<![A-Z]/,
    /^ {0,3}<!\[CDATA\[/,
  ];
  // type 6：< 或 </ + 块级标签名单 + 空白/`>`/`/>`/行尾（大小写不敏感）。
  // lookahead `(?=[ \t]|/?>|$)` 精确表达 spec 的「a space, a tab, the end
  // of the line, the string >, or the string />」——`<div>`（后跟 `>`）、
  // `<div id="foo"`（后跟空白，行尾无 `>` 也可开始块，spec 例 153）、
  // `<hr/>`（后跟 `/>`）均匹配；`<div><a`（后跟 `<`）不匹配（spec 例 159
  // 是 `<div>` 形式——`<div` 后是 `>`，故仍命中，块吞掉整行）。
  private static HTML_BLOCK_TYPE6_RE = new RegExp(
    '^ {0,3}<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \\t]|/?>|$)',
    'i'
  );
  // type 7 判定自 B8c 起由 matchRawHtmlTag（6.11 严格文法）单源接管——
  // 见 matchHtmlBlockStart 注释（旧的宽松 `[^>]*` 属性串已移除；
  // EditorStore 增量路径的 HTML_BLOCK_TYPE7_RE 副本待同步，登记配合项）。

  /**
   * HTML 块 start condition 判定（CommonMark 4.6）：
   * - type 1-6 可打断段落，判定独立于 prevBlockKind（`Foo\n<div>` 中
   *   div 是新块，spec 例 185）；
   * - type 7 不可打断段落（spec 4.6 末尾：`Foo\n<a href="bar">` 中
   *   a 行是段落延续，spec 例 187）；列表延续（`- foo\n<div>`）同理由
   *   行级模型无列表容器状态登记为偏差，一并保护；
   * - 列表标记行（`- <div>`、`1. <div>`）不进 HTML 块——行级模型无
   *   容器状态，若判块会丢失 `<li>` 容器投影（spec 例 175 的列表渲染
   *   依赖列表行内 html 原样透传，登记偏差）。
   * - B8c（spec 例 619/622/624/632）：type 7 的「完整标签行」必须通过
   *   6.11 行内 HTML 严格文法（matchRawHtmlTag 单源判定）——`<a h*#ref>`
   *   （非法属性名）、`</a href>`（闭合标签带属性）、`<a href="\"">`
   *   （引号值不闭合）等非法标签行不是 HTML 块，按段落文本转义；
   *   旧的宽松 `[^>]*` 属性串会把非法行误判为块。
   * 入参约定：content 已剥离块引用前缀、缩进 <4 列、非空行。
   */
  private static matchHtmlBlockStart(
    content: string,
    prevBlockKind: BlockKind
  ): { type: number } | null {
    if (this.isListMarkerStart(content)) return null;
    for (let t = 0; t < this.HTML_BLOCK_START_RE.length; t++) {
      if (this.HTML_BLOCK_START_RE[t].test(content)) return { type: t + 1 };
    }
    if (this.HTML_BLOCK_TYPE6_RE.test(content)) return { type: 6 };
    if (prevBlockKind === 'body' || prevBlockKind === 'list') return null;
    // type 7：完整开/闭标签行——整行（≤3 前导空格 + 标签 + 尾随空白）
    // 必须是单个合法 open/close 标签（6.11 文法）；script/pre/style/
    // textarea 由 type 1 接管（`</script>` 单独成行既非 type 1 start
    // 也非 type 7，按普通段落处理，与 spec 一致）。
    {
      const lineContent = content.replace(/^ {0,3}/, '');
      const tag = this.matchRawHtmlTag(lineContent);
      if (tag && (tag.kind === 'open' || tag.kind === 'close')) {
        const name = (tag.tagName ?? '').toLowerCase();
        if (
          name !== 'script' &&
          name !== 'pre' &&
          name !== 'style' &&
          name !== 'textarea' &&
          lineContent.slice(tag.raw.length).trim() === ''
        ) {
          return { type: 7 };
        }
      }
      return null;
    }
  }

  /**
   * HTML 块 end condition（CommonMark 4.6）：
   * type 1 行内含四者任一闭合标签即结束（大小写不敏感；不需要与开始标签
   * 同名——`</div>` 也能结束 `<table>` 开始的 type 6 块？不——type 1 只认
   * script/pre/style/textarea 的闭合标签；type 6 的结束条件是空行）；
   * type 2/3/4/5 行内含对应闭合串即结束；type 6/7 遇空行结束
   * （空行本身不是块内容，由调用方标记 'none'）。
   */
  private static htmlBlockEndCondition(type: number, content: string): boolean {
    switch (type) {
      case 1:
        return /<\/script>|<\/pre>|<\/style>|<\/textarea>/i.test(content);
      case 2:
        return content.includes('-->');
      case 3:
        return content.includes('?>');
      case 4:
        return content.includes('>');
      case 5:
        return content.includes(']]>');
      case 6:
      case 7:
        return content.trim() === '';
      default:
        return true;
    }
  }

  /**
   * 行内原始 HTML 标签匹配（CommonMark 6.11，B8c 重写）：
   * 六种形态按 spec 文法严格匹配（单行窗口，跨行标签属行式解析器已知局限）：
   * - 注释：`<!-->` / `<!--->` / `<!--` + 不含 `-->` 的串 + `-->`
   *   （spec 例 626：`<!-->` 是注释、`<!--> foo -->` 中首段注释后
   *   残余 `-->` 按文本转义）；
   * - 处理指令：`<?` + 不含 `?>` 的串 + `?>`（例 627）；
   * - 声明：`<!` + ASCII 字母 + 不含 `>` 的串 + `>`（例 628）；
   * - CDATA 段：`<![CDATA[` + 不含 `]]>` 的串 + `]]>`（例 629）；
   * - 闭合标签：`</` + 标签名 + 可选空白 + `>`（**不含属性**，例 624）；
   * - 开标签：`<` + 标签名 + 属性* + 可选空白 + 可选 `/` + `>`——
   *   标签名 = 字母 + 字母/数字/连字符（`<responsive-image>`，例 617）；
   *   属性名 = `[A-Za-z_:][A-Za-z0-9_.:-]*`（`h*#ref` 非法，例 619）；
   *   属性值 = 单/双引号串（闭合引号内任意非引号字符）或非空裸值
   *   （不含空白/`"'=<>`/反引号；`hi'` 非法，例 620；`\"` 不转义引号，
   *   `href="\""` 非法，例 632）；属性间须有空白（`'bar'title` 非法，
   *   例 622）。
   * 返回值含开标签的 attr 原文（供 html_element 属性解析）与自闭合
   * 标志；匹配失败返回 null（按普通文本转义输出，不猜测性透传）。
   */
  private static matchRawHtmlTag(sub: string): {
    raw: string;
    kind: 'comment' | 'pi' | 'declaration' | 'cdata' | 'open' | 'close';
    tagName?: string;
    attrStr?: string;
    isSelfClosing?: boolean;
  } | null {
    // 注释（`<!-->` 与 `<!--->` 为 spec 特例形态，先于一般形态）
    let m: RegExpExecArray | null;
    if (sub.startsWith('<!-->')) {
      return { raw: '<!-->', kind: 'comment' };
    }
    if (sub.startsWith('<!--->')) {
      return { raw: '<!--->', kind: 'comment' };
    }
    m = /^<!--(?:[^-]|-(?!->))*-->/.exec(sub);
    if (m) return { raw: m[0], kind: 'comment' };
    // 处理指令
    m = /^<\?(?:[^?]|\?(?!>))*\?>/.exec(sub);
    if (m) return { raw: m[0], kind: 'pi' };
    // CDATA 段（先于声明——`<![` 的 `[` 不在声明首字母范围，天然互斥）
    m = /^<!\[CDATA\[(?:[^\]]|\](?!\]>))*\]\]>/.exec(sub);
    if (m) return { raw: m[0], kind: 'cdata' };
    // 声明
    m = /^<![A-Za-z][^>]*>/.exec(sub);
    if (m) return { raw: m[0], kind: 'declaration' };
    // 闭合标签（无属性）
    m = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>/.exec(sub);
    if (m) {
      return {
        raw: m[0],
        kind: 'close',
        tagName: m[0].slice(2).replace(/[ \t]*>$/, ''),
      };
    }
    // 开标签：tagname + attrs* + 空白 + 可选 `/` + `>`
    m =
      /^<([A-Za-z][A-Za-z0-9-]*)((?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^ \t"'=<>`]+))?)*)[ \t]*(\/)?>/.exec(
        sub
      );
    if (m) {
      const tagName = m[1].toLowerCase();
      // 自闭合：显式 `/>`，或 HTML 空元素名单（`<br>` 等，渲染惯例）
      const isSelfClosing =
        m[3] !== undefined ||
        ['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tagName);
      return {
        raw: m[0],
        kind: 'open',
        tagName,
        attrStr: m[2],
        isSelfClosing,
      };
    }
    return null;
  }

  /**
   * 判断「剥离块引用前缀后的内容行」是否可解释为段落（Setext 标题内容行候选）：
   * CommonMark 要求标题文本行不得被解释为 code fence / ATX 标题 / 块引用 /
   * 主题分隔线 / 列表项 / HTML 块，且首行缩进不得超过 3 个空格。
   * 行级模型的镜像判定：逐项排除 hr / ATX / 表格 / 列表形态。
   */
  private static isSetextContentLine(content: string): boolean {
    // 空行 / 纯空白行不是段落
    if (!content || !content.trim()) return false;
    // >3 空格（或制表符）缩进行是缩进代码候选，不是段落
    if (/^ {4,}/.test(content) || content.startsWith('\t')) return false;
    // 主题分隔线（hr）不是段落
    if (/^(\s*[-*+_]){3,}\s*$/.test(content)) return false;
    // ATX 标题不是段落
    if (/^#{1,6}\s+/.test(content)) return false;
    // 表格（行级启发式：表格分隔行 / 含管道行）——表格上下文不受 Setext 影响
    if (/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(content)) return false;
    const pipeCount = (content.match(/\|/g) || []).length;
    if ((pipeCount >= 1 && content.trim().startsWith('|')) || pipeCount >= 2) {
      return false;
    }
    // 列表项（任务 / 项目符号 / 有序）是独立容器，不允许被 Setext 下划线升级
    if (/^(\s*)([-*+]\s*\[[xX\s]\])\s+/.test(content)) return false;
    if (/^(\s*)([-*+])\s+/.test(content)) return false;
    if (/^(\s*)(\d+\.)\s+/.test(content)) return false;
    return true;
  }

  /**
   * Setext 上下文预扫描（02 §2.1 方案 + review-02 §7.1 修正）：
   * 第 i 行是标题内容（其下一行是 `===`/`---` 下划线且本行可解释为段落）
   * → setextLevels[i] = 1|2（标题层级由下划线字符决定）；
   * 下划线行本身 → setextLevels[i] = -1（零输出行）。
   * 优先级：hr 在「上一行非段落」时成立、Setext 在「上一行是段落」时成立、
   * 表格分隔线必含 `|` 天然避让——三者由本预扫描按 02 §2.1 顺序裁决。
   * 块引用懒延续（`> foo` 后裸 `---`）不构成 Setext（02 登记偏差）。
   */
  private static computeSetextContexts(
    lines: string[],
    codeBlockState: CodeState[],
    // B8a：懒延续行数组（null = 非懒延续）——懒延续行是块引用段落的
    // 延续内容，不能作为 Setext 标题内容行（`> bar\nbaz\n---` 的 baz）。
    lazyContinuation: (number | null)[] | null = null
  ): number[] {
    const n = lines.length;
    const setextLevels: number[] = new Array(n).fill(0);
    // CommonMark setext heading underline：≤3 前导空格 + 全 = 或全 - + 任意尾随空白
    const underlineRe = /^ {0,3}(=+|-+)[ \t]*$/;
    for (let i = 0; i + 1 < n; i++) {
      // 围栏 / 数学 / 代码块内的行不参与 Setext
      if (codeBlockState[i] !== 'none' || codeBlockState[i + 1] !== 'none') {
        continue;
      }
      // B8a：懒延续行不参与 Setext（其「段落」身份在块引用容器内，
      // 裸下划线行对其不构成 Setext 下划线——CommonMark 5.2 Laziness：
      // `> bar\nbaz\n---` 中 --- 是文档根 hr，baz 不是标题内容）
      if (lazyContinuation && lazyContinuation[i] !== null) {
        continue;
      }
      const prev = this.stripBlockquoteContext(lines[i]);
      const next = this.stripBlockquoteContext(lines[i + 1]);
      // 块引用层级必须一致：裸下划线接 `> 段落` 是懒延续，不算（02 已知偏差）
      if (prev.level !== next.level) continue;
      const u = next.content.match(underlineRe);
      if (!u) continue;
      if (!this.isSetextContentLine(prev.content)) continue;
      setextLevels[i] = u[1][0] === '=' ? 1 : 2;
      setextLevels[i + 1] = -1;
    }
    return setextLevels;
  }

  private static astCache = new LRUCache<string, LineNode>(50_000);
  public static cacheHits = 0;
  public static cacheMisses = 0;

  public static getCacheStats() {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.astCache.size,
    };
  }

  public static parseLine(
    lineText: string,
    localOffset: number,
    codeState: CodeState | boolean,
    // Setext 上下文标志（预扫描产物）：0=普通行 / 1|2=Setext 标题内容行 / -1=Setext 下划线行。
    // 渲染路径（MarkdownEngine.tsx）等外部调用不传该参数时按 0 处理，行为与现状一致。
    setextLevel: number = 0,
    // 引用链接定义表（parse 预扫描产物）：渲染路径不传时按 null 处理，
    // 引用形式回退文本（review-02 §7.3：缓存键隔离，不跨文档互串）。
    refDefs: RefDefTable | null = null,
    // 本行是否为引用定义行（零输出）
    isRefDefLine: boolean = false,
    // 列表项延续上下文（R1.5-B）：computeLineOffsets 判定为「空行后列表项
    // 延续」的行携带列表缩进；null = 非延续行。必须进缓存键——同文本行
    // 在有无列表上下文下产出不同节点（listIndent/listContinuation），
    // 不进键会导致跨文档缓存串扰（例 256 的 `  two` 与普通 `  two`）。
    listContext: ListContext | null = null,
    // 懒延续继承层级（B8a）：null = 非懒延续行。必须进缓存键——同文本行
    // 在「块引用段落懒延续」与「文档根普通行」下产出不同 blockquoteLevel
    // （例 247 的 `baz` 与文档根 `baz`），不进键会跨文档缓存串扰。
    lazyInherit: number | null = null,
    // B8c：本行是否为块结束（parse 预扫描产物；渲染路径不传按 false——
    // 硬换行标记仅在全量 parse 携带上下文时启用，行尾尾随空白语义不变）。
    // 必须进缓存键——同文本行在「块中段」与「块末尾」产出不同 token
    // （`foo  ` 块中段是 hard_break、块末尾保持文本，spec 例 644/645）。
    blockEnd: boolean = false,
    // W2-5：围栏代码行的高亮语言键（python/sql/bash，null = 无语言回退
    // JS 关键字集）。全量 parse 路径由 computeLineOffsets 注入；行级渲染
    // 路径（LineItem 无围栏上下文）不传按 null——与现状行为一致。
    // 必须进缓存键——同文本行在不同语言的围栏内产出不同 keyword/comment
    // token（`def` 在 python 是关键字、在 js 是普通文本），不进键会导致
    // 跨文档/跨路径缓存串扰。
    codeLang: string | null = null,
    calloutType: CalloutType | null = null,
    calloutTitle: string | null = null,
    isCalloutHeader: boolean = false
  ): LineNode {
    // 缓存键 = codeState + Setext 上下文 + 定义行标志 + 定义表 id + 列表上下文
    // + 懒延续层级 + 块结束标志 + 围栏语言键 + Callout 上下文 + 全局规则版本 + 完整行文本：
    // blockquote 前缀、fence/math 跨行状态、Setext 上下文均已编码在键内
    // （review-02 §7.1/§7.3：上下文必须进键，禁止回写缓存行），
    // token 偏移为行内相对值（与文档偏移解耦），因此命中节点可直接复用结构。
    // 全局规则注册表版本（R5-B）：register/unregister 自定义语法后，同文本行
    // 的解析结果可能改变——版本进键防跨注册版本串扰（与 refDefs.id 同原则）。
    const cacheKey =
      codeState +
      ':' +
      setextLevel +
      ':' +
      (isRefDefLine ? 1 : 0) +
      ':' +
      (refDefs ? refDefs.id : 0) +
      ':' +
      InlineRuler.getGlobalVersion() +
      ':' +
      (listContext
        ? 'L' + listContext.indent + ',' + listContext.markerWidth
        : 'Lx') +
      ':' +
      (lazyInherit !== null ? 'B' + lazyInherit : 'Bx') +
      ':' +
      (blockEnd ? 'E1' : 'E0') +
      ':' +
      (codeLang ? 'K' + codeLang : 'Kx') +
      ':' +
      (calloutType ? 'C' + calloutType + (isCalloutHeader ? 'H' : 'B') : 'Cx') +
      ':' +
      lineText;
    const cached = this.astCache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      // 命中节点仅复用结构：id 必须每行唯一（同文本多行不允许共享 id），
      // 故命中时重新生成 id，localOffset 亦按当前行覆盖。
      return {
        ...cached,
        id: this.generateId(),
        localOffset,
      };
    }
    this.cacheMisses++;

    let blockquoteLevel = 0;
    let trimmed = lineText;
    let bMatch;
    // 前缀正则 `^ {0,3}>\s?`（B8c 收紧：marker 前至多 3 空格缩进，
    // spec 例 231——见 stripBlockquoteContext 注释）
    while ((bMatch = trimmed.match(/^ {0,3}>\s?/))) {
      blockquoteLevel++;
      trimmed = trimmed.substring(bMatch[0].length);
    }
    // B8a：懒延续行（spec 5.2 Laziness）：无标记（或标记层数不足）的段落
    // 延续行以继承层级覆盖文本前缀计算值（例 251：`> bar` 自身 1 层、
    // 懒延续到 `>>> foo` 的 3 层容器；例 250 的 `bar` 0 层继承 3 层）。
    if (lazyInherit !== null) blockquoteLevel = lazyInherit;
    const bqLevelVal = blockquoteLevel > 0 ? blockquoteLevel : undefined;

    // Setext 下划线行 / 引用定义行（预扫描已确认）：零输出行——复用 'empty' 类型
    // （投影器与渲染器对 'empty' 均为跳过/空行），raw 保留原文供守恒校验与编辑回写。
    if (setextLevel === -1 || isRefDefLine) {
      const node: LineNode = {
        id: this.generateId(),
        type: 'empty',
        raw: lineText,
        blockquoteLevel: bqLevelVal,
        inlineTokens: [
          {
            type: 'text',
            raw: lineText,
            content: '',
            localOffset: 0,
            length: lineText.length,
          },
        ],
        length: lineText.length,
        localOffset,
      };
      this.astCache.set(cacheKey, node);
      return node;
    }

    if (codeState === 'fence_start') {
      return {
        id: this.generateId(),
        type: 'code_fence_start',
        raw: lineText,
        blockquoteLevel: bqLevelVal,
        inlineTokens: [
          {
            type: 'code',
            raw: lineText,
            content: lineText,
            localOffset: 0,
            length: lineText.length,
          },
        ],
        length: lineText.length,
        localOffset,
      };
    }
    if (codeState === 'fence_end') {
      return {
        id: this.generateId(),
        type: 'code_fence_end',
        raw: lineText,
        blockquoteLevel: bqLevelVal,
        inlineTokens: [
          {
            type: 'code',
            raw: lineText,
            content: lineText,
            localOffset: 0,
            length: lineText.length,
          },
        ],
        length: lineText.length,
        localOffset,
      };
    }
    if (codeState === 'math_fence_start') {
      return {
        id: this.generateId(),
        type: 'math_fence_start',
        raw: lineText,
        blockquoteLevel: bqLevelVal,
        inlineTokens: [
          {
            type: 'math',
            raw: lineText,
            content: lineText,
            localOffset: 0,
            length: lineText.length,
          },
        ],
        length: lineText.length,
        localOffset,
      };
    }
    if (codeState === 'math_block') {
      return {
        id: this.generateId(),
        type: 'math_block',
        raw: lineText,
        blockquoteLevel: bqLevelVal,
        inlineTokens: [
          {
            type: 'math',
            raw: lineText,
            content: lineText,
            localOffset: 0,
            length: lineText.length,
          },
        ],
        length: lineText.length,
        localOffset,
      };
    }
    if (codeState === 'math_fence_end') {
      return {
        id: this.generateId(),
        type: 'math_fence_end',
        raw: lineText,
        blockquoteLevel: bqLevelVal,
        inlineTokens: [
          {
            type: 'math',
            raw: lineText,
            content: lineText,
            localOffset: 0,
            length: lineText.length,
          },
        ],
        length: lineText.length,
        localOffset,
      };
    }

    // 缩进代码块内容行：与围栏代码行同类型 'code'，行内不解析 markdown
    // （parseCodeLine 复用；raw 保留完整原文含缩进，覆盖守恒与编辑回写不受影响）。
    // W2-5：缩进代码无语言上下文（computeLineOffsets 的 fenceLangs 恒 null），
    // 传入 codeLang 走 JS 回退集，行为与 W2-5 之前一致。
    if (codeState === 'indent_code') {
      const node = this.parseCodeLine(lineText, localOffset, codeLang);
      node.blockquoteLevel = bqLevelVal;
      this.astCache.set(cacheKey, node);
      return node;
    }

    // HTML 块内容行（02 §2.5 / R1-D）：整行按 raw 原样透传、不做行内
    // 解析（与代码行同构——HTML 块内 CommonMark 不做任何行内处理）；
    // 块引用前缀保留在 raw 中，由投影器剥离（与缩进代码行同构）。
    if (codeState === 'html_block') {
      const node = this.parseHtmlBlockLine(lineText, localOffset);
      node.blockquoteLevel = bqLevelVal;
      this.astCache.set(cacheKey, node);
      return node;
    }

    if (codeState === 'code' || codeState === true) {
      // W2-5：围栏代码行按语言分发关键字表（S-T-2-08）——computeLineOffsets
      // 从 fence_start info 串提取的语言键在此生效；null（无语言围栏/行级
      // 渲染路径）回退 JS 关键字集（现状行为）。
      const node = this.parseCodeLine(lineText, localOffset, codeLang);
      node.blockquoteLevel = bqLevelVal;
      this.astCache.set(cacheKey, node);
      return node;
    }

    let node = this.parseNormalLine(
      lineText,
      localOffset,
      setextLevel,
      refDefs,
      listContext,
      lazyInherit,
      blockEnd,
      calloutType,
      calloutTitle,
      isCalloutHeader
    );
    // B8a：懒延续行的 blockquoteLevel 由上下文决定（parseLine 与
    // parseNormalLine 计算一致，此处幂等覆盖兜底）
    node.blockquoteLevel = bqLevelVal;

    this.astCache.set(cacheKey, node);
    return node;
  }

  /**
   * HTML 块行（02 §2.5 / R1-D）：整行作为单个 'html' token（raw = 行原文、
   * content = 行原文），不做行内解析——HTML 块内 CommonMark 不做任何
   * 行内处理（与代码块一致，`<div>` 块内的 `*foo*` 保持字面）。
   */
  private static parseHtmlBlockLine(
    lineText: string,
    localOffset: number
  ): LineNode {
    return {
      id: this.generateId(),
      type: 'html_block',
      raw: lineText,
      inlineTokens: [
        {
          type: 'html',
          raw: lineText,
          content: lineText,
          localOffset: 0,
          length: lineText.length,
        },
      ],
      length: lineText.length,
      localOffset,
    };
  }

  private static parseCodeLine(
    lineText: string,
    localOffset: number,
    // W2-5：围栏高亮语言键（python/sql/bash；null = 无语言回退 JS 关键字集）。
    // 由 parseLine 从 computeLineOffsets 的 fenceLangs 注入——同文本行在不同
    // 语言围栏内产出不同 keyword/comment token（S-T-2-08）。
    codeLang: string | null = null
  ): LineNode {
    const tokens: InlineNode[] = [];
    let pos = 0;
    let remainingTextForPrefix = lineText;
    let blockquoteMatch;

    // 前缀正则 `^ {0,3}>\s?`（B8c 收紧：marker 前至多 3 空格缩进，
    // spec 例 231——见 stripBlockquoteContext 注释）
    while ((blockquoteMatch = remainingTextForPrefix.match(/^ {0,3}>\s?/))) {
      pos += blockquoteMatch[0].length;
      remainingTextForPrefix = remainingTextForPrefix.substring(
        blockquoteMatch[0].length
      );
    }

    if (pos > 0) {
      tokens.push({
        type: 'blockquote_prefix',
        raw: lineText.substring(0, pos),
        content: '',
        localOffset: 0,
        length: pos,
      });
    }

    const codeText = lineText.substring(pos);

    // W2-5：围栏语言 → 关键字表分发（S-T-2-08）。启发式定位不变——注释/
    // 字符串/关键字交替匹配，未命中段为 text；组序保持（1 注释/2 引号/
    // 3 反斜杠）以复用下方 match[1]/match[2] 分支。无语言/未识别语言
    // （normalizeFenceLang 已归 null）回退 JS 关键字集，与 W2-5 之前的
    // 高亮行为完全一致（js 围栏与无语言围栏 token 结构相同）。
    const keywordSource = this.getCodeKeywordSource(codeLang);
    const commentPattern =
      codeLang === 'python' || codeLang === 'bash'
        ? '#[^\\n]*'
        : codeLang === 'sql'
          ? '--[^\\n]*'
          : '//[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
    // SQL 关键字大小写不敏感（SELECT/from 同样命中），其余语言敏感
    const regex = new RegExp(
      '(' +
        commentPattern +
        ')|(["\u0060])(?:(?=(\\\\?))\\3.)*?\\2|\\b(?:' +
        keywordSource +
        ')\\b',
      codeLang === 'sql' ? 'gi' : 'g'
    );
    let match;
    let currentPos = 0;

    while ((match = regex.exec(codeText)) !== null) {
      const matchIndex = match.index;
      if (matchIndex > currentPos) {
        const plain = codeText.substring(currentPos, matchIndex);
        tokens.push({
          type: 'text',
          raw: plain,
          content: plain,
          localOffset: pos + currentPos,
          length: plain.length,
        });
      }

      if (match[1]) {
        // comment
        tokens.push({
          type: 'comment',
          raw: match[0],
          content: match[0],
          localOffset: pos + matchIndex,
          length: match[0].length,
        });
      } else if (match[2]) {
        // string
        tokens.push({
          type: 'string',
          raw: match[0],
          content: match[0],
          localOffset: pos + matchIndex,
          length: match[0].length,
        });
      } else {
        // keyword
        tokens.push({
          type: 'keyword',
          raw: match[0],
          content: match[0],
          localOffset: pos + matchIndex,
          length: match[0].length,
        });
      }
      currentPos = regex.lastIndex;
    }

    if (currentPos < codeText.length) {
      const plain = codeText.substring(currentPos);
      tokens.push({
        type: 'text',
        raw: plain,
        content: plain,
        localOffset: pos + currentPos,
        length: plain.length,
      });
    }

    if (tokens.length === 0) {
      // 空代码行（lineText 为空串）不产出占位符 token——覆盖必须落在 [0, raw.length) = [0, 0) 内，
      // 用 `lineText || ' '` 会把长度 1 的 token 塞进零长行，突破行界（token-bounds-integrity 违例）。
      tokens.push({
        type: 'text',
        raw: lineText,
        content: lineText,
        localOffset: 0,
        length: lineText.length,
      });
    }

    return {
      id: this.generateId(),
      type: 'code',
      raw: lineText,
      inlineTokens: tokens,
      length: lineText.length,
      localOffset,
    };
  }

  private static parseNormalLine(
    lineText: string,
    localOffset: number,
    // Setext 上下文标志（预扫描产物）：0=普通行 / 1|2=Setext 标题内容行。
    // 标题身份由预扫描（computeSetextContexts）决定而非解析后回写——
    // review-02 §7.1：回写会使「同键缓存」与回写结果不一致（缓存污染）。
    setextLevel: number = 0,
    // 引用链接定义表（文档级隔离，见 parseLine 注释）
    refDefs: RefDefTable | null = null,
    // 列表项延续上下文（R1.5-B）：computeLineOffsets 判定为「空行后列表项
    // 延续」的行携带列表缩进——输出 listIndent + listContinuation 标志。
    listContext: ListContext | null = null,
    // 懒延续继承层级（B8a）：非 null 时本行是块引用段落的懒延续行——
    // 跳过全部块级判定（hr/ATX/表格/列表），按段落文本行内解析
    // （spec 5.2 Laziness，例 238：`    - bar` 是段落文本而非列表）。
    lazyInherit: number | null = null,
    // B8c：本行是否为块结束（parse 预扫描产物，见 parseLine 注释）——
    // 硬换行标记的门控：块末尾行尾的 2+ 空格/反斜杠保持文本语义。
    blockEnd: boolean = false,
    calloutType: CalloutType | null = null,
    calloutTitle: string | null = null,
    isCalloutHeader: boolean = false
  ): LineNode {
    const tokens: InlineNode[] = [];
    let pos = 0;

    if (!lineText) {
      return {
        id: this.generateId(),
        type: 'empty',
        raw: '',
        inlineTokens: [
          { type: 'text', raw: '', content: '', localOffset: 0, length: 0 },
        ],
        localOffset: localOffset,
        length: 0,
      };
    }

    let lineType:
      | 'heading'
      | 'body'
      | 'hr'
      | 'blockquote'
      | 'table_row'
      | 'table_separator' = 'body';
    let headingLevel = 0;
    let listIndent = 0;
    let listPrefix = '';
    let blockquoteLevel = 0;

    // Setext 标题内容行：预扫描已确认「下一行是 ===/--- 且本行是段落」，
    // 直接按 heading 解析，headingLevel 由下划线字符（= 或 -）决定。
    const isSetextHeading = setextLevel >= 1;
    if (isSetextHeading) {
      lineType = 'heading';
      headingLevel = setextLevel;
    }

    // Parse blockquote prefixes first
    let remainingTextForPrefix = lineText;
    let blockquoteMatch;
    // 前缀正则 `^ {0,3}>\s?`（B8c 收紧：marker 前至多 3 空格缩进，
    // spec 例 231——见 stripBlockquoteContext 注释）
    while ((blockquoteMatch = remainingTextForPrefix.match(/^ {0,3}>\s?/))) {
      blockquoteLevel++;
      pos += blockquoteMatch[0].length;
      remainingTextForPrefix = remainingTextForPrefix.substring(
        blockquoteMatch[0].length
      );
    }
    // B8a：懒延续行以继承层级覆盖文本前缀计算值（spec 5.2 Laziness——
    // 例 251：`> bar` 自身 1 层，懒延续到 `>>> foo` 的 3 层容器）
    if (lazyInherit !== null) blockquoteLevel = lazyInherit;

    if (pos > 0) {
      tokens.push({
        type: 'blockquote_prefix',
        raw: lineText.substring(0, pos),
        content: '',
        localOffset: 0,
        length: pos,
      });
    }

    // —— B8a：纯块引用标记行（空引用行，spec 例 239-241/244）——
    // 剥完全部前缀后无内容（`>` / `>  ` / `> >`）：输出 empty 节点。
    // 投影器对 empty 行不产出内容但保持 blockquote 容器开合（例 244：
    // `> foo\n>\n> bar` 的空 `>` 行阻断段落合并，产出两个 <p>）。
    // raw 保留原文供覆盖守恒与编辑回写。
    if (remainingTextForPrefix.trim() === '') {
      return {
        id: this.generateId(),
        type: 'empty',
        raw: lineText,
        blockquoteLevel: blockquoteLevel > 0 ? blockquoteLevel : undefined,
        calloutType: calloutType ?? undefined,
        calloutTitle: calloutTitle ?? undefined,
        inlineTokens: [
          {
            type: 'text',
            raw: lineText,
            content: lineText,
            localOffset: 0,
            length: lineText.length,
          },
        ],
        length: lineText.length,
        localOffset,
      };
    }

    // Setext 标题内容行跳过全部块级判定（hr/ATX/表格/列表），直接进入行内解析；
    // 普通行维持原有判定顺序：hr → ATX → 表格 → 列表（02 §2.1 第 3 点）。
    // B8a：懒延续行同理跳过块级判定（段落延续文本语义，spec 5.2 Laziness）。
    if (!isSetextHeading && lazyInherit === null) {
      let isHr = false;
      const nestedText = lineText.slice(pos);
      const nestedLocalOffset = pos;

      if (nestedText.length <= 10000) {
        const hrMatch = nestedText.match(/^(\s*[-*+_]){3,}\s*$/);
        if (hrMatch) {
          lineType = 'hr';
          pos += nestedText.length;
          isHr = true;
          // hr 行其余代码不再产出 token，这里补一个覆盖整段的文本 token，
          // 保证 inlineTokens 的 [localOffset, localOffset+length] 拼接恰好覆盖 [0, raw.length]（覆盖守恒）。
          tokens.push({
            type: 'text',
            raw: nestedText,
            content: nestedText,
            localOffset: nestedLocalOffset,
            length: nestedText.length,
          });
        }
      }

      if (!isHr) {
        const headingMatch = nestedText.match(/^ {0,3}(#{1,6})\s+/);
        if (headingMatch) {
          lineType = 'heading';
          headingLevel = headingMatch[1].length;
          const prefixLen = headingMatch[0].length;
          tokens.push({
            type: 'heading_prefix',
            raw: headingMatch[0],
            content: '',
            localOffset: nestedLocalOffset,
            length: prefixLen,
          });
          pos += prefixLen;
        } else {
          // 表格分隔行检测（优先判定）：- | - 或 | --- | --- | 仅包含破折号、冒号、空白与管道符
          let isTableSep = false;
          if (nestedText.length <= 10000) {
            const tableSeparatorMatch = nestedText.match(
              /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/
            );
            if (tableSeparatorMatch) {
              lineType = 'table_separator';
              isTableSep = true;
            }
          }

          if (!isTableSep) {
            // 列表项检测（优先于普通表格行）：CommonMark/GFM 铁律——列表前缀（- , * , + , 1. , - [ ]）
            // 拥有更高排版优先级，行内包含 ||spoiler|| 或 | 绝不可将列表项误判为表格
            let isList = false;
            const taskMatch = nestedText.match(/^(\s*)([-*+]\s*\[[xX\s]\])\s+/);
            if (taskMatch) {
              isList = true;
              const prefixLen = taskMatch[0].length;
              const indent = taskMatch[1];
              const checkRaw = taskMatch[2];
              const isChecked =
                checkRaw.includes('x') || checkRaw.includes('X');
              listIndent = indent.length;
              listPrefix = checkRaw;
              tokens.push({
                type: 'list_task',
                raw: taskMatch[0],
                content: isChecked ? '☑' : '☐',
                indent: indent,
                marker: checkRaw + ' ',
                isChecked,
                localOffset: nestedLocalOffset,
                length: prefixLen,
              });
              pos += prefixLen;
            } else {
              const bulletMatch = nestedText.match(/^(\s*)([-*+])\s+/);
              if (bulletMatch) {
                isList = true;
                const prefixLen = bulletMatch[0].length;
                const indent = bulletMatch[1];
                listIndent = indent.length;
                listPrefix = bulletMatch[2];
                tokens.push({
                  type: 'list_bullet',
                  raw: bulletMatch[0],
                  content: '•',
                  indent: indent,
                  marker: bulletMatch[2] + ' ',
                  localOffset: nestedLocalOffset,
                  length: prefixLen,
                });
                pos += prefixLen;
              } else {
                const numberMatch = nestedText.match(/^(\s*)(\d+\.)\s+/);
                if (numberMatch) {
                  isList = true;
                  const prefixLen = numberMatch[0].length;
                  const indent = numberMatch[1];
                  listIndent = indent.length;
                  listPrefix = numberMatch[2];
                  tokens.push({
                    type: 'list_number',
                    raw: numberMatch[0],
                    content: numberMatch[0],
                    indent: indent,
                    marker: numberMatch[2] + ' ',
                    localOffset: nestedLocalOffset,
                    length: prefixLen,
                  });
                  pos += prefixLen;
                }
              }
            }

            if (!isList && nestedText.length <= 10000) {
              const pipeCount = (nestedText.match(/\|/g) || []).length;
              if (
                (pipeCount >= 1 && nestedText.trim().startsWith('|')) ||
                pipeCount >= 2
              ) {
                lineType = 'table_row';
              }
            }
          }
        }
      }
    }

    const remainingText = lineText.substring(pos);
    const MAX_PARSE_CHARS = 10_000;

    if (remainingText.length > MAX_PARSE_CHARS) {
      const parsedTokens = this.parseInlineTokens(
        remainingText.substring(0, MAX_PARSE_CHARS),
        pos,
        true,
        refDefs
      );
      tokens.push(...parsedTokens);

      const unparsed = remainingText.substring(MAX_PARSE_CHARS);
      tokens.push({
        type: 'text',
        raw: unparsed,
        content: unparsed,
        localOffset: pos + MAX_PARSE_CHARS,
        length: unparsed.length,
      });
    } else {
      const parsedTokens = this.parseInlineTokens(
        remainingText,
        pos,
        true,
        refDefs
      );
      tokens.push(...parsedTokens);
    }

    const finalTokens =
      lineType === 'table_row' || lineType === 'table_separator'
        ? this.groupTableCells(tokens)
        : tokens;

    // —— B8c：硬换行标记（CommonMark 6.13）——
    // 行尾 2+ 空格/tab（或行尾反斜杠）后的换行是硬换行（`foo  \nbaz` →
    // `<br />`）。行式解析器在行级标记：把最后一个文本 token 的尾随
    // 空白/反斜杠拆出为 hard_break 令牌（raw 保持覆盖守恒；content 置空，
    // 与 heading_prefix 等结构令牌同构——编辑器不渲染尾随空白）。投影器
    // 把 hard_break 映射 `<br />` 属 B8c 登记配合项（tests/commonmark/
    // 只读域；投影前该令牌零输出，跑分无回归）。已知偏差（登记）：
    // 未闭合代码 span / 未闭合 HTML 标签内的行尾不产生硬换行
    // （spec 例 640/642），行级模型无法判定跨行闭合，留待投影器配合轮
    // 按段落上下文收敛。仅作用于 body 段落行——ATX/Setext 标题行尾
    // 空白由标题语义剥除（spec 例 647），不产生硬换行；块末尾
    // （blockEnd）行尾空白/反斜杠保持文本语义（spec 例 644/645）。
    if (
      lineType === 'body' &&
      !isSetextHeading &&
      !blockEnd &&
      finalTokens.length > 0
    ) {
      const hbSuffix = this.matchHardBreakSuffix(lineText);
      if (hbSuffix) {
        const last = finalTokens[finalTokens.length - 1];
        if (
          last.type === 'text' &&
          last.raw.length > hbSuffix.length &&
          last.raw.endsWith(hbSuffix)
        ) {
          const textLen = last.raw.length - hbSuffix.length;
          const head: InlineNode = {
            ...last,
            raw: last.raw.slice(0, textLen),
            content: last.content.slice(
              0,
              last.content.length - hbSuffix.length
            ),
            length: textLen,
          };
          const hardBreak: InlineNode = {
            type: 'hard_break' as InlineNode['type'],
            raw: hbSuffix,
            content: '',
            localOffset: last.localOffset + textLen,
            length: hbSuffix.length,
          };
          finalTokens.splice(finalTokens.length - 1, 1, head, hardBreak);
        }
      }
    }

    // R1.5-B：空行后列表项延续（例 256/258/262/277）——行仍是普通段落
    // （body），但携带列表容器上下文：listIndent = 列表缩进 + listContinuation
    // 标志，投影器据此把该行并入同一 <li> 的第二个 <p>（AST 层与普通
    // body 行区分，例 255 的 `<markerWidth` 行无标志即出列表）。
    // Setext 标题 / hr / 表格等块级形态优先（保持既有语义，0 回归）。
    const isListContinuation =
      listContext !== null && lineType === 'body' && !isSetextHeading;
    if (isListContinuation) {
      listIndent = listContext.indent;
    }

    let effectiveCalloutType = calloutType;
    let effectiveCalloutTitle = calloutTitle;
    let effectiveIsCalloutHeader = isCalloutHeader;
    if (effectiveCalloutType === null && blockquoteLevel > 0) {
      const calloutMatch = remainingTextForPrefix.trim().match(
        /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i
      );
      if (calloutMatch) {
        effectiveCalloutType = calloutMatch[1].toLowerCase() as CalloutType;
        effectiveCalloutTitle = calloutMatch[2]?.trim() || '';
        effectiveIsCalloutHeader = true;
      }
    }

    return {
      id: this.generateId(),
      type: lineType,
      raw: lineText,
      headingLevel,
      blockquoteLevel: blockquoteLevel > 0 ? blockquoteLevel : undefined,
      calloutType: effectiveCalloutType ?? undefined,
      calloutTitle: effectiveCalloutTitle ?? undefined,
      isCalloutHeader: effectiveIsCalloutHeader ? true : undefined,
      listIndent: listPrefix !== undefined ? listIndent : undefined,
      listPrefix: listPrefix ? listPrefix : undefined,
      listContinuation: isListContinuation ? true : undefined,
      inlineTokens: finalTokens,
      localOffset,
      length: lineText.length,
    };
  }

  private static groupTableCells(tokens: InlineNode[]): InlineNode[] {
    const result: InlineNode[] = [];
    let currentCellTokens: InlineNode[] = [];

    const flushCell = (pipeToken?: InlineNode) => {
      const startOffset =
        currentCellTokens.length > 0
          ? currentCellTokens[0].localOffset
          : pipeToken
            ? pipeToken.localOffset + pipeToken.length
            : 0;
      const length =
        currentCellTokens.length > 0
          ? currentCellTokens[currentCellTokens.length - 1].localOffset +
            currentCellTokens[currentCellTokens.length - 1].length -
            startOffset
          : 0;

      result.push({
        type: 'table_cell',
        raw: currentCellTokens.map((t) => t.raw).join(''),
        content: '',
        children: currentCellTokens,
        localOffset: startOffset,
        length: length,
      });
      currentCellTokens = [];
    };

    let foundFirstPipe = false;

    for (const token of tokens) {
      if (token.type === 'table_pipe') {
        if (!foundFirstPipe) {
          if (currentCellTokens.length > 0) flushCell();
          foundFirstPipe = true;
        } else {
          flushCell(token);
        }
        result.push(token);
      } else {
        currentCellTokens.push(token);
      }
    }

    if (currentCellTokens.length > 0) {
      const isJustEmptySpace =
        currentCellTokens.length === 1 &&
        currentCellTokens[0].type === 'text' &&
        currentCellTokens[0].raw.trim() === '';
      if (!isJustEmptySpace) flushCell();
    }

    return result;
  }

  /**
   * 链接目标/标题尾段正则（任务 5：目标校验）：
   * - 目标：尖括号 `<...>`（允许空白，不含 `<>`/换行/控制字符）或裸目标；
   * - 裸目标：不含空白/尖括号/反斜杠，括号嵌套平衡（三层深度，覆盖
   *   `foo(and(bar))`），允许转义标点（`\(`、`\)`、`\:` 等）；
   * - 可选标题：`"..."` / `'...'` / `(...)`（转义引号允许），标题前须有空白；
   * - 目标与标题前后允许空白/换行（`[link](   /uri\n  "title"  )`）。
   * 正则用字符串拼接构造，避免超长字面量。
   */
  private static LINK_TAIL_RE = (() => {
    const ws = '[ \\t\\n\\r\\f]';
    // 转义标点单元：正则字面量 `\\(?:...)` —— .source 保证「字面反斜杠 + 非捕获组」
    // 的源码形态（字符串模板手写反斜杠极易数错层数，一律改用字面量）。
    const esc = /\\(?:[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/.source;
    // 裸目标单元：普通字符（非空白/尖括号/括号，**允许反斜杠**——`\b` 中 b 非
    // 可转义标点时反斜杠按字面保留，CommonMark destination 逐字符语义）、
    // 转义标点（`\(` 等，与结构括号区分）、平衡括号组（三层深度）。
    const plain = '[^ \\t\\n\\r\\f<>()]';
    const nested1 = `(?:${esc}|${plain}|\\((?:${esc}|${plain})*\\))`;
    const nested2 = `(?:${nested1}|\\((?:${nested1})*\\))`;
    const nested3 = `(?:${nested2}|\\((?:${nested2})*\\))`;
    const bare = `(?:${nested3}){0,2000}`;
    // 尖括号目标：不允许 <>、换行、控制字符（\x00-\x1F），但允许空格（\x20）
    const dest = `(?:<[^<>\\n\\x00-\\x1F]*>|${bare})`;
    const title = `(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|\\((?:[^)\\\\]|\\\\.)*\\))`;
    return new RegExp(`^${ws}*(${dest})(?:${ws}+(${title}))?${ws}*\\)`);
  })();

  /**
   * 栈式 label 匹配（CommonMark 6.5 / markdown-it parseLinkLabel）：
   * 从 `[` 位置开始，`[` 深度 +1、未转义 `]` 深度 -1，深度归 0 即 label 结束。
   * `[link [foo [bar]]]` 与 `[ref[]`（未平衡）由此正确区分——
   * 后者扫描到行尾深度未归 0 → 匹配失败（不解析，spec 例 65/66）。
   * B8c（spec 例 342）：代码 span 内的 `]` 不终止 label——遇反引号 run
   * 时按 6.1 尝试等长闭合（matchCodeSpan 语义），闭合成功则整段跳过，
   * 否则反引号按字面继续逐字符扫描。
   * 长度上限 2000（现状偏差，CommonMark 为 999）。
   */
  private static matchLinkLabel(
    text: string,
    i: number
  ): { end: number } | null {
    if (text[i] !== '[') return null;
    let depth = 0;
    const max = Math.min(text.length, i + 2000);
    let j = i;
    while (j < max) {
      const c = text[j];
      if (c === '\\' && j + 1 < text.length) {
        j += 2;
        continue;
      }
      if (c === '`') {
        // 代码 span 边界：等长 run 闭合则跳过整段（span 内 `]` 不计数）
        const span = this.matchCodeSpan(text, j);
        if (span) {
          j += span.length;
          continue;
        }
      }
      if (c === '[') {
        depth++;
      } else if (c === ']') {
        depth--;
        if (depth === 0) return { end: j };
      }
      j++;
    }
    return null;
  }

  /**
   * 代码 span 匹配（CommonMark 6.1，B8c 重写）：
   * 以「完整反引号 run」为开括串（run 即前后无接续反引号的最大连续段），
   * 向后扫描「等长反引号串」闭合——run 长度 ≠ 开括长度的其它反引号串
   * 一律跳过（`` ` `` ` `` 的 2-run 是内容，spec 例 330/331/340；
   * ```foo`` 无等长闭合 → 整段回退文本，spec 例 347）。
   * 内容按 6.1 归一化：行尾换行 → 空格（行式解析器单行内无换行，
   * 跨行代码 span 属已知局限）；首尾均为空格且非全空格时各剥一个。
   * 反斜杠在代码 span 内按字面保留（原子上下文，不参与转义）。
   * 扫描窗口与 matchLinkLabel 同界（2000 字符，防超长行 ReDoS）。
   */
  private static matchCodeSpan(
    text: string,
    pos: number
  ): { raw: string; content: string; length: number } | null {
    if (text[pos] !== '`') return null;
    let openLen = 0;
    while (pos + openLen < text.length && text[pos + openLen] === '`') {
      openLen++;
    }
    const max = Math.min(text.length, pos + 2000);
    let j = pos + openLen;
    while (j < max) {
      if (text[j] === '`') {
        let run = 0;
        while (j + run < max && text[j + run] === '`') {
          run++;
        }
        if (run === openLen) {
          const raw = text.substring(pos, j + run);
          return {
            raw,
            content: this.normalizeCodeSpanContent(
              text.substring(pos + openLen, j)
            ),
            length: j + run - pos,
          };
        }
        j += run;
      } else {
        j++;
      }
    }
    return null;
  }

  /**
   * 代码 span 内容归一化（CommonMark 6.1）：换行 → 空格；若结果以空格
   * 开头且以空格结尾、且非全空格，则首尾各剥一个空格
   * （`` ` `` ` `` → `` `` ` ``，spec 例 330；`` `  ``  ` `` → `` `` ` ``）。
   */
  private static normalizeCodeSpanContent(s: string): string {
    const c = s.replace(/\r\n|\r|\n/g, ' ');
    if (
      c.length >= 2 &&
      c[0] === ' ' &&
      c[c.length - 1] === ' ' &&
      c.trim() !== ''
    ) {
      return c.slice(1, -1);
    }
    return c;
  }

  /**
   * 行尾硬换行后缀判定（CommonMark 6.13，B8c）：
   * - 行尾 2+ 空格/tab（`foo  `，混合空白 run 同样成立）→ 返回该 run；
   * - 行尾奇数个反斜杠（`foo\`，末个反斜杠紧跟换行即硬换行；偶数个时
   *   末个反斜杠是转义对的产物，行尾是普通软换行）→ 返回 `\`；
   * - 其余（含单个尾随空格、无后缀）→ null（软换行）。
   */
  private static matchHardBreakSuffix(line: string): string | null {
    const sp = /[ \t]{2,}$/.exec(line);
    if (sp) return sp[0];
    let k = 0;
    for (let idx = line.length - 1; idx >= 0 && line[idx] === '\\'; idx--) {
      k++;
    }
    if (k % 2 === 1) return '\\';
    return null;
  }

  /**
   * 内联链接匹配 `[label](dest "title")`（custom 'link' 规则）：
   * `]` 必须紧跟 `(`（`[link] (/uri)` 是引用/文本，spec 例 30）；
   * 目标非法（含空白未加尖括号等）→ null（回退文本，spec 例 7）。
   */
  private static tryMatchInlineLink(
    text: string,
    i: number
  ): { raw: string; content: string; url: string; end: number } | null {
    if (text[i] !== '[') return null;
    const label = this.matchLinkLabel(text, i);
    if (!label) return null;
    if (text[label.end + 1] !== '(') return null;
    const tail = text.slice(label.end + 2);
    const m = this.LINK_TAIL_RE.exec(tail);
    if (!m) return null;
    let url = m[1];
    if (url.startsWith('<')) url = url.slice(1, -1);
    // 目标/标题：实体解码（跳过 \&）→ 转义还原（\* → *、\b 保留）
    url = this.unescapePunctuation(this.decodeEntitiesInString(url));
    let title: string | undefined;
    if (m[2]) {
      title = this.unescapePunctuation(
        this.decodeEntitiesInString(m[2].slice(1, -1))
      );
    }
    // url 字段 = 目标 + 可选标题（投影器 splitLinkTarget 拆 href/title）
    const urlField = url + (title !== undefined ? ' "' + title + '"' : '');
    const end = label.end + 2 + m[0].length;
    return {
      raw: text.slice(i, end),
      content: text.slice(i + 1, label.end),
      url: urlField,
      end,
    };
  }

  /**
   * 引用链接匹配（custom 'reference' 规则，02 §2.3）：
   * - `[label]`：label 查定义表；
   * - `[label][]`：折叠式，ref = label；
   * - `[label][ref]`：ref 查表；
   * 完整形式（`[` 紧邻）查表失败 → 整体回退文本（不回落直接形式）；
   * `]` 后紧跟 `(` 属内联形态（即使失败也不走引用，spec 例 7 语义）。
   */
  private static tryMatchReferenceLink(
    text: string,
    i: number,
    refDefs: RefDefTable | null
  ): { raw: string; content: string; url: string; end: number } | null {
    if (text[i] !== '[') return null;
    const label = this.matchLinkLabel(text, i);
    if (!label) return null;
    if (text[label.end + 1] === '(') return null;
    const labelRaw = text.slice(i + 1, label.end);
    let key = labelRaw;
    let end = label.end + 1;
    if (text[label.end + 1] === '[') {
      const ref = this.matchLinkLabel(text, label.end + 1);
      if (!ref) return null;
      const refRaw = text.slice(label.end + 2, ref.end);
      key = refRaw.trim() === '' ? labelRaw : refRaw;
      end = ref.end + 1;
    }
    if (!refDefs) return null;
    const def = refDefs.table.get(this.normalizeRefLabel(key));
    if (!def) return null;
    const urlField =
      def.url + (def.title !== undefined ? ' "' + def.title + '"' : '');
    return {
      raw: text.slice(i, end),
      // 渲染文本：label 原文经转义还原（`[Foo*bar\]]` → `Foo*bar]`）
      content: this.unescapePunctuation(labelRaw),
      url: urlField,
      end,
    };
  }

  /**
   * 内置行内规则注册表（06 分析 §1：INLINE_RULES 数组 → ruler 初始注册，同序同义）：
   * - 注册顺序 = 原 INLINE_RULES 数组顺序；priority 按注册序严格递减
   *   （第 k 条 priority = 总数 - k），扫描尝试顺序与原数组顺序完全一致（零行为变化）；
   * - match 均为纯函数：返回 { type, raw, content, length, ... } 或 null；
   *   失败位图记忆（memo）由扫描循环经 ctx 注入，规则内不产生副作用；
   * - 正则规则统一走 regexRule 工厂（content 提取与原 scanTokens 的 regex
   *   分支逐分支对应）；起止符规则统一走 startCloseRule 工厂（exact-match
   *   互斥 + `_` 围挡校验 + 失败记忆短路 + 递归解析，与原分支逐行对应）；
   * - 全局注册表（InlineRuler.register）默认空，注册自定义规则后按 priority
   *   参与同一排序——同优先级时内置规则优先（稳定排序）。
   */
  private static buildInlineRuler(): InlineRuler<RefDefTable | null> {
    // 行内扫描的 2000 字符窗口（与原 scanTokens 的 sub 截断同义，防超长行 ReDoS）
    const slice = (text: string, pos: number): string =>
      text.length - pos > 2000
        ? text.substring(pos, pos + 2000)
        : text.substring(pos);

    // —— 正则规则工厂：content 提取与原 scanTokens 的 regex 分支逐分支对应 ——
    const regexRule = (
      name: string,
      type: string,
      regex: RegExp,
      autolink?: 'uri' | 'email'
    ): Omit<InlineRule<RefDefTable | null>, 'priority'> => ({
      name,
      match: (text, pos) => {
        const m = regex.exec(slice(text, pos));
        if (!m || m.index !== 0) return null;
        const raw = m[0];
        let content = '';
        let url: string | undefined;
        // 与原 scanTokens regex 分支同义：非 checkbox 规则也输出 isChecked: false
        // 字段（token 键级守恒——渲染层/断言按 `=== false` 或 `in` 判断时行为一致）。
        let isChecked = false;
        if (type === 'image') {
          // 链接目标内实体解码（02 §2.6 冲突点：`[a](url?x=1&amp;y=2)` → href 含 &）
          url = MarkdownParser.decodeEntitiesInString(m[2]);
          content = '🖼️ ' + (m[1] || '图片');
        } else if (type === 'link') {
          content = m[1];
          // 自动链接：url 即捕获的地址原文；邮件自动链接的 href 语义带 mailto: 前缀。
          url =
            autolink === 'email'
              ? 'mailto:' + m[1]
              : autolink
                ? m[1]
                : MarkdownParser.decodeEntitiesInString(m[2]);
        } else if (type === 'checkbox') {
          isChecked = raw.includes('x') || raw.includes('X');
          content = isChecked ? '☑' : '☐';
        } else if (type === 'footnote') {
          content = m[1];
        } else if (type === 'code') {
          content = m[2];
        } else if (type === 'sub' || type === 'sup' || type === 'math') {
          content = m[1] !== undefined ? m[1] : raw;
        } else {
          content = raw;
        }
        return { type, raw, content, url, isChecked, length: raw.length };
      },
    });

    // —— 起止符规则工厂：exact-match 互斥 + `_` 围挡校验 + 失败记忆短路 + 递归解析 ——
    const startCloseRule = (
      name: string,
      start: string,
      close: string,
      type: string
    ): Omit<InlineRule<RefDefTable | null>, 'priority'> => ({
      name,
      start,
      match: (text, pos, ctx) => {
        if (!text.startsWith(start, pos)) return null;
        // EXACT MATCH 校验（同字符起止符）：'**' 不得被当作斜体 '*' 的开符
        // 而残留一个 '*' 悬空（'**' 与 '***' 的 run 长度必须精确匹配）。
        const char = start[0];
        const isRepeatingChar = start.split('').every((c) => c === char);
        let validStart = true;
        if (isRepeatingChar) {
          let runLen = 0;
          while (pos + runLen < text.length && text[pos + runLen] === char) {
            runLen++;
          }
          // 仅当 run 长度恰为规则长度时允许匹配；恰为两倍（'****' 对 '**'）
          // 且存在更长精确规则接管时本规则让路；其余长度一律无效。
          if (runLen !== start.length) {
            if (runLen === start.length * 2) {
              if (MarkdownParser.inlineRuler.hasExactStart(runLen, char)) {
                validStart = false;
              }
            } else {
              validStart = false;
            }
          }
        }

        // `_` 族开围挡校验（CommonMark Rule 2/9/10，review-02 §7.7 修正）：
        // 围挡校验只施加于 `_` 族——`foo*bar*baz` 保持解析（`*` 族无词内
        // 限制）、`foo_bar_baz` 不解析（LF 且非 RF 或前字符是标点才可开）。
        if (validStart && char === '_') {
          const prevChar = pos > 0 ? text[pos - 1] : ' ';
          const nextChar =
            pos + start.length < text.length ? text[pos + start.length] : ' ';
          const { left, right } = MarkdownParser.underscoreFlanking(
            prevChar,
            nextChar
          );
          if (
            !left ||
            (right && !MarkdownParser.IS_UNICODE_PUNCT.test(prevChar))
          ) {
            validStart = false;
          }
        }

        if (!validStart) return null;

        // 失败记忆短路：同位置同规则已确认失败（或位置 pos 之后已确认无闭合
        // 标记）→ 直接放弃递归——未闭合起止标记链的指数递归树由此坍缩为
        // 每位置每规则至多一次尝试（2^n 根治，失败位图与 ruler 共存）。
        const posKey = start + '@' + pos;
        const noCloseAt = ctx.noClose.get(start);
        if (
          ctx.failedAt.has(posKey) ||
          (noCloseAt !== undefined && noCloseAt <= pos)
        ) {
          return null;
        }
        const res = ctx.recurse(start, close, type, pos);
        if (!res) {
          // 规则失败：位置级记忆（跨递归层共享），后续同位置尝试直接跳过。
          ctx.failedAt.add(posKey);
          return null;
        }
        return {
          type,
          raw: text.substring(pos, pos + res.length),
          content: text.substring(
            pos + start.length,
            pos + res.length - close.length
          ),
          children: res.tokens,
          length: res.length,
        };
      },
    });

    // —— 规则注册表：注册顺序 = 原 INLINE_RULES 数组顺序（同序同义） ——
    const rules: Array<Omit<InlineRule<RefDefTable | null>, 'priority'>> = [
      regexRule(
        'image',
        'image',
        /^!\[((?:[^\]\\]|\\.){0,2000})\]\(((?:[^)\\]|\\.){0,2000})\)/
      ),
      // 代码 span（B8c 重写，CommonMark 6.1 优先于链接——spec 例 342：
      // `[not a `link](/foo`)` 中 code span 先消费，`[` 不构成链接）：
      // 完整反引号 run 开括 + 等长 run 闭合，内容首尾空格归一化。
      {
        name: 'code_span',
        match: (text, pos) => {
          const span = MarkdownParser.matchCodeSpan(text, pos);
          if (!span) return null;
          return {
            type: 'code',
            raw: span.raw,
            content: span.content,
            length: span.length,
          };
        },
      },
      // 内联链接（手写匹配，见 tryMatchInlineLink）：栈式 label（含嵌套 `[bar]`）+
      // 目标/标题正则（任务 5：裸目标禁空白、括号嵌套平衡、title 引号/括号边界）。
      {
        name: 'link_inline',
        match: (text, pos) => {
          const link = MarkdownParser.tryMatchInlineLink(text, pos);
          return link
            ? {
                type: 'link',
                raw: link.raw,
                content: link.content,
                url: link.url,
                length: link.raw.length,
              }
            : null;
        },
      },
      regexRule('checkbox', 'checkbox', /^\[\s*[xX\s]\s*\]/),
      regexRule('footnote', 'footnote', /^\[\^([0-9a-zA-Z]{1,100})\]/),
      // 引用链接（02 §2.3）：footnote 之后、code 之前——链接优先级：内联 > 引用 > 脚注。
      // 查表失败（未定义）回退文本；`[label][ref]` 完整形式失败不回退直接形式。
      {
        name: 'link_reference',
        match: (text, pos, ctx) => {
          const link = MarkdownParser.tryMatchReferenceLink(
            text,
            pos,
            ctx.refDefs
          );
          return link
            ? {
                type: 'link',
                raw: link.raw,
                content: link.content,
                url: link.url,
                length: link.raw.length,
              }
            : null;
        },
      },
      startCloseRule('bold_italic_strong', '***', '***', 'bold_italic'),
      startCloseRule('bold_strong', '**', '**', 'bold'),
      startCloseRule('italic_em', '*', '*', 'italic'),
      // `_` 下划线强调族（02 §2.7 / review-02 §7.7 修正）：
      // 与 `*` 族对称的三规则；围挡校验（Rule 9/10/11/12）只施加于 `_` 族——
      // `foo*bar*baz` 保持解析（intraword 限制仅属于 `_`），`foo_bar_baz` 不解析。
      startCloseRule('bold_italic_under', '___', '___', 'bold_italic'),
      startCloseRule('bold_under', '__', '__', 'bold'),
      startCloseRule('italic_under', '_', '_', 'italic'),
      startCloseRule('strike', '~~', '~~', 'strike'),
      startCloseRule('mark', '==', '==', 'mark'),
      // 自动链接（02 §2.4）：URI / 邮件正则插在 HTML 起止规则（`<b>` 等）之前——
      // tagName 白名单修复后 `<http://x>` 不再被 HTML 分支吞掉，此处按 link 语义接管。
      // URI scheme 必须 2~32 字符（`<m:abc>` 不匹配）；内容不含空白/`<>`（CommonMark 6.9）。
      regexRule(
        'autolink_uri',
        'link',
        /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\x00-\x20]*)>/,
        'uri'
      ),
      // 邮件自动链接：url 语义带 mailto: 前缀（href 语义），content 为原文（渲染文本）。
      regexRule(
        'autolink_email',
        'link',
        /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/,
        'email'
      ),
      startCloseRule('html_bold_b', '<b>', '</b>', 'bold'),
      startCloseRule('html_bold_strong', '<strong>', '</strong>', 'bold'),
      startCloseRule('html_italic_i', '<i>', '</i>', 'italic'),
      startCloseRule('html_italic_em', '<em>', '</em>', 'italic'),
      startCloseRule('html_strike_s', '<s>', '</s>', 'strike'),
      startCloseRule('html_strike_del', '<del>', '</del>', 'strike'),
      startCloseRule('html_mark', '<mark>', '</mark>', 'mark'),
      // `<u>` 不在此注册（02 §4.3 实证修复）：CommonMark 中 `<u>` 是 raw HTML
      // 语义——在 HTML 分支按 html_element 原样透传（tagName 白名单已放开），
      // 不得再映射为 sub（`<u>x</u>` 曾错误产出下标语义，语义错位）。
      startCloseRule('html_sub_ins', '<ins>', '</ins>', 'sub'),
      startCloseRule('html_kbd', '<kbd>', '</kbd>', 'kbd'),
      startCloseRule('html_sub', '<sub>', '</sub>', 'sub'),
      startCloseRule('html_sup', '<sup>', '</sup>', 'sup'),
      regexRule('math_display', 'math', /^\$\$((?:[^\$\\]|\\.){1,2000})\$\$/),
      regexRule(
        'math_inline',
        'math',
        /^\$((?:[^\s\$\\]|\\.)(?:(?:[^\$\\]|\\.){0,2000}?(?:[^\s\$\\]|\\.))?)\$/
      ),
      regexRule('sup_caret', 'sup', /^\^([^\s^]{1,500})\^/),
      regexRule('sub_tilde', 'sub', /^~([^\s~]{1,500})~/),
      startCloseRule('spoiler', '||', '||', 'spoiler'),
      // 原始 HTML 标签（B8c 重写，CommonMark 6.11 严格文法）：
      // 注释 / PI / 声明 / CDATA / 开闭标签经 matchRawHtmlTag 单源判定——
      // 取代宽松正则（`<a h*#ref>`、`<a href="hi'` 等非法标签按文本转义，
      // spec 例 619/620）。scanTokens 的 `<` 分支对开标签已先行配对
      // html_element，此处兜底其余形态（自闭合 / 孤立标签 / 闭合标签）。
      {
        name: 'html_tag',
        match: (text, pos) => {
          const tag = MarkdownParser.matchRawHtmlTag(slice(text, pos));
          if (!tag) return null;
          return {
            type: 'html_tag',
            raw: tag.raw,
            content: tag.raw,
            length: tag.raw.length,
          };
        },
      },
      regexRule('table_pipe', 'table_pipe', /^\|/),
    ];

    // priority = 注册总数 - 下标：严格递减，扫描尝试顺序 = 注册顺序（= 原数组顺序）
    const ruler = new InlineRuler<RefDefTable | null>();
    const total = rules.length;
    for (let i = 0; i < total; i++) {
      ruler.add({ ...rules[i], priority: total - i });
    }
    return ruler;
  }

  /** 行内规则扫描注册表（INLINE_RULES 数组的迁移产物，见 buildInlineRuler） */
  private static inlineRuler: InlineRuler<RefDefTable | null> =
    MarkdownParser.buildInlineRuler();

  private static parseInlineTokens(
    text: string,
    localOffset: number,
    isTopLevel: boolean = false,
    refDefs: RefDefTable | null = null
  ): InlineNode[] {
    // 每行一次失败记忆：行内所有递归调用共享同一份（跨递归层共享），行与行之间由行缓存隔离。
    const memo: ScanFailureMemo = {
      failedAt: new Set(),
      noClose: new Map(),
    };
    const res = this.scanTokens(text, 0, localOffset, null, 0, memo, refDefs);
    if (!res.ok) {
      return isTopLevel
        ? [
            {
              type: 'text',
              raw: '',
              content: '',
              localOffset: localOffset,
              length: 0,
            },
          ]
        : [];
    }
    if (res.tokens.length === 0 && isTopLevel) {
      res.tokens.push({
        type: 'text',
        raw: '',
        content: '',
        localOffset: localOffset,
        length: 0,
      });
    }

    return res.tokens;
  }

  public static parseHtmlStyle(styleStr: string): React.CSSProperties {
    const styleObj: Record<string, string> = {};
    if (!styleStr) return styleObj;
    const declarations = styleStr.split(';');
    for (const decl of declarations) {
      const colonIdx = decl.indexOf(':');
      if (colonIdx > 0) {
        const rawProp = decl.slice(0, colonIdx).trim();
        const val = decl.slice(colonIdx + 1).trim();
        const prop = rawProp.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (prop && val) {
          styleObj[prop] = val;
        }
      }
    }
    return styleObj as React.CSSProperties;
  }

  public static parseHtmlAttributes(attrStr: string): {
    attributes: Record<string, string>;
    style: React.CSSProperties;
  } {
    const attributes: Record<string, string> = {};
    let style: React.CSSProperties = {};
    if (!attrStr) return { attributes, style };

    const attrRegex =
      /([a-zA-Z0-9_\-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let match;
    while ((match = attrRegex.exec(attrStr)) !== null) {
      const name = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      attributes[name] = value;
      if (name === 'style') {
        style = { ...style, ...this.parseHtmlStyle(value) };
      } else if (name === 'color') {
        (style as any).color = value;
      }
    }
    return { attributes, style };
  }

  /**
   * 在字符串 s 的 i 位置尝试匹配实体引用（02 §2.6）：
   * 命名实体 `&name;`（名字 2~32 字符，查 NAMED_ENTITIES）与数值实体
   * `&#d;`（十进制 1~7 位）/ `&#xH;`（十六进制 1~6 位，x 大小写均可）。
   * 未定义命名实体 / 缺分号 / 数字超长 → 返回 null（保持字面）。
   */
  private static matchEntityAt(
    s: string,
    i: number
  ): { value: string; length: number } | null {
    const slice = s.slice(i);
    const named = /^&([A-Za-z][A-Za-z0-9]{1,31});/.exec(slice);
    if (named) {
      const v = NAMED_ENTITIES[named[1]];
      return v !== undefined ? { value: v, length: named[0].length } : null;
    }
    const dec = /^&#([0-9]{1,7});/.exec(slice);
    if (dec) {
      return {
        value: this.codePointToChar(Number(dec[1])),
        length: dec[0].length,
      };
    }
    const hex = /^&#[xX]([0-9A-Fa-f]{1,6});/.exec(slice);
    if (hex) {
      return {
        value: this.codePointToChar(parseInt(hex[1], 16)),
        length: hex[0].length,
      };
    }
    return null;
  }

  /**
   * 数值实体码点 → 字符（CommonMark：0、代理区、>0x10FFFF 一律替换为 U+FFFD）。
   */
  private static codePointToChar(cp: number): string {
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return '\uFFFD';
    }
    return String.fromCodePoint(cp);
  }

  /**
   * 通用实体解码（用于链接目标/标题、引用定义等扫描期原文）：
   * `\&` 位置不解码（保留原文，后续 unescapePunctuation 再还原 `\&` → `&`，
   * 从而 `\&amp;` 语义为「转义 & + 字面 amp;」，与 CommonMark 一致）。
   */
  private static decodeEntitiesInString(s: string): string {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '&') {
        out += '\\&';
        i += 2;
        continue;
      }
      if (c === '&') {
        const r = this.matchEntityAt(s, i);
        if (r) {
          out += r.value;
          i += r.length;
          continue;
        }
      }
      out += c;
      i++;
    }
    return out;
  }

  /**
   * flushText 专用解码（review-02 §7.6 修正）：content 与 raw 并行推进。
   * 转义边界在扫描期已消费（`\&` → content 中的 `&`），flush 时只能对照
   * raw 识别：raw 中 `\&` 位置的 & 跳过解码；raw 中裸 & 位置尝试实体匹配。
   */
  private static decodeTextEntities(raw: string, content: string): string {
    let out = '';
    let ri = 0;
    let ci = 0;
    while (ci < content.length) {
      if (ri < raw.length && raw[ri] === '\\' && raw[ri + 1] === '&') {
        // 转义 &：content 对应字符原样保留（不解码）
        out += content[ci];
        ri += 2;
        ci += 1;
        continue;
      }
      if (content[ci] === '&') {
        const r = this.matchEntityAt(content, ci);
        if (r) {
          out += r.value;
          ri += r.length;
          ci += r.length;
          continue;
        }
      }
      out += content[ci];
      ri += 1;
      ci += 1;
    }
    return out;
  }

  /**
   * 反斜杠转义还原（CommonMark 可转义标点）：`\x`（x 为可转义标点）→ x；
   * 其余 `\x`（x 非标点，如 `\b`）原样保留。
   */
  private static unescapePunctuation(s: string): string {
    return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  }

  // —— `_` 强调围挡校验（CommonMark 0.31.2 Rule 9/10/11/12）——
  // Unicode 空白：Zs 类别 + tab/LF/FF/CR（JS `\s` 与之近似，覆盖 U+00A0 等）。
  // Unicode 标点：P 类别 + S 类别（符号也算标点，如 `$`/`£`——spec 例 5）。
  private static IS_UNICODE_WS = /\s/;
  private static IS_UNICODE_PUNCT = /[\p{P}\p{S}]/u;

  /**
   * `_` 族 delimiter run 围挡判定（CommonMark Rule 9/10）：
   * 左围挡：后非空白 且（后非标点 或 前空白/标点）；
   * 右围挡：前非空白 且（前非标点 或 后空白/标点）。
   * 行首/行尾视为空白。仅 `_` 族使用（`*` 族无 intraword 限制，review-02 §7.7）。
   */
  private static underscoreFlanking(
    prevChar: string,
    nextChar: string
  ): { left: boolean; right: boolean } {
    const lastWs = this.IS_UNICODE_WS.test(prevChar);
    const nextWs = this.IS_UNICODE_WS.test(nextChar);
    const lastPunct = this.IS_UNICODE_PUNCT.test(prevChar);
    const nextPunct = this.IS_UNICODE_PUNCT.test(nextChar);
    const left = !nextWs && (!nextPunct || lastWs || lastPunct);
    const right = !lastWs && (!lastPunct || nextWs || nextPunct);
    return { left, right };
  }

  private static scanTokens(
    text: string,
    startIndex: number,
    localOffset: number,
    rule: InlineCloseRule | null,
    depth: number,
    memo: ScanFailureMemo,
    refDefs: RefDefTable | null = null
  ): ScanOutcome {
    // 深度剪枝兜底：超过 20 层直接放弃。此处的 null 是「未扫描」而非「确认失败」——
    // 合法深嵌套可能在剪枝点之后闭合，因此**不得写入失败记忆**（写记忆会误杀合法深嵌套）。
    if (depth > 20) return { ok: false };

    const start = rule ? rule.start : '';
    const close = rule ? rule.close : null;
    let i = startIndex + start.length;
    const innerTokens: InlineNode[] = [];
    let currentRawText = '';
    let currentContentText = '';

    const flushText = () => {
      if (currentRawText.length > 0) {
        innerTokens.push({
          type: 'text',
          raw: currentRawText,
          // 实体解码（02 §2.6）：仅解码 content、raw 保留原文（覆盖守恒不受影响）；
          // code/math 原子上下文内不解码（CommonMark：code span 内实体保持字面）。
          content: isAtomicContext
            ? currentContentText
            : this.decodeTextEntities(currentRawText, currentContentText),
          localOffset: localOffset + i - currentRawText.length,
          length: currentRawText.length,
        });
        currentRawText = '';
        currentContentText = '';
      }
    };

    const isMathContext = rule && rule.type === 'math';
    const isCodeContext = rule && rule.type === 'code';
    const isAtomicContext = isMathContext || isCodeContext;
    const ESCAPABLE_PUNCTUATION = new Set([
      '!',
      '"',
      '#',
      '$',
      '%',
      '&',
      "'",
      '(',
      ')',
      '*',
      '+',
      ',',
      '-',
      '.',
      '/',
      ':',
      ';',
      '<',
      '=',
      '>',
      '?',
      '@',
      '[',
      '\\',
      ']',
      '^',
      '_',
      '`',
      '{',
      '|',
      '}',
      '~',
    ]);

    // 行内规则扫描上下文（ruler.scan 调用参数，06 分析 §1）：递归帧一份，
    // 供规则 match 访问引用定义表 / 失败位图记忆 / 内层递归入口——
    // match 保持纯函数形态，扫描环境由循环注入。
    const rulerCtx: InlineRuleContext<RefDefTable | null> = {
      refDefs,
      failedAt: memo.failedAt,
      noClose: memo.noClose,
      recurse: (start, close, type, pos) => {
        const res = this.scanTokens(
          text,
          pos,
          localOffset,
          { start, close, type },
          depth + 1,
          memo,
          refDefs
        );
        return res.ok ? { tokens: res.tokens, length: res.length } : null;
      },
    };

    while (i < text.length) {
      if (text[i] === '\\' && i + 1 < text.length) {
        const nextChar = text[i + 1];
        if (!isMathContext && ESCAPABLE_PUNCTUATION.has(nextChar)) {
          currentRawText += text.substring(i, i + 2); // keep \x in raw
          currentContentText += nextChar; // only unescaped char in content
          i += 2;
          continue;
        } else {
          currentRawText += text[i];
          currentContentText += text[i];
          i++;
          continue;
        }
      }

      // Check if we found the exact closing tag
      const subClose = text.substring(i, i + (close ? close.length : 0));
      const isMatchClose =
        close &&
        (close.startsWith('</')
          ? subClose.toLowerCase() === close.toLowerCase()
          : subClose === close);
      if (isMatchClose) {
        let validClose = true;
        if (close === '*' && text.substring(i, i + 2) === '**')
          validClose = false;
        if (close === '_' && text.substring(i, i + 2) === '__')
          validClose = false;
        if (close === '$' && text.substring(i, i + 2) === '$$')
          validClose = false;

        // `_` 族闭围挡校验（Rule 4：RF 且（非 LF 或后字符是标点））：
        // 独立于 `*` 族实现（review-02 §7.7——不得给 `*` 族加词内限制）。
        if (validClose && close && close[0] === '_') {
          const prevChar = i > 0 ? text[i - 1] : ' ';
          const nextChar =
            i + close.length < text.length ? text[i + close.length] : ' ';
          const { left, right } = this.underscoreFlanking(prevChar, nextChar);
          if (!right || (left && !this.IS_UNICODE_PUNCT.test(nextChar))) {
            validClose = false;
          }
        }

        // Prevent unclosed tags like **未闭合 from being parsed as empty * tags
        if (validClose && i === startIndex + start.length) {
          const combined = start + close;
          // 「start + close 合并串」若构成其它规则的起始标记（如 '*' + '*' = '**'
          // 对应 bold 规则）则本闭合无效——hasStartRule 查 ruler 注册表
          // （原 INLINE_RULES.some(r => r.start === combined) 的迁移）。
          const formsOtherRule = this.inlineRuler.hasStartRule(combined);
          if (formsOtherRule) {
            validClose = false;
          }
        }

        if (validClose) {
          flushText();
          return {
            ok: true,
            tokens: innerTokens,
            length: i + close.length - startIndex,
          };
        }
      }

      // In atomic contexts like math or code, do NOT parse nested markdown/HTML rules!
      if (isAtomicContext) {
        currentRawText += text[i];
        currentContentText += text[i];
        i++;
        continue;
      }

      // Try rules
      let matched = false;
      // Cap inline regex scanning to a maximum of 2000 characters to prevent O(N^2) ReDoS / scanning overhead on massive lines.
      const sub =
        text.length - i > 2000
          ? text.substring(i, i + 2000)
          : text.substring(i);

      // Check for HTML open tag with possible closing tag on the line
      if (sub.startsWith('<')) {
        // B8c：CommonMark 6.11 严格标签文法（matchRawHtmlTag 单源判定）——
        // 取代旧的宽松正则：`<a h*#ref="hi">`（非法属性名，例 619）、
        // `<a href="hi'>`（引号值未闭合，例 620）、`</a href>`（闭合标签
        // 带属性，例 624）等一律按普通文本转义，不再猜测性透传。
        // `<http://x>` 自动链接依旧让路（`:` 非标签名/属性字符）。
        const tag = this.matchRawHtmlTag(sub);
        if (tag) {
          const tagName = tag.tagName ?? '';
          // isSpecialTag 豁免名单：这些标签由 ruler 内置起止规则接管语义
          // （sub/sup/kbd/ins 是编辑器扩展语义）。`<u>` 已移出名单与规则表
          // （02 §4.3 修复）——CommonMark raw HTML 语义，走 html_element 分支。
          const isSpecialTag = ['ins', 'sub', 'sup', 'kbd'].includes(tagName);

          if (tag.kind === 'open' && !tag.isSelfClosing && !isSpecialTag) {
            // 失败签名键：与 ruler 内置同名起止规则（如 '<b>'）共用同一键——
            // 二者闭合语义一致（闭合标记都是 `</tagName>`），记忆可互查互写。
            const tagKey = '<' + tagName + '>';
            const posKey = tagKey + '@' + i;
            const noCloseAt = memo.noClose.get(tagKey);
            if (
              !memo.failedAt.has(posKey) &&
              (noCloseAt === undefined || noCloseAt > i)
            ) {
              const closeTag = `</${tagName}>`;
              const closeIdx = text
                .toLowerCase()
                .indexOf(closeTag.toLowerCase(), i + tag.raw.length);
              if (closeIdx !== -1) {
                const { attributes, style } = this.parseHtmlAttributes(
                  tag.attrStr ?? ''
                );
                const htmlRule = {
                  type: 'html_element',
                  start: tag.raw,
                  close: closeTag,
                  tagName,
                  attributes,
                  style,
                };
                const res = this.scanTokens(
                  text,
                  i,
                  localOffset,
                  htmlRule,
                  depth + 1,
                  memo,
                  refDefs
                );
                if (res.ok) {
                  flushText();
                  innerTokens.push({
                    type: 'html_element',
                    raw: text.substring(i, i + res.length),
                    content: text.substring(
                      i + tag.raw.length,
                      i + res.length - closeTag.length
                    ),
                    children: res.tokens,
                    localOffset: localOffset + i,
                    length: res.length,
                    tagName,
                    attributes,
                    style,
                  });
                  i += res.length;
                  matched = true;
                } else {
                  // 闭合标记存在但被内层嵌套消费（或剪枝挡路）：位置级失败记忆，只封禁本位置。
                  memo.failedAt.add(posKey);
                }
              } else {
                // indexOf 确认位置 i 之后不存在闭合标记：文本事实，位置无关——
                // 任何 q >= i 的尝试窗口 (q, EOF) 都不可能闭合，按规则级记录最小确认位置。
                const current = memo.noClose.get(tagKey);
                if (current === undefined || i < current) {
                  memo.noClose.set(tagKey, i);
                }
              }
            }
          } else if (!isSpecialTag) {
            // 注释 / PI / 声明 / CDATA / 闭合标签 / 自闭合开标签：
            // raw 原样透传（html_tag 语义，CommonMark raw HTML 逐字节输出）
            flushText();
            innerTokens.push({
              type: 'html_tag' as InlineNode['type'],
              raw: tag.raw,
              content: tag.raw,
              localOffset: localOffset + i,
              length: tag.raw.length,
            });
            i += tag.raw.length;
            matched = true;
          }
        }
      }

      if (!matched) {
        // 行内规则尝试：ruler 按 priority 降序（= 原 INLINE_RULES 数组顺序）
        // 逐规则调用纯函数 match，首个命中即消费（06 分析 §1）——
        // 正则/链接/起止符规则的实现全部迁入 buildInlineRuler 的注册表。
        const inlineMatch = this.inlineRuler.scan(text, i, rulerCtx);
        if (inlineMatch) {
          flushText();
          innerTokens.push({
            type: inlineMatch.type as InlineNode['type'],
            raw: inlineMatch.raw,
            content: inlineMatch.content,
            url: inlineMatch.url,
            isChecked: inlineMatch.isChecked,
            children: inlineMatch.children,
            localOffset: localOffset + i,
            length: inlineMatch.length,
          });
          i += inlineMatch.length;
          matched = true;
        }
      }

      if (!matched) {
        // Determine run length of the failed syntax character so we don't partially match it
        let runLen = 1;
        const char = text[i];
        if (['*', '~', '=', '`', '_'].includes(char)) {
          while (i + runLen < text.length && text[i + runLen] === char) {
            runLen++;
          }
        }

        currentRawText += text.substring(i, i + runLen);
        currentContentText += text.substring(i, i + runLen);
        i += runLen;
      }
    }

    flushText();

    // If we were looking for a closing tag and reached EOF, parsing failed.
    if (close) {
      return { ok: false };
    }

    return { ok: true, tokens: innerTokens, length: i - startIndex };
  }
}

if (typeof window !== 'undefined') {
  (window as any).MarkdownParser = MarkdownParser;
}
