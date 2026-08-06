import type { LineNode, InlineNode, MarkdownDocument } from './ast';

export class MarkdownParser {
    private static escapeHtml(str: string) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    private static idCounter = 0;
    private static generateId(): string {
        return 'line_' + (this.idCounter++).toString(36);
    }

    public static computeLineOffsets(text: string): { offsets: number[]; codeBlockState: boolean[] } {
        const lines = text.split('\n');
        const offsets = new Array(lines.length);
        const codeBlockState = new Array(lines.length);
        
        let currentOffset = 0;
        let inCodeBlock = false;
        
        for (let i = 0; i < lines.length; i++) {
            offsets[i] = currentOffset;
            const trimmed = lines[i].trim();
            
            if (trimmed.startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                codeBlockState[i] = true; // The ``` line itself is code
            } else {
                codeBlockState[i] = inCodeBlock;
            }
            
            currentOffset += lines[i].length + 1; // +1 for \n
        }
        
        return { offsets, codeBlockState };
    }

    public static parseLine(lineText: string, globalStartIndex: number, isCodeBlock: boolean): LineNode {
        if (isCodeBlock) {
            return this.parseCodeLine(lineText, globalStartIndex);
        } else {
            return this.parseNormalLine(lineText, globalStartIndex);
        }
    }

    private static parseCodeLine(lineText: string, globalStartIndex: number): LineNode {
        const tokens: InlineNode[] = [];
        let globalPos = globalStartIndex;
        
        if (lineText.trim().startsWith('```')) {
            tokens.push({ type: 'text', raw: lineText, content: lineText, startIndex: globalPos, length: lineText.length });
        } else {
            const tokenRegex = /(\/\/.+$)|(".*?"|'.*?'|\x60.*?\x60)|\b(function|return|const|let|var|if|else|for|while|import|export)\b/g;
            let pos = 0;
            let match;
            
            while ((match = tokenRegex.exec(lineText)) !== null) {
                const matchIndex = match.index;
                if (matchIndex > pos) {
                    const plain = lineText.substring(pos, matchIndex);
                    tokens.push({ type: 'text', raw: plain, content: plain, startIndex: globalPos + pos, length: plain.length });
                }

                if (match[1]) {
                    tokens.push({ type: 'comment', raw: match[0], content: match[0], startIndex: globalPos + matchIndex, length: match[0].length });
                } else if (match[2]) {
                    tokens.push({ type: 'string', raw: match[0], content: match[0], startIndex: globalPos + matchIndex, length: match[0].length });
                } else if (match[3]) {
                    tokens.push({ type: 'keyword', raw: match[0], content: match[0], startIndex: globalPos + matchIndex, length: match[0].length });
                } else {
                    tokens.push({ type: 'text', raw: match[0], content: match[0], startIndex: globalPos + matchIndex, length: match[0].length });
                }
                
                pos = matchIndex + match[0].length;
            }
            
            if (pos < lineText.length) {
                const plain = lineText.substring(pos);
                tokens.push({ type: 'text', raw: plain, content: plain, startIndex: globalPos + pos, length: plain.length });
            }
        }
        
        if (tokens.length === 0) {
            tokens.push({ type: 'text', raw: lineText || ' ', content: lineText || ' ', startIndex: globalPos, length: (lineText || ' ').length });
        }

        return {
            id: this.generateId(),
            type: 'code',
            raw: lineText,
            inlineTokens: tokens,
            startIndex: globalStartIndex,
            length: lineText.length
        };
    }

    private static parseNormalLine(lineText: string, globalStartIndex: number): LineNode {
        const tokens: InlineNode[] = [];
        let pos = 0;
        let globalPos = globalStartIndex;

        if (!lineText) {
            return {
                id: this.generateId(),
                type: 'empty',
                raw: '',
                inlineTokens: [{ type: 'text', raw: '', content: '', startIndex: globalPos, length: 0 }],
                startIndex: globalPos,
                length: 0
            };
        }

        let lineType: 'heading' | 'body' | 'hr' | 'blockquote' = 'body';
        let headingLevel = 0;

        const hrMatch = lineText.match(/^(\s*[-*+_]){3,}\s*$/);
        if (hrMatch) {
            lineType = 'hr';
            pos = lineText.length;
        } else {
            const blockquoteMatch = lineText.match(/^(>\s?)/);
            if (blockquoteMatch) {
                lineType = 'blockquote';
                pos = blockquoteMatch[0].length;
            } else {
                const headingMatch = lineText.match(/^(#{1,6})\s+/);
                if (headingMatch) {
                    lineType = 'heading';
                    headingLevel = headingMatch[1].length;
                    const prefixLen = headingMatch[0].length;
                    tokens.push({
                        type: 'heading_prefix',
                        raw: headingMatch[0],
                        content: '',
                        startIndex: globalPos,
                        length: prefixLen
                    });
                    pos = prefixLen;
                } else {
                    const taskMatch = lineText.match(/^(\s*)([-*+]\s*\[[xX\s]\])\s+/);
                    if (taskMatch) {
                        const prefixLen = taskMatch[0].length;
                        const indent = taskMatch[1];
                        const checkRaw = taskMatch[2];
                        const isChecked = checkRaw.includes('x') || checkRaw.includes('X');
                        tokens.push({
                            type: 'list_task',
                            raw: taskMatch[0],
                            content: indent + (isChecked ? '☑ ' : '☐ '),
                            isChecked,
                            startIndex: globalPos,
                            length: prefixLen
                        });
                        pos = prefixLen;
                    } else {
                        const bulletMatch = lineText.match(/^(\s*)([-*+])\s+/);
                        if (bulletMatch) {
                            const prefixLen = bulletMatch[0].length;
                            const indent = bulletMatch[1];
                            tokens.push({
                                type: 'list_bullet',
                                raw: bulletMatch[0],
                                content: indent + '• ',
                                startIndex: globalPos,
                                length: prefixLen
                            });
                            pos = prefixLen;
                        } else {
                            const numberMatch = lineText.match(/^(\s*)(\d+\.)\s+/);
                            if (numberMatch) {
                                const prefixLen = numberMatch[0].length;
                                tokens.push({
                                    type: 'list_number',
                                    raw: numberMatch[0],
                                    content: numberMatch[0],
                                    startIndex: globalPos,
                                    length: prefixLen
                                });
                                pos = numberMatch[0].length;
                            }
                        }
                    }
                }
            }
        }

        const parsedTokens = this.parseInlineTokens(lineText.substring(pos), globalPos + pos, true);
        tokens.push(...parsedTokens);
        
        return {
            id: this.generateId(),
            type: lineType,
            raw: lineText,
            headingLevel,
            inlineTokens: tokens,
            startIndex: globalPos,
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
        { type: 'sub', start: '<u>', close: '</u>' },
        { type: 'kbd', start: '<kbd>', close: '</kbd>' },
        { type: 'sub', start: '<sub>', close: '</sub>' },
        { type: 'sup', start: '<sup>', close: '</sup>' },
        { type: 'sub', start: '~', close: '~' },
        { type: 'sup', start: '^', close: '^' },
        { type: 'math', start: '$$', close: '$$' },
        { type: 'math', start: '$', close: '$' },
        { type: 'spoiler', start: '||', close: '||' }
    ];

    private static parseInlineTokens(text: string, globalOffset: number, isTopLevel: boolean = false): InlineNode[] {
        const res = this.scanTokens(text, 0, globalOffset, null);
        
        if (res.tokens.length === 0 && isTopLevel) {
            res.tokens.push({ type: 'text', raw: '', content: '', startIndex: globalOffset, length: 0 });
        }
        
        return res.tokens;
    }

    private static scanTokens(text: string, startIndex: number, globalOffset: number, rule: any | null): { tokens: InlineNode[], length: number } | null {
        const start = rule ? rule.start : '';
        const close = rule ? rule.close : null;
        let i = startIndex + start.length;
        const innerTokens: InlineNode[] = [];
        let currentRawText = '';
        let currentContentText = '';
        
        const flushText = () => {
            if (currentRawText.length > 0) {
                innerTokens.push({ type: 'text', raw: currentRawText, content: currentContentText, startIndex: globalOffset + i - currentRawText.length, length: currentRawText.length });
                currentRawText = '';
                currentContentText = '';
            }
        };

        while (i < text.length) {
            if (text[i] === '\\' && i + 1 < text.length) {
                currentRawText += text.substring(i, i + 2); // keep \x in raw
                currentContentText += text[i+1]; // only x in content
                i += 2;
                continue;
            }

            // Check if we found the exact closing tag
            if (close && text.substring(i, i + close.length) === close) {
                let validClose = true;
                if (close === '*' && text.substring(i, i + 2) === '**') validClose = false;
                if (close === '_' && text.substring(i, i + 2) === '__') validClose = false;
                
                if (validClose) {
                    flushText();
                    return { tokens: innerTokens, length: i + close.length - startIndex };
                }
            }

            // Try rules
            let matched = false;
            const sub = text.substring(i);
            
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
                        } else {
                            content = raw;
                        }

                        innerTokens.push({
                            type: r.type,
                            raw,
                            content,
                            url,
                            isChecked,
                            startIndex: globalOffset + i,
                            length: raw.length
                        });
                        i += raw.length;
                        matched = true;
                        break;
                    }
                } else if (r.start && sub.startsWith(r.start)) {
                    const res = this.scanTokens(text, i, globalOffset, r);
                    if (res) { // successfully parsed the block
                        flushText();
                        innerTokens.push({
                            type: r.type,
                            raw: text.substring(i, i + res.length),
                            content: text.substring(i + r.start.length, i + res.length - r.close.length),
                            children: res.tokens,
                            startIndex: globalOffset + i,
                            length: res.length
                        });
                        i += res.length;
                        matched = true;
                        break;
                    }
                }
            }

            if (!matched) {
                currentRawText += text[i];
                currentContentText += text[i];
                i++;
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
