import type { LineNode, InlineNode, MarkdownDocument, CalloutType } from './ast';
import { LRUCache } from './LRUCache';
import { decodeHTMLStrict } from 'entities';
import { projectInlineText, projectCodeText, isEscapablePunctuation, type InlineTextProjection } from './inlineTextProjection';
// 行内规则插件体系（06 分析 §1）：INLINE_RULES 数组迁移为 ruler 注册表——
// 内置规则初始注册见 buildInlineRuler，宿主自定义语法（@mention 等）经
// InlineRuler.register 全局注册，无需改动 parser 核心。
import { InlineRuler } from './InlineRuler';
import type { InlineRule, InlineRuleContext } from './InlineRuler';
// 缩进语义单一真源（战役 wysiwyg-layout-remediation T2/ADR-1）：列宽坐标系、
// 列表标记识别、内容缩进列计算全仓唯一定义——parser 不再自带副本。
import {
  leadingColumns,
  matchListMarker,
  isListMarkerStart,
  isThematicBreak,
} from './layout/IndentModel';
// 嵌套层级真源（T3/ADR-2）：CommonMark §5.2 列表容器栈，产出整数 listDepth。
import { ListContext as ListContainerStack, type ListLineResult } from './layout/ListContext';
import { DocumentContextIndex, type LineParseContext, type ScannedLine, type ScanSnapshot, type OpenBlock } from './DocumentContext';
import { scanReferenceDefinition } from './referenceDefinition';
import { isTableSeparator } from './blockSyntax';

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
 * 逐行列表归属（T3 / ADR-2）：由 `ListContainerStack` 在 computeLineOffsets 的
 * 主循环末尾逐行产出，随 parseLine 注入。
 *
 * 三个字段的分工：
 * - `depth`：整数嵌套层级（0 起，-1 = 不在列表容器内）——渲染层缩进阶梯的
 *   **唯一输入**，渲染层不再做任何数值比较（断层 G7）；
 * - `contentIndentColumns`：本行所属容器的内容缩进列（CommonMark §5.2）——
 *   缩进代码块判定与投影层归属判定共用；
 * - `continuation`：本行是否为「非标记行但归属列表项内容」（延续行）——
 *   投影层据此并入同一 `<li>` 的后续块。
 */
export type LineListInfo = ListLineResult;

/** 不在列表容器内的统一值（冻结复用，避免热路径分配） */
export const NO_LIST_INFO: LineListInfo = Object.freeze({
  depth: -1,
  contentIndentColumns: -1,
  continuation: false,
  afterBlank: false,
  markers: Object.freeze([]),
  blockquoteLevel: 0,
  contentOffset: 0,
  contentColumn: 0,
  content: '',
  lazy: false,
  containerClosed: false,
});
const PLAIN_LINE_CONTEXT: ScannedLine['context'] = Object.freeze({
  codeState: 'none', listInfo: NO_LIST_INFO, setextLevel: 0, isRefDefLine: false,
  lazyInherit: null, codeLang: null, calloutType: null, calloutTitle: null, isCalloutHeader: false,
});

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

  public static createDocumentContext(): DocumentContextIndex {
    return new DocumentContextIndex((getLine, index, count, before) =>
      this.scanLineContext(getLine, index, count, before));
  }

  public static parseLineWithContext(line: string, offset: number, context: LineParseContext): LineNode {
    const info = context.listInfo;
    const node = this.parseLine(line, offset, context.codeState, context.setextLevel,
      context.refDefs, context.isRefDefLine, info, context.lazyInherit, context.blockEnd,
      context.codeLang, context.calloutType, context.calloutTitle, context.isCalloutHeader);
    const first = info.markers[0];
    return {
      ...node,
      listMarkers: info.markers.length ? info.markers : undefined,
      listPrefix: first?.marker.prefix,
      indentColumns: first?.indentColumns,
      listDepth: first?.depth ?? (info.depth >= 0 ? info.depth : undefined),
      contentIndentColumns: info.depth >= 0 ? info.contentIndentColumns : undefined,
      listContinuation: info.continuation && info.afterBlank && node.type === 'body' ? true : undefined,
      blockquoteLevel: info.blockquoteLevel || undefined,
    };
  }

  public static parse(text: string): MarkdownDocument {
    const lines = text.split('\n');
    const context = this.createDocumentContext();
    context.update((i) => lines[i], lines.length, 0, 0, lines.length);
    let offset = 0;
    return { lines: lines.map((line, i) => {
      const node = this.parseLineWithContext(line, offset, context.get(i));
      offset += line.length + 1;
      return node;
    }) };
  }
  private static normalizeRefLabel(s: string): string {
    return this.decodeEntitiesInString(
      s.replace(/\s+/g, ' ').trim().toLowerCase()
    );
  }

  public static computeLineOffsets(text: string) {
    const lines = text.split('\n');
    const index = this.createDocumentContext();
    index.update((i) => lines[i], lines.length, 0, 0, lines.length);
    const contexts = lines.map((_, i) => index.get(i));
    let offset = 0;
    return {
      offsets: lines.map((line) => { const value = offset; offset += line.length + 1; return value; }),
      codeBlockState: contexts.map((context) => context.codeState),
      setextLevels: contexts.map((context) => context.setextLevel),
      listInfos: contexts.map((context) => context.listInfo),
      lazyContinuation: contexts.map((context) => context.lazyInherit),
      fenceLangs: contexts.map((context) => context.codeLang),
      calloutTypes: contexts.map((context) => context.calloutType),
      calloutTitles: contexts.map((context) => context.calloutTitle),
      isCalloutHeaders: contexts.map((context) => context.isCalloutHeader),
    };
  }

  /** 唯一块状态转移；全量、局部编辑、追加和实时行投影均消费它的结果。 */
  private static scanLineContext(
    getLine: (index: number) => string,
    index: number,
    lineCount: number,
    before: ScanSnapshot,
  ): ScannedLine {
    const source = getLine(index);
    // 字母起始且没有表格管道的根段落不可能开启任何块语法；同一状态转移
    // 直接确认正文，避免百万行普通文本重复分配容器和运行块标记匹配器。
    if (before.block === null && before.containers.frames.length === 0 &&
      before.definitionRemaining === 0 && before.callout === null &&
      /^[A-Za-z]/.test(source) && source.indexOf('|') === -1) {
      return {
        context: PLAIN_LINE_CONTEXT,
        after: {
          ...before,
          containers: before.containers.paragraphOpen && !before.containers.previousBlank
            ? before.containers : { ...before.containers, paragraphOpen: true, previousBlank: false },
          paragraphStart: before.containers.paragraphOpen ? before.paragraphStart : index,
        },
      };
    }
    const interrupts = (content: string, column: number) =>
      leadingColumns(content, column) <= 3 &&
      (this.matchHtmlBlockStart(content, before.containers.paragraphOpen ? 'body' : 'blank') !== null ||
        this.guessBlockKind(content, 'body') === 'table');
    let stack = new ListContainerStack(before.containers);
    let prefix = stack.accept({ source, verbatim: before.block !== null, interruptsParagraph: interrupts });
    let block: OpenBlock | null = before.block;
    let closeTrailingBlanks = false;
    if (block && (prefix.containerClosed ||
      (block.kind === 'indent' && prefix.content.trim() !== '' &&
        leadingColumns(prefix.content, prefix.contentColumn) < 4))) {
      closeTrailingBlanks = prefix.containerClosed && (block.kind === 'fence' || block.kind === 'math');
      block = null;
      stack = new ListContainerStack(before.containers);
      stack.setParagraphOpen(false);
      prefix = stack.accept({ source, interruptsParagraph: interrupts });
    }
    const content = prefix.content;
    const trimmed = content.trim();
    const indent = leadingColumns(content, prefix.contentColumn);
    const wasParagraph = before.containers.paragraphOpen && !prefix.containerClosed &&
      prefix.markers.length === 0;
    let codeState: CodeState = 'none';
    let codeLang: string | null = null;
    let paragraph = false;
    let paragraphStart = -1;
    let definitionRemaining = Math.max(0, before.definitionRemaining - 1);
    let definition: ScannedLine['definition'];
    let dependencyEnd: number | undefined;
    let headingFrom: number | undefined;
    let headingLevel: number | undefined;
    let setextLevel = 0;
    let isRefDefLine = before.definitionRemaining > 0;
    let callout = before.callout;
    let isCalloutHeader = false;

    if (block?.kind === 'html') {
      const end = this.htmlBlockEndCondition(block.htmlType!, content);
      codeState = end && trimmed === '' ? 'none' : 'html_block';
      if (end) block = null;
    } else if (block?.kind === 'fence') {
      if (indent <= 3 && isFenceClose(trimmed, block.marker!, block.length!)) {
        codeState = 'fence_end';
        block = null;
      } else {
        codeState = 'code';
        codeLang = block.language ?? null;
      }
    } else if (block?.kind === 'math') {
      codeState = trimmed === '$$' ? 'math_fence_end' : 'math_block';
      if (codeState === 'math_fence_end') block = null;
    } else if (block?.kind === 'indent') {
      codeState = 'indent_code';
    } else if (!isRefDefLine) {
      // 定义只在段落起点尝试。前向依赖会使后续增删从定义起点重放。
      const containerSnapshot = stack.snapshot();
      const reference = !wasParagraph && trimmed.startsWith('[')
        ? scanReferenceDefinition((line) => {
            if (line === index) return content;
            const scope = new ListContainerStack(containerSnapshot);
            scope.setParagraphOpen(false);
            const nested = scope.accept({ source: getLine(line) });
            return nested.containerClosed ? null : nested.content;
          }, index, lineCount)
        : null;
      if (reference) {
        dependencyEnd = reference.dependencyEnd;
        if (reference.label !== undefined && reference.url !== undefined) {
          isRefDefLine = true;
          definitionRemaining = reference.lines - 1;
          definition = {
            label: this.normalizeRefLabel(reference.label),
            value: {
              url: this.unescapePunctuation(this.decodeEntitiesInString(reference.url)),
              ...(reference.title !== undefined
                ? { title: this.unescapePunctuation(this.decodeEntitiesInString(reference.title)) } : {}),
            },
          };
        }
      }
      if (!isRefDefLine && trimmed !== '') {
        const underline = indent <= 3 && prefix.markers.length === 0 &&
          !prefix.lazy && wasParagraph ? /^(=+|-+)[ \t\r]*$/.exec(trimmed) : null;
        const fence = indent <= 3 ? /^(```+)([^`]*)$|^(~~~+).*$/.exec(trimmed) : null;
        const html = indent <= 3 ? this.matchHtmlBlockStart(content, wasParagraph ? 'body' : 'blank') : null;
        if (underline && before.paragraphStart >= 0) {
          setextLevel = -1;
          headingLevel = underline[1][0] === '=' ? 1 : 2;
          headingFrom = before.paragraphStart;
        } else if (fence) {
          codeState = 'fence_start';
          codeLang = this.normalizeFenceLang(fence[1] !== undefined ? fence[2] : trimmed.replace(/^~+/, ''));
          block = {
            kind: 'fence', marker: fence[1] !== undefined ? '`' : '~',
            length: (fence[1] ?? fence[3]).length, language: codeLang,
            quoteDepth: prefix.blockquoteLevel, listDepth: prefix.depth,
          };
        } else if (trimmed === '$$') {
          codeState = 'math_fence_start';
          block = { kind: 'math', quoteDepth: prefix.blockquoteLevel, listDepth: prefix.depth };
        } else if (html) {
          codeState = 'html_block';
          if (!this.htmlBlockEndCondition(html.type, content)) block = {
            kind: 'html', htmlType: html.type, quoteDepth: prefix.blockquoteLevel, listDepth: prefix.depth,
          };
        } else if (indent >= 4 && !wasParagraph) {
          codeState = 'indent_code';
          block = { kind: 'indent', quoteDepth: prefix.blockquoteLevel, listDepth: prefix.depth };
        } else {
          const kind = this.guessBlockKind(content, wasParagraph ? 'body' : 'blank');
          paragraph = prefix.lazy || (kind === 'body' && !isThematicBreak(content, prefix.contentColumn));
          if (paragraph) paragraphStart = wasParagraph ? before.paragraphStart : index;
        }
      }
    }
    if (codeState === 'none' && prefix.blockquoteLevel > 0) {
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i.exec(trimmed);
      if (alert) {
        callout = { type: alert[1].toLowerCase() as CalloutType, title: alert[2]?.trim() ?? '', level: prefix.blockquoteLevel };
        isCalloutHeader = true;
      }
    }
    if (callout && (prefix.blockquoteLevel < callout.level || source.trim() === '')) callout = null;
    stack.setParagraphOpen(paragraph);
    // 无容器的普通行共享空归属对象，百万行正文不分配百万份空轨迹。
    const listInfo = prefix.depth < 0 && prefix.blockquoteLevel === 0 && !prefix.lazy
      ? NO_LIST_INFO : prefix;
    return {
      context: {
        codeState, listInfo, setextLevel, isRefDefLine,
        lazyInherit: prefix.lazy && prefix.blockquoteLevel > 0 ? prefix.blockquoteLevel : null,
        codeLang, calloutType: callout?.type ?? null, calloutTitle: callout?.title ?? null, isCalloutHeader,
      },
      after: { containers: stack.snapshot(), block, paragraphStart, definitionRemaining, callout },
      ...(definition ? { definition } : {}),
      ...(dependencyEnd !== undefined ? { dependencyEnd } : {}),
      ...(headingFrom !== undefined ? { headingFrom, headingLevel } : {}),
      ...(closeTrailingBlanks ? { closeTrailingBlanks: true } : {}),
    };
  }
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
   * 轻量行首形态分类（computeLineOffsets 专用，供缩进代码判定的「上一行」上下文）：
   * 与 parseNormalLine 的块级判定顺序一致（hr → ATX → 表格 → 列表），
   * 只做行首前缀匹配、不解析内容——避免 computeLineOffsets 依赖 parseLine（递归）。
   * prev 为上一非空白行的形态，用于 Setext 下划线形态（`====`）的两行级判定：
   * 上一行是段落 → 该行为 Setext 标题（heading），否则只是普通段落（body）。
   */
  /**
   * 统计行内真实结构性表格管道符数：
   * 排除转义管道符 \|、代码块/反引号 `...`、行内/块级数学公式 $...$ / $$...$$、剧透标签 ||...||
   * 内部的管道符，避免数学绝对值符号（如 $|\mathbf{u}|^2$）或逻辑运算符误触发表格判定。
   */
  public static countStructuralPipes(text: string): number {
    if (!text || text.indexOf('|') === -1) return 0;
    let s = text.replace(/\\\|/g, '');
    s = s.replace(/`[^`\n]+`/g, '');
    s = s.replace(/\$\$[\s\S]*?\$\$/g, '');
    s = s.replace(/\$(?:[^\$\n\\]|\\.)+\$/g, '');
    const matches = s.match(/\|/g);
    return matches ? matches.length : 0;
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
    if (isThematicBreak(s)) return 'hr';
    if (/^=+[ \t]*$/.test(s)) return prev === 'body' ? 'heading' : 'body';
    if (/^#{1,6}\s/.test(s)) return 'heading';
    const pipeCount = MarkdownParser.countStructuralPipes(s);
    if (
      isTableSeparator(s) ||
      (pipeCount >= 2 && (s.trim().startsWith('|') || s.trim().endsWith('|') || pipeCount >= 3))
    ) {
      return 'table';
    }
    if (matchListMarker(s)) return 'list';
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
    if (isListMarkerStart(content)) return null;
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
    // 逐行列表归属（T3/ADR-2，computeLineOffsets / computeListInfoWindow 产物）：
    // 整数嵌套层级 + 内容缩进列 + 延续标志。必须进缓存键——同文本行在有无
    // 列表归属下产出不同节点（listDepth/contentIndentColumns/listContinuation），
    // 不进键会导致跨文档缓存串扰（例 256 的 `  two` 与普通 `  two`）。
    // `null` = 显式「无列表上下文」，内部规范化为 NO_LIST_INFO。
    listInfo: LineListInfo | null = null,
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
    const listInfoNorm = listInfo ?? NO_LIST_INFO;
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
      'L' +
      listInfoNorm.depth +
      ',' +
      listInfoNorm.contentIndentColumns +
      (listInfoNorm.continuation ? 'c' : '-') +
      // afterBlank 必须进键：同文本行（`  two`）在「空行后」与「紧邻延续」
      // 两种上下文下产出不同的 listContinuation（投影层语义），不进键会
      // 跨上下文串扰。
      (listInfoNorm.afterBlank ? 'b' : '-') +
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
      listInfo,
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
    // 逐行列表归属（T3/ADR-2）：整数嵌套层级 + 内容缩进列 + 延续标志，
    // 由列表容器栈逐行产出（全量路径 computeLineOffsets / 渲染路径
    // computeListInfoWindow）。`null` = 无列表上下文。
    listInfo: LineListInfo | null = null,
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
    const info = listInfo ?? new ListContainerStack().accept({ source: lineText });
    const tokens: InlineNode[] = [];
    let pos = 0;
    let lineType: 'heading' | 'body' | 'hr' | 'blockquote' | 'table_row' | 'table_separator' = 'body';
    let headingLevel = setextLevel > 0 ? setextLevel : 0;
    const isSetextHeading = setextLevel > 0;
    if (isSetextHeading) lineType = 'heading';
    const firstMarker = info.markers[0];
    const markerIndentColumns = firstMarker?.indentColumns ?? 0;
    const listPrefix = firstMarker?.marker.prefix ?? '';
    const blockquoteLevel = lazyInherit ?? info.blockquoteLevel;
    const remainingTextForPrefix = info.content || lineText.slice(info.contentOffset);

    const appendPrefix = (from: number, to: number) => {
      if (to <= from) return;
      const raw = lineText.slice(from, to);
      tokens.push(raw.includes('>')
        ? { type: 'blockquote_prefix', raw, content: '', localOffset: from, length: raw.length }
        : { type: 'text', raw, content: '', localOffset: from, length: raw.length,
            contentOffset: 0, contentSourceLength: raw.length, sourceBoundaries: [raw.length] });
    };
    // marker 的源码范围和深度只读容器轨迹；不再对同一行重识别列表。
    for (const occurrence of info.markers) {
      appendPrefix(pos, occurrence.sourceStart);
      const marker = occurrence.marker;
      const raw = lineText.slice(occurrence.sourceStart, occurrence.sourceEnd);
      tokens.push({
        type: marker.kind === 'task' ? 'list_task' : marker.kind === 'ol' ? 'list_number' : 'list_bullet',
        raw,
        content: marker.kind === 'ul' ? '•' : marker.prefix,
        indent: lineText.slice(occurrence.sourceStart, occurrence.markerStart),
        depth: occurrence.depth,
        marker: marker.prefix + ' ',
        isChecked: !!marker.taskRange && /[xX]/.test(lineText.slice(
          occurrence.markerStart + marker.taskRange.from,
          occurrence.markerStart + marker.taskRange.to)),
        localOffset: occurrence.sourceStart,
        length: raw.length,
      });
      pos = occurrence.sourceEnd;
    }
    if (info.contentOffset > pos) {
      appendPrefix(pos, info.contentOffset);
      pos = info.contentOffset;
    }
    if (lineText.slice(pos).trim() === '' && info.markers.length === 0) {
      return {
        id: this.generateId(), type: 'empty', raw: lineText,
        blockquoteLevel: blockquoteLevel || undefined,
        calloutType: calloutType ?? undefined, calloutTitle: calloutTitle ?? undefined,
        inlineTokens: tokens.length ? tokens : [{ type: 'text', raw: lineText, content: lineText,
          localOffset: 0, length: lineText.length }],
        length: lineText.length, localOffset,
      };
    }

    if (!isSetextHeading && lazyInherit === null && !info.lazy) {
      const nestedText = lineText.slice(pos);
      if (isThematicBreak(nestedText, info.contentColumn)) {
        lineType = 'hr';
        tokens.push({ type: 'text', raw: nestedText, content: nestedText,
          localOffset: pos, length: nestedText.length });
        pos = lineText.length;
      } else {
        const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(nestedText);
        if (heading) {
          lineType = 'heading';
          headingLevel = heading[1].length;
          tokens.push({ type: 'heading_prefix', raw: heading[0], content: '',
            localOffset: pos, length: heading[0].length });
          pos += heading[0].length;
        } else if (nestedText.length <= 10000 && info.markers.length === 0) {
          if (isTableSeparator(nestedText)) {
            lineType = 'table_separator';
          } else {
            const count = this.countStructuralPipes(nestedText);
            const trimmed = nestedText.trim();
            if (count >= 2 && (trimmed.startsWith('|') || trimmed.endsWith('|') || count >= 3)) lineType = 'table_row';
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

    // 列表归属落地（T3/ADR-2）：非标记行但归属列表项内容（延续行）——
    // 行仍是普通段落（body），但携带 listDepth / contentIndentColumns /
    // listContinuation，投影器据此把该行并入同一 <li> 的后续块
    // （spec 例 256/258/262/277）。Setext 标题 / hr / 表格等块级形态优先。
    // 注意：投影层的 `listContinuation` 语义是「**空行后**的列表项新段落」
    // （spec 例 256 的 `<li><p>one</p><p>two</p></li>`），与归属语义
    // `listInfo.continuation`（含紧邻延续与 lazy continuation）**不同**——
    // `- one\n  two` 是同一段落内的紧邻延续（`<li>one two</li>`），
    // 必须靠 `afterBlank` 区分，否则投影会多插一个 `<p>`。
    const isListContinuation =
      info.continuation &&
      info.afterBlank &&
      lineType === 'body' &&
      !isSetextHeading;

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
      listPrefix: listPrefix ? listPrefix : undefined,
      // 列表归属（T3/ADR-2）：marker 行带 indentColumns（标记前导缩进列宽）；
      // 所有归属列表的行（marker 行与延续行）都带 contentIndentColumns 与
      // 整数 listDepth——渲染层缩进阶梯的唯一输入（不再做数值比较）。
      indentColumns:
        listPrefix !== undefined ? markerIndentColumns : undefined,
      contentIndentColumns:
        info.contentIndentColumns >= 0 ? info.contentIndentColumns : undefined,
      listDepth: info.depth >= 0 ? info.depth : undefined,
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

    // 标注表格合并单元格属性 (colSpan / isMergedMaster / isMergedSlave)
    const cellNodes = result.filter((t) => t.type === 'table_cell');
    let currentMaster: InlineNode | null = null;
    for (const cell of cellNodes) {
      const trimmed = cell.raw.trim();
      if (trimmed === '>') {
        cell.isMergedSlave = true;
        cell.mergeType = 'horizontal';
        if (currentMaster) {
          currentMaster.isMergedMaster = true;
          currentMaster.colSpan = (currentMaster.colSpan ?? 1) + 1;
        }
      } else if (trimmed === '^') {
        cell.isMergedSlave = true;
        cell.mergeType = 'vertical';
        currentMaster = null;
      } else {
        cell.colSpan = 1;
        cell.rowSpan = 1;
        currentMaster = cell;
      }
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
  ): (InlineTextProjection & { raw: string; length: number; contentOffset: number; contentSourceLength: number }) | null {
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
          const projected = projectCodeText(text.substring(pos + openLen, j));
          return {
            raw,
            content: projected.content,
            contentOffset: openLen + projected.contentOffset,
            contentSourceLength: projected.sourceLength,
            sourceBoundaries: projected.sourceBoundaries,
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
  ): (InlineTextProjection & { raw: string; url: string; end: number; contentOffset: number; contentSourceLength: number }) | null {
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
      ...projectInlineText(text.slice(i + 1, label.end), (source, index) => this.matchEntityAt(source, index)),
      contentOffset: 1,
      contentSourceLength: label.end - i - 1,
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
  ): (InlineTextProjection & { raw: string; url: string; end: number; contentOffset: number; contentSourceLength: number }) | null {
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
      ...projectInlineText(labelRaw, (source, index) => this.matchEntityAt(source, index)),
      contentOffset: 1,
      contentSourceLength: labelRaw.length,
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
    ): Omit<InlineRule<RefDefTable | null>, 'priority'> => {
      const indexedRegex = regex.hasIndices ? regex : new RegExp(regex.source, regex.flags + 'd');
      return ({
      name,
      match: (text, pos) => {
        const m = indexedRegex.exec(slice(text, pos));
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
          content = m[1] || '图片';
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
          // 图形呈现归渲染层（矢量复选框），token 只携带语义（L2.2）
          content = '';
        } else if (type === 'footnote') {
          content = m[1];
        } else if (type === 'code') {
          content = m[2];
        } else if (type === 'sub' || type === 'sup' || type === 'math') {
          content = m[1] !== undefined ? m[1] : raw;
        } else {
          content = raw;
        }
        const contentGroup = type === 'code' ? 2 :
          ['image', 'link', 'footnote', 'sub', 'sup', 'math'].includes(type) ? 1 : 0;
        const [contentOffset, contentEnd] = m.indices![contentGroup] ?? [0, raw.length];
        return {
          type, raw, content, url, isChecked, length: raw.length,
          contentOffset, contentSourceLength: contentEnd - contentOffset,
        };
      },
      });
    };

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
          contentOffset: start.length,
          contentSourceLength: res.length - start.length - close.length,
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
            contentOffset: span.contentOffset,
            contentSourceLength: span.contentSourceLength,
            sourceBoundaries: span.sourceBoundaries,
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
                contentOffset: link.contentOffset,
                contentSourceLength: link.contentSourceLength,
                sourceBoundaries: link.sourceBoundaries,
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
                contentOffset: link.contentOffset,
                contentSourceLength: link.contentSourceLength,
                sourceBoundaries: link.sourceBoundaries,
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
   * 命名实体 `&name;`（HTML5 完整实体表）与数值实体
   * `&#d;`（十进制 1~7 位）/ `&#xH;`（十六进制 1~6 位，x 大小写均可）。
   * 未定义命名实体 / 缺分号 / 数字超长 → 返回 null（保持字面）。
   */
  private static matchEntityAt(
    s: string,
    i: number
  ): { value: string; length: number } | null {
    const match = /^&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});/.exec(s.slice(i));
    if (!match) return null;
    const value = decodeHTMLStrict(match[0]);
    return value === match[0] ? null : { value, length: match[0].length };
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
   * 反斜杠转义还原（CommonMark 可转义标点）：`\x`（x 为可转义标点）→ x；
   * 其余 `\x`（x 非标点，如 `\b`）原样保留。
   */
  private static unescapePunctuation(s: string): string {
    return projectInlineText(s, null).content;
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

    const flushText = () => {
      if (currentRawText.length > 0) {
        const projected = isAtomicContext
          ? { content: currentRawText }
          : projectInlineText(currentRawText, (source, index) => this.matchEntityAt(source, index));
        innerTokens.push({
          type: 'text',
          raw: currentRawText,
          ...projected,
          localOffset: localOffset + i - currentRawText.length,
          length: currentRawText.length,
        });
        currentRawText = '';
      }
    };

    const isCodeContext = rule && rule.type === 'code';
    const isAtomicContext = rule?.type === 'math' || isCodeContext;

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
        if (!isAtomicContext && isEscapablePunctuation(nextChar)) {
          currentRawText += text.substring(i, i + 2); // keep \x in raw
          i += 2;
          continue;
        } else {
          currentRawText += text[i];
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
                    contentOffset: tag.raw.length,
                    contentSourceLength: res.length - tag.raw.length - closeTag.length,
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
              type: 'html_tag',
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
            contentOffset: inlineMatch.contentOffset,
            contentSourceLength: inlineMatch.contentSourceLength,
            sourceBoundaries: inlineMatch.sourceBoundaries,
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
