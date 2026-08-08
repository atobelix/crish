import type { LineNode, InlineNode, MarkdownDocument } from './ast';
import { LRUCache } from './LRUCache';

export type CodeState =
  | 'none'
  | 'fence_start'
  | 'code'
  | 'fence_end'
  | 'math_fence_start'
  | 'math_fence_end'
  | 'math_block'
  | 'indent_code';

/**
 * computeLineOffsets 缩进代码判定的「上一非空白行块级形态」记忆
 * （02 §2.2 冲突点：段落打断 / 列表延续 / 表格优先都需要前一行上下文）：
 * - body/table/list → 缩进 4 空格的下一行是延续内容，不是代码；
 * - 其余（blank/heading/hr/code/other）→ 允许缩进代码块开始。
 */
type BlockKind =
  | 'blank'
  | 'body'
  | 'list'
  | 'table'
  | 'heading'
  | 'hr'
  | 'code'
  | 'other';

/** scanTokens 返回：ok 携带 token 列表与消费长度；失败时由调用方按失败签名记忆 */
type ScanOutcome =
  | { ok: true; tokens: InlineNode[]; length: number }
  | { ok: false };

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

export class MarkdownParser {
  private static idCounter = 0;
  private static generateId(): string {
    return 'line_' + (this.idCounter++).toString(36);
  }

  public static parse(text: string): MarkdownDocument {
    const { offsets, codeBlockState, setextLevels } =
      this.computeLineOffsets(text);
    const lines = text.split('\n');
    const lineNodes: LineNode[] = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      // Setext 上下文标志（0=普通行 / 1|2=Setext 标题内容行 / -1=Setext 下划线行）
      // 由预扫描 computeSetextContexts 产出，随 parseLine 传入——
      // 「标题身份由上下文决定、而非解析后回写」是 review-02 §7.1 的修正要求。
      lineNodes[i] = this.parseLine(
        lines[i],
        offsets[i],
        codeBlockState[i],
        setextLevels[i]
      );
    }
    return {
      lines: lineNodes,
    };
  }

  public static computeLineOffsets(text: string): {
    offsets: number[];
    codeBlockState: CodeState[];
    setextLevels: number[];
  } {
    const lines = text.split('\n');
    const offsets = new Array(lines.length);
    const codeBlockState: CodeState[] = new Array(lines.length);

    let currentOffset = 0;
    let inCodeBlock = false;
    let inMathBlock = false;
    // 缩进代码块状态（02 §2.2）：连续 ≥4 空格缩进行合并为一个代码块，
    // 块内空行保持状态（CommonMark：空行仍是代码块的一部分）。
    let inIndentCode = false;
    // 上一非空白行的块级形态记忆（见 BlockKind 注释）——行级模型无容器状态，
    // 用轻量行首形态分类近似「上一行是什么」，不依赖 parseLine（避免递归依赖）。
    let prevBlockKind: BlockKind = 'blank';

    for (let i = 0; i < lines.length; i++) {
      offsets[i] = currentOffset;
      // 块引用前缀剥离（与 parseNormalLine 同一正则 `^\s*>\s?`）：缩进判定发生
      // 在前缀剥离之后（`>     code` → 块引用内缩进代码）。注：该正则的 `\s*`
      // 会吞掉前导缩进（如 `    > foo` 被当作块引用前缀），与 parseNormalLine
      // 判定一致，属既有偏差，此处不另行修正（0 回归）。
      const { content: bqContent } = this.stripBlockquoteContext(lines[i]);
      const trimmed = bqContent.trim();

      if (!inMathBlock && trimmed.startsWith('```')) {
        if (!inCodeBlock) {
          codeBlockState[i] = 'fence_start';
          inCodeBlock = true;
        } else {
          codeBlockState[i] = 'fence_end';
          inCodeBlock = false;
        }
        // 围栏代码块内缩进不生效（CommonMark）；fence 判定先于缩进代码，
        // 且 `    ```（4 空格）仍按 fence 处理——trim 后判定的既有行为，登记偏差。
        inIndentCode = false;
        prevBlockKind = 'code';
      } else if (!inCodeBlock && trimmed === '$$') {
        if (!inMathBlock) {
          codeBlockState[i] = 'math_fence_start';
          inMathBlock = true;
        } else {
          codeBlockState[i] = 'math_fence_end';
          inMathBlock = false;
        }
        inIndentCode = false;
        prevBlockKind = 'code';
      } else if (inCodeBlock) {
        codeBlockState[i] = 'code';
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
          // 块内：空行与 ≥4 空格缩进行保持状态；非缩进行结束代码块。
          if (trimmed === '' || indent >= 4) {
            codeBlockState[i] = 'indent_code';
          } else {
            codeBlockState[i] = 'none';
            inIndentCode = false;
            prevBlockKind = this.guessBlockKind(bqContent, prevBlockKind);
          }
        } else if (trimmed === '') {
          // 空行：不进入缩进代码；段落/表格上下文重置（段落打断规则失效，
          // `para\n\n    code` 是代码块），列表上下文保持
          // （`- item\n\n    bar` 仍是松散列表延续）。
          codeBlockState[i] = 'none';
          if (prevBlockKind !== 'list') prevBlockKind = 'blank';
        } else if (indent >= 4) {
          const afterIndent = this.stripFourColumns(bqContent);
          if (this.isListMarkerStart(afterIndent)) {
            // 去缩进后以列表标记开头 → 嵌套列表/列表延续，按 body 解析。
            // 任务书简化：无条件列表优先（登记偏差——CommonMark 中文档级
            // `    - foo` 期望缩进代码，行级模型无列表容器状态无法区分）。
            codeBlockState[i] = 'none';
            inIndentCode = false;
            prevBlockKind = 'list';
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
            prevBlockKind = 'code';
          }
        } else {
          codeBlockState[i] = 'none';
          prevBlockKind = this.guessBlockKind(bqContent, prevBlockKind);
        }
      }

      currentOffset += lines[i].length + 1; // +1 for \n
    }

    // Setext 预扫描（紧随 computeLineOffsets 状态机，单趟 O(n)）：
    // 产出每行的 Setext 上下文标志，供 parseLine 消费（见 §2.1 与 review-02 §7.1）。
    const setextLevels = this.computeSetextContexts(lines, codeBlockState);

    return { offsets, codeBlockState, setextLevels };
  }

  /**
   * 剥离块引用前缀（与 parseNormalLine 同一正则 `^\s*>\s?`），
   * 返回前缀层级与剥离后的内容——Setext 判定必须发生在前缀剥离之后
   * （02-解析器正确性.md §2.1 冲突点）。
   */
  private static stripBlockquoteContext(
    line: string
  ): { level: number; content: string } {
    let level = 0;
    let content = line;
    let m: RegExpMatchArray | null;
    while ((m = content.match(/^\s*>\s?/))) {
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
    if (
      (pipeCount >= 1 && content.trim().startsWith('|')) ||
      pipeCount >= 2
    ) {
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
    codeBlockState: CodeState[]
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
    setextLevel: number = 0
  ): LineNode {
    // 缓存键 = codeState + Setext 上下文 + 完整行文本：blockquote 前缀、fence/math 跨行状态、
    // Setext 上下文均已编码在键内（review-02 §7.1：Setext 关系必须进键，禁止回写缓存行），
    // token 偏移为行内相对值（与文档偏移解耦），因此命中节点可直接复用结构。
    const cacheKey = codeState + ':' + setextLevel + ':' + lineText;
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
    while ((bMatch = trimmed.match(/^\s*>\s?/))) {
      blockquoteLevel++;
      trimmed = trimmed.substring(bMatch[0].length);
    }
    const bqLevelVal = blockquoteLevel > 0 ? blockquoteLevel : undefined;

    // Setext 下划线行（预扫描已确认其上一行是段落）：零输出行——复用 'empty' 类型
    // （投影器与渲染器对 'empty' 均为跳过/空行），raw 保留原文供守恒校验与编辑回写。
    if (setextLevel === -1) {
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
    if (codeState === 'indent_code') {
      const node = this.parseCodeLine(lineText, localOffset);
      node.blockquoteLevel = bqLevelVal;
      this.astCache.set(cacheKey, node);
      return node;
    }

    if (codeState === 'code' || codeState === true) {
      const node = this.parseCodeLine(lineText, localOffset);
      node.blockquoteLevel = bqLevelVal;
      this.astCache.set(cacheKey, node);
      return node;
    }

    let node = this.parseNormalLine(lineText, localOffset, setextLevel);

    this.astCache.set(cacheKey, node);
    return node;
  }

  private static parseCodeLine(
    lineText: string,
    localOffset: number
  ): LineNode {
    const tokens: InlineNode[] = [];
    let pos = 0;
    let remainingTextForPrefix = lineText;
    let blockquoteMatch;
    
    while ((blockquoteMatch = remainingTextForPrefix.match(/^\s*>\s?/))) {
      pos += blockquoteMatch[0].length;
      remainingTextForPrefix = remainingTextForPrefix.substring(blockquoteMatch[0].length);
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

    // Simple heuristic tokenizer for code
    const regex =
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(["'`])(?:(?=(\\?))\3.)*?\2|\b(function|const|let|var|if|else|for|while|return|class|import|export|from|yield|await|async|switch|case|break|continue|default|typeof|instanceof|new|delete|try|catch|finally|throw|void|with)\b/g;
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
    setextLevel: number = 0
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
    while ((blockquoteMatch = remainingTextForPrefix.match(/^\s*>\s?/))) {
      blockquoteLevel++;
      pos += blockquoteMatch[0].length;
      remainingTextForPrefix = remainingTextForPrefix.substring(blockquoteMatch[0].length);
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

    // Setext 标题内容行跳过全部块级判定（hr/ATX/表格/列表），直接进入行内解析；
    // 普通行维持原有判定顺序：hr → ATX → 表格 → 列表（02 §2.1 第 3 点）。
    if (!isSetextHeading) {
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
        const headingMatch = nestedText.match(/^(#{1,6})\s+/);
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
          if (nestedText.length <= 10000) {
            const tableSeparatorMatch = nestedText.match(
              /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/
            );
            if (tableSeparatorMatch) {
              lineType = 'table_separator';
            } else {
              const pipeCount = (nestedText.match(/\|/g) || []).length;
              if (
                (pipeCount >= 1 && nestedText.trim().startsWith('|')) ||
                pipeCount >= 2
              ) {
                lineType = 'table_row';
              }
            }
          }

          if (lineType !== 'table_row' && lineType !== 'table_separator') {
              const taskMatch = nestedText.match(/^(\s*)([-*+]\s*\[[xX\s]\])\s+/);
              if (taskMatch) {
                const prefixLen = taskMatch[0].length;
                const indent = taskMatch[1];
                const checkRaw = taskMatch[2];
                const isChecked = checkRaw.includes('x') || checkRaw.includes('X');
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
                    const prefixLen = numberMatch[0].length;
                    const indent = numberMatch[1];
                    listIndent = indent.length;
                    listPrefix = numberMatch[2];
                    tokens.push({
                    type: 'list_number',
                    raw: numberMatch[0],
                    content: numberMatch[2] + ' ',
                    indent: indent,
                    marker: numberMatch[2] + ' ',
                    localOffset: nestedLocalOffset,
                    length: prefixLen,
                  });
                  pos += prefixLen;
                }
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
        true
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
      const parsedTokens = this.parseInlineTokens(remainingText, pos, true);
      tokens.push(...parsedTokens);
    }

    const finalTokens = (lineType === 'table_row' || lineType === 'table_separator')
      ? this.groupTableCells(tokens)
      : tokens;

    return {
      id: this.generateId(),
      type: lineType,
      raw: lineText,
      headingLevel,
      blockquoteLevel: blockquoteLevel > 0 ? blockquoteLevel : undefined,
      listIndent: listPrefix !== undefined ? listIndent : undefined,
      listPrefix: listPrefix ? listPrefix : undefined,
      inlineTokens: finalTokens,
      localOffset,
      length: lineText.length,
    };
  }

  private static groupTableCells(tokens: InlineNode[]): InlineNode[] {
    const result: InlineNode[] = [];
    let currentCellTokens: InlineNode[] = [];
    
    const flushCell = (pipeToken?: InlineNode) => {
      const startOffset = currentCellTokens.length > 0 ? currentCellTokens[0].localOffset : (pipeToken ? pipeToken.localOffset + pipeToken.length : 0);
      const length = currentCellTokens.length > 0 
        ? currentCellTokens[currentCellTokens.length - 1].localOffset + currentCellTokens[currentCellTokens.length - 1].length - startOffset
        : 0;

      result.push({
        type: 'table_cell',
        raw: currentCellTokens.map(t => t.raw).join(''),
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
      const isJustEmptySpace = currentCellTokens.length === 1 && currentCellTokens[0].type === 'text' && currentCellTokens[0].raw.trim() === '';
      if (!isJustEmptySpace) flushCell();
    }

    return result;
  }

  private static INLINE_RULES = [
    {
      type: 'image',
      regex: /^!\[((?:[^\]\\]|\\.){0,2000})\]\(((?:[^)\\]|\\.){0,2000})\)/,
    },
    {
      type: 'link',
      regex: /^\[((?:[^\]\\]|\\.){1,2000})\]\(((?:[^)\\]|\\.){0,2000})\)/,
    },
    { type: 'checkbox', regex: /^\[\s*[xX\s]\s*\]/ },
    { type: 'footnote', regex: /^\[\^([0-9a-zA-Z]{1,100})\]/ },
    { type: 'code', regex: /^(`+)(.*?)\1/ },
    { type: 'bold_italic', start: '***', close: '***' },
    { type: 'bold', start: '**', close: '**' },
    { type: 'italic', start: '*', close: '*' },
    { type: 'strike', start: '~~', close: '~~' },
    { type: 'mark', start: '==', close: '==' },
    { type: 'bold', start: '<b>', close: '</b>' },
    { type: 'bold', start: '<strong>', close: '</strong>' },
    { type: 'italic', start: '<i>', close: '</i>' },
    { type: 'italic', start: '<em>', close: '</em>' },
    { type: 'strike', start: '<s>', close: '</s>' },
    { type: 'strike', start: '<del>', close: '</del>' },
    { type: 'mark', start: '<mark>', close: '</mark>' },
    { type: 'sub', start: '<u>', close: '</u>' },
    { type: 'sub', start: '<ins>', close: '</ins>' },
    { type: 'kbd', start: '<kbd>', close: '</kbd>' },
    { type: 'sub', start: '<sub>', close: '</sub>' },
    { type: 'sup', start: '<sup>', close: '</sup>' },
    { type: 'math', regex: /^\$\$((?:[^\$\\]|\\.){1,2000})\$\$/ },
    {
      type: 'math',
      regex:
        /^\$((?:[^\s\$\\]|\\.)(?:(?:[^\$\\]|\\.){0,2000}?(?:[^\s\$\\]|\\.))?)\$/,
    },
    { type: 'sup', regex: /^\^([^\s^]{1,500})\^/ },
    { type: 'sub', regex: /^~([^\s~]{1,500})~/ },
    { type: 'spoiler', start: '||', close: '||' },
    { type: 'html_tag', regex: /^<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^>]*)?\/?>/ },
    { type: 'table_pipe', regex: /^\|/ },
  ];

  private static parseInlineTokens(
    text: string,
    localOffset: number,
    isTopLevel: boolean = false
  ): InlineNode[] {
    // 每行一次失败记忆：行内所有递归调用共享同一份（跨递归层共享），行与行之间由行缓存隔离。
    const memo: ScanFailureMemo = {
      failedAt: new Set(),
      noClose: new Map(),
    };
    const res = this.scanTokens(text, 0, localOffset, null, 0, memo);
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

  private static scanTokens(
    text: string,
    startIndex: number,
    localOffset: number,
    rule: any | null,
    depth: number,
    memo: ScanFailureMemo
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
          content: currentContentText,
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

        // Prevent unclosed tags like **未闭合 from being parsed as empty * tags
        if (validClose && i === startIndex + start.length) {
          const combined = start + close;
          const formsOtherRule = this.INLINE_RULES.some(
            (r) => r.start === combined
          );
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
        const htmlMatch = /^<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/.exec(sub);
        if (htmlMatch) {
          const tagName = htmlMatch[1].toLowerCase();
          const attrStr = htmlMatch[2];
          const openTag = htmlMatch[0];
          const isSelfClosing =
            openTag.endsWith('/>') ||
            ['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tagName);

          const isSpecialTag = ['u', 'ins', 'sub', 'sup', 'kbd'].includes(
            tagName
          );

          if (!isSelfClosing && !isSpecialTag) {
            // 失败签名键：与 INLINE_RULES 中同名起止规则（如 '<b>'）共用同一键——
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
                .indexOf(closeTag.toLowerCase(), i + openTag.length);
              if (closeIdx !== -1) {
                const { attributes, style } = this.parseHtmlAttributes(attrStr);
                const htmlRule = {
                  type: 'html_element',
                  start: openTag,
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
                  memo
                );
                if (res.ok) {
                  flushText();
                  innerTokens.push({
                    type: 'html_element',
                    raw: text.substring(i, i + res.length),
                    content: text.substring(
                      i + openTag.length,
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
          }
        }
      }

      if (!matched) {
        for (const r of this.INLINE_RULES) {
          if (r.regex) {
            const m = r.regex.exec(sub);
            if (m && m.index === 0) {
              flushText();
              let raw = m[0];
              let content = '';
              let url;
              let isChecked = false;
              let imageAlt = '';

              if (r.type === 'image') {
                imageAlt = m[1];
                url = m[2];
                content = '🖼️ ' + (imageAlt || '图片');
              } else if (r.type === 'link') {
                content = m[1];
                url = m[2];
              } else if (r.type === 'checkbox') {
                isChecked = raw.includes('x') || raw.includes('X');
                content = isChecked ? '☑' : '☐';
              } else if (r.type === 'footnote') {
                content = m[1];
              } else if (r.type === 'code') {
                content = m[2];
              } else if (
                r.type === 'sub' ||
                r.type === 'sup' ||
                r.type === 'math'
              ) {
                content = m[1] !== undefined ? m[1] : raw;
              } else {
                content = raw;
              }

              innerTokens.push({
                type: r.type as InlineNode['type'],
                raw,
                content,
                url,
                isChecked,
                localOffset: localOffset + i,
                length: raw.length,
              });
              i += raw.length;
              matched = true;
              break;
            }
          } else if (r.start && sub.startsWith(r.start)) {
            // EXACT MATCH check for identical characters like '*', '**', '***'
            // We don't want '**' to be parsed as an italic '*' start, leaving one '*' dangling.
            const char = r.start[0];
            const isRepeatingChar = r.start.split('').every((c) => c === char);
            let validStart = true;
            if (isRepeatingChar) {
              let runLen = 0;
              while (i + runLen < text.length && text[i + runLen] === char) {
                runLen++;
              }
              // Only allow match if the run length is EXACTLY the rule length.
              // EXCEPT if the run length is exactly TWICE the rule length (e.g. **** for bold **),
              // AND there is no other rule that exactly matches that run length.
              if (runLen !== r.start.length) {
                if (runLen === r.start.length * 2) {
                  const exactRuleExists = this.INLINE_RULES.some(
                    (r2) =>
                      r2.start &&
                      r2.start.length === runLen &&
                      r2.start[0] === char
                  );
                  if (exactRuleExists) {
                    validStart = false;
                  }
                } else {
                  validStart = false;
                }
              }
            }

            if (validStart) {
              // 失败记忆短路：同位置同规则已确认失败（或位置 i 之后已确认无闭合标记）→ 直接放弃递归。
              // 递归返回值只在「完整扫描后确认失败」时才可记忆（位置级）——
              // 深度剪枝的直接 null 由调用链上层位置承担记忆，绝不允许在此处被当作已确认失败。
              const posKey = r.start + '@' + i;
              const noCloseAt = memo.noClose.get(r.start);
              if (
                !memo.failedAt.has(posKey) &&
                (noCloseAt === undefined || noCloseAt > i)
              ) {
                const res = this.scanTokens(
                  text,
                  i,
                  localOffset,
                  r,
                  depth + 1,
                  memo
                );
                if (res.ok) {
                  // successfully parsed the block
                  flushText();
                  innerTokens.push({
                    type: r.type as InlineNode['type'],
                    raw: text.substring(i, i + res.length),
                    content: text.substring(
                      i + r.start.length,
                      i + res.length - r.close.length
                    ),
                    children: res.tokens,
                    localOffset: localOffset + i,
                    length: res.length,
                  });
                  i += res.length;
                  matched = true;
                  break;
                }
                // 规则失败：位置级记忆（跨递归层共享）——后续同位置尝试直接跳过，
                // 未闭合 HTML 起止标记链（'<b>x' 等）的指数递归树由此坍缩为每位置一次尝试。
                memo.failedAt.add(posKey);
              }
            }
          }
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
