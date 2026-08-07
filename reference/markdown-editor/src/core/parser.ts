import type { LineNode, InlineNode, MarkdownDocument } from './ast';

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
            lines: lineNodes
        };
    }

    public static computeLineOffsets(text: string): { offsets: number[]; codeBlockState: ('none' | 'fence_start' | 'code' | 'fence_end' | 'math_fence_start' | 'math_fence_end' | 'math_block')[] } {
        const lines = text.split('\n');
        const offsets = new Array(lines.length);
        const codeBlockState: ('none' | 'fence_start' | 'code' | 'fence_end' | 'math_fence_start' | 'math_fence_end' | 'math_block')[] = new Array(lines.length);
        
        let currentOffset = 0;
        let inCodeBlock = false;
        let inMathBlock = false;
        
        for (let i = 0; i < lines.length; i++) {
            offsets[i] = currentOffset;
            const trimmed = lines[i].trim();
            
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

    private static astCache = new Map<string, LineNode>();
    public static cacheHits = 0;
    public static cacheMisses = 0;
    
    public static getCacheStats() {
        return { hits: this.cacheHits, misses: this.cacheMisses, size: this.astCache.size };
    }

    
    public static parseLine(lineText: string, codeState: 'none' | 'fence_start' | 'code' | 'fence_end' | 'math_fence_start' | 'math_fence_end' | 'math_block' | boolean): LineNode {
        const cacheKey = codeState + ':' + lineText;
        const cached = this.astCache.get(cacheKey);
        if (cached) {
            this.cacheHits++;
            return cached;
        }
        this.cacheMisses++;

        let node: LineNode;
        if (codeState === 'fence_start') {
            node = {
                id: this.generateId(),
                type: 'code_fence_start',
                raw: lineText,
                content: lineText,
                inlineTokens: [{ type: 'text', raw: lineText, content: lineText, localOffset: 0, length: lineText.length }],
                lineType: 'code'
            };
        } else if (codeState === 'code' || codeState === true) {
            node = this.parseCodeLine(lineText);
        } else if (codeState === 'fence_end') {
            node = {
                id: this.generateId(),
                type: 'code_fence_end',
                raw: lineText,
                content: lineText,
                inlineTokens: [{ type: 'text', raw: lineText, content: lineText, localOffset: 0, length: lineText.length }],
                lineType: 'code'
            };
        } else if (codeState === 'math_fence_start') {
            node = {
                id: this.generateId(),
                type: 'math_fence_start',
                raw: lineText,
                content: lineText,
                inlineTokens: [{ type: 'text', raw: lineText, content: lineText, localOffset: 0, length: lineText.length }],
                lineType: 'body'
            };
        } else if (codeState === 'math_block') {
            node = {
                id: this.generateId(),
                type: 'math_block',
                raw: lineText,
                content: lineText,
                inlineTokens: [{ type: 'text', raw: lineText, content: lineText, localOffset: 0, length: lineText.length }],
                lineType: 'body'
            };
        } else if (codeState === 'math_fence_end') {
            node = {
                id: this.generateId(),
                type: 'math_fence_end',
                raw: lineText,
                content: lineText,
                inlineTokens: [{ type: 'text', raw: lineText, content: lineText, localOffset: 0, length: lineText.length }],
                lineType: 'body'
            };
        } else {
            node = this.parseNormalLine(lineText);
        }

        if (this.astCache.size > 20000) {
            const keys = Array.from(this.astCache.keys()).slice(0, 5000);
            for (const k of keys) this.astCache.delete(k);
        }
        this.astCache.set(cacheKey, node);
        return node;
    }

    private static parseCodeLine(lineText: string): LineNode {
        const tokens: InlineNode[] = [];
        
        
        const tokenRegex = /(\/\/.+$)|(".*?"|'.*?'|\x60.*?\x60)|\b(function|return|const|let|var|if|else|for|while|import|export)\b/g;
        let pos = 0;
        let match;
        
        while ((match = tokenRegex.exec(lineText)) !== null) {
            const matchIndex = match.index;
            if (matchIndex > pos) {
                const plain = lineText.substring(pos, matchIndex);
                tokens.push({ type: 'text', raw: plain, content: plain, localOffset: pos, length: plain.length });
            }

            if (match[1]) {
                tokens.push({ type: 'comment', raw: match[0], content: match[0], localOffset: matchIndex, length: match[0].length });
            } else if (match[2]) {
                tokens.push({ type: 'string', raw: match[0], content: match[0], localOffset: matchIndex, length: match[0].length });
            } else if (match[3]) {
                tokens.push({ type: 'keyword', raw: match[0], content: match[0], localOffset: matchIndex, length: match[0].length });
            } else {
                tokens.push({ type: 'text', raw: match[0], content: match[0], localOffset: matchIndex, length: match[0].length });
            }
            
            pos = matchIndex + match[0].length;
        }
        
        if (pos < lineText.length) {
            const plain = lineText.substring(pos);
            tokens.push({ type: 'text', raw: plain, content: plain, localOffset: pos, length: plain.length });
        }
        
        if (tokens.length === 0) {
            tokens.push({ type: 'text', raw: lineText || ' ', content: lineText || ' ', localOffset: 0, length: (lineText || ' ').length });
        }

        return {
            id: this.generateId(),
            type: 'code',
            raw: lineText,
            inlineTokens: tokens,
                        length: lineText.length
        };
    }

    private static parseNormalLine(lineText: string): LineNode {
        const tokens: InlineNode[] = [];
        let pos = 0;
        

        if (!lineText) {
            return {
                id: this.generateId(),
                type: 'empty',
                raw: '',
                inlineTokens: [{ type: 'text', raw: '', content: '', localOffset: 0, length: 0 }],
                localOffset: 0,
                length: 0
            };
        }

        let lineType: 'heading' | 'body' | 'hr' | 'blockquote' | 'table_row' | 'table_separator' = 'body';
        let headingLevel = 0;
        let listIndent = 0;
        let listPrefix = '';

        const hrMatch = lineText.match(/^(\s*[-*+_]){3,}\s*$/);
        if (hrMatch) {
            lineType = 'hr';
            pos = lineText.length;
        } else {
            const blockquoteMatch = lineText.match(/^(>\s?)+/);
            if (blockquoteMatch) {
                lineType = 'blockquote';
                pos = blockquoteMatch[0].length;
            }
            
            // Now parse block prefixes on the remaining text (either full line or inside blockquote)
            const nestedText = lineText.slice(pos);
            const nestedLocalOffset = pos;
            
            const headingMatch = nestedText.match(/^(#{1,6})\s+/);
            if (headingMatch) {
                if (lineType !== 'blockquote') lineType = 'heading';
                headingLevel = headingMatch[1].length;
                const prefixLen = headingMatch[0].length;
                tokens.push({
                    type: 'heading_prefix',
                    raw: headingMatch[0],
                    content: '',
                    localOffset: nestedLocalOffset,
                    length: prefixLen
                });
                pos += prefixLen;
            } else {
                const tableSeparatorMatch = nestedText.match(/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/);
                if (tableSeparatorMatch) {
                    if (lineType !== 'blockquote') lineType = 'table_separator';
                } else {
                    const pipeCount = (nestedText.match(/\|/g) || []).length;
                    if ((pipeCount >= 1 && nestedText.trim().startsWith('|')) || pipeCount >= 2) {
                        if (lineType !== 'blockquote') lineType = 'table_row';
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
                            content: indent + (isChecked ? '☑' : '☐'),
                            isChecked,
                            localOffset: nestedLocalOffset,
                            length: prefixLen
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
                                content: indent + '•',
                                localOffset: nestedLocalOffset,
                                length: prefixLen
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
                                    content: indent + numberMatch[2] + ' ',
                                    localOffset: nestedLocalOffset,
                                    length: prefixLen
                                });
                                pos += prefixLen;
                            }
                        }
                    }
                }
            }
        }

        const parsedTokens = this.parseInlineTokens(lineText.substring(pos), pos, true);
        tokens.push(...parsedTokens);
        
        return {
            id: this.generateId(),
            type: lineType,
            raw: lineText,
            headingLevel,
            listIndent: listPrefix !== undefined ? listIndent : undefined,
            listPrefix: listPrefix ? listPrefix : undefined,
            inlineTokens: tokens,
            localOffset: 0,
            length: lineText.length
        };
    }

    private static INLINE_RULES = [
        { type: 'image', regex: /^!\[((?:[^\]\\]|\\.)*)\]\(((?:[^)\\]|\\.)*)\)/ },
        { type: 'link', regex: /^\[((?:[^\]\\]|\\.)+)\]\(((?:[^)\\]|\\.)*)\)/ },
        { type: 'checkbox', regex: /^\[\s*[xX\s]\s*\]/ },
        { type: 'footnote', regex: /^\[\^([0-9a-zA-Z]+)\]/ },
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
        { type: 'math', regex: /^\$\$((?:[^\$\\]|\\.)+)\$\$/ },
        { type: 'math', regex: /^\$((?:[^\s\$\\]|\\.)(?:(?:[^\$\\]|\\.)*?(?:[^\s\$\\]|\\.))?)\$/ },
        { type: 'sup', regex: /^\^([^\s^]+)\^/ },
        { type: 'sub', regex: /^~([^\s~]+)~/ },
        { type: 'spoiler', start: '||', close: '||' },
        { type: 'html_tag', regex: /^<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^>]*)?\/?>/ }
    ];

    private static parseInlineTokens(text: string, localOffset: number, isTopLevel: boolean = false): InlineNode[] {
        const res = this.scanTokens(text, 0, localOffset, null, 0);
        if (!res) {
            return isTopLevel ? [{ type: 'text', raw: '', content: '', localOffset: localOffset, length: 0 }] : [];
        }
        if (res.tokens.length === 0 && isTopLevel) {
            res.tokens.push({ type: 'text', raw: '', content: '', localOffset: localOffset, length: 0 });
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

    public static parseHtmlAttributes(attrStr: string): { attributes: Record<string, string>; style: React.CSSProperties } {
        const attributes: Record<string, string> = {};
        let style: React.CSSProperties = {};
        if (!attrStr) return { attributes, style };

        const attrRegex = /([a-zA-Z0-9_\-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
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

    private static scanTokens(text: string, startIndex: number, localOffset: number, rule: any | null, depth: number): { tokens: InlineNode[], length: number } | null {
        if (depth > 20) return null; // Bailout heuristic to prevent O(N^2) / O(2^N) nesting bomb
        
        const start = rule ? rule.start : '';
        const close = rule ? rule.close : null;
        let i = startIndex + start.length;
        const innerTokens: InlineNode[] = [];
        let currentRawText = '';
        let currentContentText = '';
        
        const flushText = () => {
            if (currentRawText.length > 0) {
                innerTokens.push({ type: 'text', raw: currentRawText, content: currentContentText, localOffset: localOffset + i - currentRawText.length, length: currentRawText.length });
                currentRawText = '';
                currentContentText = '';
            }
        };

        const isMathContext = rule && rule.type === 'math';
        const isCodeContext = rule && rule.type === 'code';
        const isAtomicContext = isMathContext || isCodeContext;
        const ESCAPABLE_PUNCTUATION = new Set(['!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~']);

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
            const isMatchClose = close && (close.startsWith('</') ? subClose.toLowerCase() === close.toLowerCase() : subClose === close);
            if (isMatchClose) {
                let validClose = true;
                if (close === '*' && text.substring(i, i + 2) === '**') validClose = false;
                if (close === '_' && text.substring(i, i + 2) === '__') validClose = false;
                if (close === '$' && text.substring(i, i + 2) === '$$') validClose = false;
                
                // Prevent unclosed tags like **未闭合 from being parsed as empty * tags
                if (validClose && i === startIndex + start.length) {
                    const combined = start + close;
                    const formsOtherRule = this.INLINE_RULES.some(r => r.start === combined);
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
            const sub = text.substring(i);

            // Check for HTML open tag with possible closing tag on the line
            if (sub.startsWith('<')) {
                const htmlMatch = /^<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/.exec(sub);
                if (htmlMatch) {
                    const tagName = htmlMatch[1].toLowerCase();
                    const attrStr = htmlMatch[2];
                    const openTag = htmlMatch[0];
                    const isSelfClosing = openTag.endsWith('/>') || ['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tagName);
                    
                    if (!isSelfClosing) {
                        const closeTag = `</${tagName}>`;
                        const closeIdx = text.toLowerCase().indexOf(closeTag.toLowerCase(), i + openTag.length);
                        if (closeIdx !== -1) {
                            const { attributes, style } = this.parseHtmlAttributes(attrStr);
                            const htmlRule = {
                                type: 'html_element',
                                start: openTag,
                                close: closeTag,
                                tagName,
                                attributes,
                                style
                            };
                            const res = this.scanTokens(text, i, localOffset, htmlRule, depth + 1);
                            if (res) {
                                flushText();
                                innerTokens.push({
                                    type: 'html_element',
                                    raw: text.substring(i, i + res.length),
                                    content: text.substring(i + openTag.length, i + res.length - closeTag.length),
                                    children: res.tokens,
                                    localOffset: localOffset + i,
                                    length: res.length,
                                    tagName,
                                    attributes,
                                    style
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
                        } else if (r.type === 'sub' || r.type === 'sup' || r.type === 'math') {
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
                            length: raw.length
                        });
                        i += raw.length;
                        matched = true;
                        break;
                    }
                } else if (r.start && sub.startsWith(r.start)) {
                    // EXACT MATCH check for identical characters like '*', '**', '***'
                    // We don't want '**' to be parsed as an italic '*' start, leaving one '*' dangling.
                    const char = r.start[0];
                    const isRepeatingChar = r.start.split('').every(c => c === char);
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
                                const exactRuleExists = this.INLINE_RULES.some(r2 => r2.start && r2.start.length === runLen && r2.start[0] === char);
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
                        if (res) { // successfully parsed the block
                            flushText();
                            innerTokens.push({
                                type: r.type as InlineNode['type'],
                                raw: text.substring(i, i + res.length),
                                content: text.substring(i + r.start.length, i + res.length - r.close.length),
                                children: res.tokens,
                                localOffset: localOffset + i,
                                length: res.length
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
