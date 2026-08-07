const fs = require('fs');

const INLINE_RULES = [
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
    { type: 'sub', start: '~', close: '~' },
    { type: 'sup', start: '^', close: '^' },
    { type: 'math', start: '$$', close: '$$' },
    { type: 'math', start: '$', close: '$' },
    { type: 'spoiler', start: '||', close: '||' },
    { type: 'html_tag', regex: /^<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^>]*)?\/?>/ }
];

function scanTokens(text, startIndex, globalOffset, rule) {
    const start = rule ? rule.start : '';
    const close = rule ? rule.close : null;
    let i = startIndex + start.length;
    const innerTokens = [];
    let currentRawText = '';
    let currentContentText = '';
    
    const flushText = () => {
        if (currentRawText.length > 0) {
            innerTokens.push({ type: 'text', raw: currentRawText, content: currentContentText, startIndex: globalOffset + i - currentRawText.length, length: currentRawText.length });
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
                const formsOtherRule = INLINE_RULES.some(r => r.start === combined);
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

        // Check for HTML open tag
        if (sub.startsWith('<')) {
            const htmlMatch = /^<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/.exec(sub);
            if (htmlMatch && !htmlMatch[0].endsWith('/>')) {
                const tagName = htmlMatch[1];
                const closeTag = `</${tagName}>`;
                const customRule = {
                    type: 'html_element',
                    start: htmlMatch[0],
                    close: closeTag,
                    tagName
                };
                const res = scanTokens(text, i, globalOffset, customRule);
                if (res) {
                    flushText();
                    innerTokens.push({
                        type: 'html_element',
                        raw: text.substring(i, i + res.length),
                        content: text.substring(i + htmlMatch[0].length, i + res.length - closeTag.length),
                        children: res.tokens,
                        startIndex: globalOffset + i,
                        length: res.length,
                        tagName
                    });
                    i += res.length;
                    matched = true;
                }
            }
        }

        if (!matched) {
            for (const r of INLINE_RULES) {
                if (r.regex) {
                    const m = r.regex.exec(sub);
                    if (m && m.index === 0) {
                        flushText();
                        let raw = m[0];
                        let content = raw;
                        innerTokens.push({
                            type: r.type,
                            raw,
                            content,
                            startIndex: globalOffset + i,
                            length: raw.length
                        });
                        i += raw.length;
                        matched = true;
                        break;
                    }
                } else if (r.start && sub.startsWith(r.start)) {
                    const char = r.start[0];
                    const isRepeatingChar = r.start.split('').every(c => c === char);
                    let validStart = true;
                    if (isRepeatingChar) {
                        let runLen = 0;
                        while (i + runLen < text.length && text[i + runLen] === char) {
                            runLen++;
                        }
                        if (runLen !== r.start.length) {
                            if (runLen === r.start.length * 2) {
                                const exactRuleExists = INLINE_RULES.some(r2 => r2.start && r2.start.length === runLen && r2.start[0] === char);
                                if (exactRuleExists) {
                                    validStart = false;
                                }
                            } else {
                                validStart = false;
                            }
                        }
                    }

                    if (validStart) {
                        const res = scanTokens(text, i, globalOffset, r);
                        if (res) {
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
            }
        }

        if (!matched) {
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
    if (close) return null;
    return { tokens: innerTokens, length: i - startIndex };
}

console.log('Text 1:', JSON.stringify(scanTokens("mc平方$后面一连串都变成上标了呢。", 0, 0, null), null, 2));
console.log('Text 2:', JSON.stringify(scanTokens("H~2~O 没有正常显示。", 0, 0, null), null, 2));
console.log('Text 4:', JSON.stringify(scanTokens("H<sub>2</sub>O", 0, 0, null), null, 2));
console.log('Text 5:', JSON.stringify(scanTokens("质能等价公式 $E = mc^2$，复数解", 0, 0, null), null, 2));
console.log('Text 6:', JSON.stringify(scanTokens("mc^2$后面一连串都变成上标了呢。", 0, 0, null), null, 2));
console.log('Text 7:', JSON.stringify(scanTokens("$E=mc^2$ 看看", 0, 0, null), null, 2));
console.log('Text 8:', JSON.stringify(scanTokens("数学公式: 质能等价公式 $E = mc^2$，复数解析 $e^{i\\pi} + 1 = 0$。", 0, 0, null), null, 2));
console.log('Text 9:', JSON.stringify(scanTokens("数学公式: 质能等价公式 $E = mc^2 $，复数解析 $e^{i\\pi} + 1 = 0$。", 0, 0, null), null, 2));
