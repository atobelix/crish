import type { LineNode, InlineNode, MarkdownDocument } from './ast';
import { LRUCache } from './LRUCache';

export type CodeState =
  | 'none'
  | 'fence_start'
  | 'code'
  | 'fence_end'
  | 'math_fence_start'
  | 'math_fence_end'
  | 'math_block';

export class MarkdownParser {
  private static idCounter = 0;
  private static generateId(): string {
    return 'line_' + (this.idCounter++).toString(36);
  }

  public static parse(text: string): MarkdownDocument {
    const { offsets, codeBlockState } = this.computeLineOffsets(text);
    const lines = text.split('\n');
    const lineNodes: LineNode[] = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      lineNodes[i] = this.parseLine(lines[i], offsets[i], codeBlockState[i]);
    }
    return {
      lines: lineNodes,
    };
  }

  public static computeLineOffsets(text: string): {
    offsets: number[];
    codeBlockState: CodeState[];
  } {
    const lines = text.split('\n');
    const offsets = new Array(lines.length);
    const codeBlockState: CodeState[] = new Array(lines.length);

    let currentOffset = 0;
    let inCodeBlock = false;
    let inMathBlock = false;

    for (let i = 0; i < lines.length; i++) {
      offsets[i] = currentOffset;
      let trimmed = lines[i];
      let bMatch;
      let blockquoteLevel = 0;
      while ((bMatch = trimmed.match(/^\s*>\s?/))) {
        blockquoteLevel++;
        trimmed = trimmed.substring(bMatch[0].length);
      }
      trimmed = trimmed.trim();

      if (!inMathBlock && trimmed.startsWith('```')) {
        if (!inCodeBlock) {
          codeBlockState[i] = 'fence_start';
          inCodeBlock = true;
        } else {
          codeBlockState[i] = 'fence_end';
          inCodeBlock = false;
        }
      } else if (!inCodeBlock && trimmed === '$$') {
        if (!inMathBlock) {
          codeBlockState[i] = 'math_fence_start';
          inMathBlock = true;
        } else {
          codeBlockState[i] = 'math_fence_end';
          inMathBlock = false;
        }
      } else {
        if (inCodeBlock) {
          codeBlockState[i] = 'code';
        } else if (inMathBlock) {
          codeBlockState[i] = 'math_block';
        } else {
          codeBlockState[i] = 'none';
        }
      }

      currentOffset += lines[i].length + 1; // +1 for \n
    }

    return { offsets, codeBlockState };
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

  private static shiftInlineOffsets(
    tokens: InlineNode[],
    diff: number
  ): InlineNode[] {
    if (diff === 0) return tokens;
    return tokens.map((t) => ({
      ...t,
      localOffset: t.localOffset + diff,
      children: t.children
        ? this.shiftInlineOffsets(t.children, diff)
        : undefined,
    }));
  }

  public static parseLine(
    lineText: string,
    localOffset: number,
    codeState: CodeState | boolean
  ): LineNode {
    const cacheKey = codeState + ':' + lineText;
    const cached = this.astCache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      return {
        ...cached,
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

    if (codeState === 'code' || codeState === true) {
      const node = this.parseCodeLine(lineText, localOffset);
      node.blockquoteLevel = bqLevelVal;
      this.astCache.set(cacheKey, node);
      return node;
    }

    let node = this.parseNormalLine(lineText, localOffset);

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
      tokens.push({
        type: 'text',
        raw: lineText || ' ',
        content: lineText || ' ',
        localOffset: 0,
        length: (lineText || ' ').length,
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
    localOffset: number
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

    let isHr = false;
    const nestedText = lineText.slice(pos);
    const nestedLocalOffset = pos;

    if (nestedText.length <= 10000) {
      const hrMatch = nestedText.match(/^(\s*[-*+_]){3,}\s*$/);
      if (hrMatch) {
        lineType = 'hr';
        pos += nestedText.length;
        isHr = true;
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
    const res = this.scanTokens(text, 0, localOffset, null, 0);
    if (!res) {
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
    depth: number
  ): { tokens: InlineNode[]; length: number } | null {
    if (depth > 20) return null; // Bailout heuristic to prevent O(N^2) / O(2^N) nesting bomb

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
          return { tokens: innerTokens, length: i + close.length - startIndex };
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
                depth + 1
              );
              if (res) {
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
              const res = this.scanTokens(text, i, localOffset, r, depth + 1);
              if (res) {
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
      return null;
    }

    return { tokens: innerTokens, length: i - startIndex };
  }
}

if (typeof window !== 'undefined') {
  (window as any).MarkdownParser = MarkdownParser;
}
