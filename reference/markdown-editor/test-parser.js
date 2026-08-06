"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarkdownParser = void 0;
class MarkdownParser {
    static escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    static idCounter = 0;
    static generateId() {
        return 'line_' + (this.idCounter++).toString(36);
    }
    static parse(text) {
        this.idCounter = 0;
        const rawLines = text.split('\n');
        const lines = [];
        let inCodeBlock = false;
        for (let i = 0; i < rawLines.length; i++) {
            const lineText = rawLines[i];
            const trimmed = lineText.trim();
            if (trimmed.startsWith('```')) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    lines.push(this.parseCodeLine(lineText));
                }
                else {
                    lines.push(this.parseCodeLine(lineText));
                    inCodeBlock = false;
                }
            }
            else if (inCodeBlock) {
                lines.push(this.parseCodeLine(lineText));
            }
            else {
                lines.push(this.parseNormalLine(lineText));
            }
        }
        return { lines };
    }
    static parseCodeLine(lineText) {
        const tokens = [];
        if (lineText.trim().startsWith('```')) {
            tokens.push({ type: 'text', raw: lineText, content: lineText });
        }
        else {
            // Highlight
            const tokenRegex = /(\/\/.+$)|(".*?"|'.*?'|\x60.*?\x60)|\b(function|return|const|let|var|if|else|for|while|import|export)\b/g;
            let pos = 0;
            let match;
            while ((match = tokenRegex.exec(lineText)) !== null) {
                const matchIndex = match.index;
                if (matchIndex > pos) {
                    const plain = lineText.substring(pos, matchIndex);
                    tokens.push({ type: 'text', raw: plain, content: plain });
                }
                if (match[1]) {
                    tokens.push({ type: 'comment', raw: match[0], content: match[0] });
                }
                else if (match[2]) {
                    tokens.push({ type: 'string', raw: match[0], content: match[0] });
                }
                else if (match[3]) {
                    tokens.push({ type: 'keyword', raw: match[0], content: match[0] });
                }
                else {
                    tokens.push({ type: 'text', raw: match[0], content: match[0] });
                }
                pos = matchIndex + match[0].length;
            }
            if (pos < lineText.length) {
                const plain = lineText.substring(pos);
                tokens.push({ type: 'text', raw: plain, content: plain });
            }
        }
        return {
            id: this.generateId(),
            type: 'code',
            raw: lineText,
            inlineTokens: tokens.length ? tokens : [{ type: 'text', raw: lineText || ' ', content: lineText || ' ' }]
        };
    }
    static parseNormalLine(lineText) {
        const tokens = [];
        let pos = 0;
        if (!lineText) {
            return {
                id: this.generateId(),
                type: 'empty',
                raw: '',
                inlineTokens: [{ type: 'text', raw: '', content: '' }]
            };
        }
        let headingLevel = 0;
        const headingMatch = lineText.match(/^(#{1,6})\s+/);
        if (headingMatch) {
            headingLevel = headingMatch[1].length;
            const prefixLen = headingMatch[0].length;
            tokens.push({
                type: 'heading_prefix',
                raw: headingMatch[0],
                content: ''
            });
            pos = prefixLen;
        }
        else {
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
                    isChecked
                });
                pos = prefixLen;
            }
            else {
                const bulletMatch = lineText.match(/^(\s*)([-*+])\s+/);
                if (bulletMatch) {
                    const prefixLen = bulletMatch[0].length;
                    const indent = bulletMatch[1];
                    tokens.push({
                        type: 'list_bullet',
                        raw: bulletMatch[0],
                        content: indent + '• '
                    });
                    pos = prefixLen;
                }
                else {
                    const numberMatch = lineText.match(/^(\s*)(\d+\.)\s+/);
                    if (numberMatch) {
                        const prefixLen = numberMatch[0].length;
                        tokens.push({
                            type: 'list_number',
                            raw: numberMatch[0],
                            content: numberMatch[0]
                        });
                        pos = prefixLen;
                    }
                }
            }
        }
        const inlineRegex = /(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|((?<!\*)\*[^*]+\*(?!\*))|(~~[^~]+~~)|(={2,4}[^=]+={2,4})|(<u>[^<]+<\/u>)|(<kbd>[^<]+<\/kbd>)|(<sub>[^<]+<\/sub>|~[^~]+~)|(<sup>[^<]+<\/sup>|\^[^\^]+\^)|(\$[^$]+\$)|(\|\|[^|]+\|\|)|(\[\s*[xX\s]\s*\])|(\[\^[0-9a-zA-Z]+\])/g;
        inlineRegex.lastIndex = pos;
        let match;
        while ((match = inlineRegex.exec(lineText)) !== null) {
            const matchIndex = match.index;
            if (matchIndex > pos) {
                const plain = lineText.substring(pos, matchIndex);
                tokens.push({ type: 'text', raw: plain, content: plain });
            }
            const rawToken = match[0];
            if (rawToken.startsWith('![')) {
                const imgTextMatch = rawToken.match(/^!\[([^\]]*)\]/);
                tokens.push({ type: 'image', raw: rawToken, content: '🖼️ ' + (imgTextMatch ? imgTextMatch[1] : '图片'), url: rawToken.match(/\(([^)]+)\)/)?.[1] });
            }
            else if (rawToken.startsWith('<kbd>')) {
                tokens.push({ type: 'kbd', raw: rawToken, content: rawToken.replace(/^<kbd>|<\/kbd>$/g, '') });
            }
            else if (rawToken.startsWith('<u>')) {
                tokens.push({ type: 'sub', raw: rawToken, content: rawToken.replace(/^<u>|<\/u>$/g, '') });
            }
            else if (rawToken.startsWith('[')) {
                if (rawToken.startsWith('[^')) {
                    tokens.push({ type: 'footnote', raw: rawToken, content: rawToken.replace(/^\[\^|\]$/g, '') });
                }
                else if (rawToken.match(/^\[\s*[xX\s]\s*\]/)) {
                    const isChecked = rawToken.includes('x') || rawToken.includes('X');
                    tokens.push({ type: 'checkbox', raw: rawToken, content: isChecked ? '☑' : '☐', isChecked });
                }
                else {
                    const linkMatch = rawToken.match(/^\[([^\]]+)\]\(([^)]+)\)/);
                    tokens.push({ type: 'link', raw: rawToken, content: linkMatch ? linkMatch[1] : rawToken, url: linkMatch ? linkMatch[2] : '#' });
                }
            }
            else if (rawToken.startsWith('`')) {
                tokens.push({ type: 'code', raw: rawToken, content: rawToken.slice(1, -1) });
            }
            else if (rawToken.startsWith('***')) {
                tokens.push({ type: 'bold_italic', raw: rawToken, content: rawToken.slice(3, -3) });
            }
            else if (rawToken.startsWith('**')) {
                tokens.push({ type: 'bold', raw: rawToken, content: rawToken.slice(2, -2) });
            }
            else if (rawToken.startsWith('*')) {
                tokens.push({ type: 'italic', raw: rawToken, content: rawToken.slice(1, -1) });
            }
            else if (rawToken.startsWith('~~')) {
                tokens.push({ type: 'strike', raw: rawToken, content: rawToken.slice(2, -2) });
            }
            else if (rawToken.startsWith('==')) {
                tokens.push({ type: 'mark', raw: rawToken, content: rawToken.replace(/^=+|=+$/g, '') });
            }
            else if (rawToken.startsWith('<sub>') || (rawToken.startsWith('~') && rawToken.endsWith('~'))) {
                tokens.push({ type: 'sub', raw: rawToken, content: rawToken.replace(/^<sub>|^~|<\/sub>$|~$/g, '') });
            }
            else if (rawToken.startsWith('<sup>') || (rawToken.startsWith('^') && rawToken.endsWith('^'))) {
                tokens.push({ type: 'sup', raw: rawToken, content: rawToken.replace(/^<sup>|^\^|<\/sup>$|\^$/g, '') });
            }
            else if (rawToken.startsWith('$')) {
                tokens.push({ type: 'math', raw: rawToken, content: rawToken.replace(/^\$|\$$/g, '') });
            }
            else if (rawToken.startsWith('||')) {
                tokens.push({ type: 'spoiler', raw: rawToken, content: rawToken.slice(2, -2) });
            }
            pos = matchIndex + rawToken.length;
        }
        if (pos < lineText.length) {
            const plain = lineText.substring(pos);
            tokens.push({ type: 'text', raw: plain, content: plain });
        }
        if (tokens.length === 0) {
            tokens.push({ type: 'text', raw: '', content: '' });
        }
        return {
            id: this.generateId(),
            type: headingLevel > 0 ? 'heading' : 'body',
            raw: lineText,
            headingLevel,
            inlineTokens: tokens
        };
    }
}
exports.MarkdownParser = MarkdownParser;
