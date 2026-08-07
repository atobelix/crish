const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'reference/markdown-editor/src/core/parser.ts');
let code = fs.readFileSync(file, 'utf-8');

// 1. Rename startIndex to localOffset in token creations
code = code.replace(/startIndex\s*:\s*globalPos\s*\+\s*([a-zA-Z0-9_]+)/g, 'localOffset: $1');
code = code.replace(/startIndex\s*:\s*globalPos\s*-\s*([a-zA-Z0-9_]+)/g, 'localOffset: -$1'); // just in case
code = code.replace(/startIndex\s*:\s*globalPos/g, 'localOffset: 0');

code = code.replace(/startIndex\s*:\s*globalOffset\s*\+\s*([a-zA-Z0-9_]+)/g, 'localOffset: localOffset + $1');
code = code.replace(/startIndex\s*:\s*localOffset\s*\+\s*([a-zA-Z0-9_]+)/g, 'localOffset: localOffset + $1');
code = code.replace(/startIndex\s*:\s*localOffset\s*-\s*([a-zA-Z0-9_]+)/g, 'localOffset: localOffset - $1');
code = code.replace(/startIndex\s*:\s*localOffset/g, 'localOffset: localOffset');
// Specially handle the one with math: localOffset + i - currentRawText.length
code = code.replace(/startIndex:\s*localOffset\s*\+\s*i\s*-\s*currentRawText\.length/g, 'localOffset: localOffset + i - currentRawText.length');

// Remove startIndex from LineNode creation
code = code.replace(/startIndex:\s*globalStartIndex,?\s*\n/g, '');
code = code.replace(/startIndex:\s*globalPos,?\s*\n/g, '');


// 2. Fix function signatures
code = code.replace(
    /public static parseLine\(lineText: string, globalStartIndex: number, isCodeBlock: boolean\): LineNode {/g,
    `private static astCache = new Map<string, LineNode>();\n\n    public static parseLine(lineText: string, isCodeBlock: boolean): LineNode {\n        const cacheKey = (isCodeBlock ? 'C:' : 'N:') + lineText;\n        const cached = this.astCache.get(cacheKey);\n        if (cached) return cached;\n\n        let node: LineNode;\n        if (isCodeBlock) {\n            node = this.parseCodeLine(lineText);\n        } else {\n            node = this.parseNormalLine(lineText);\n        }\n\n        if (this.astCache.size > 20000) {\n            const keys = Array.from(this.astCache.keys()).slice(0, 10000);\n            for (const k of keys) this.astCache.delete(k);\n        }\n        this.astCache.set(cacheKey, node);\n        return node;\n    }\n\n    private static _old_parseLine(lineText: string, globalStartIndex: number, isCodeBlock: boolean): LineNode {`
);

// We don't need _old_parseLine, so I'll just replace correctly
code = code.replace(/private static _old_parseLine[\s\S]*?(?=private static parseCodeLine)/, '');

code = code.replace(/private static parseCodeLine\(lineText: string, globalStartIndex: number\): LineNode {/g, 'private static parseCodeLine(lineText: string): LineNode {');
code = code.replace(/private static parseNormalLine\(lineText: string, globalStartIndex: number\): LineNode {/g, 'private static parseNormalLine(lineText: string): LineNode {');
code = code.replace(/private static parseInlineTokens\(text: string, globalOffset: number, isTopLevel: boolean = false\): InlineNode\[\] {/g, 'private static parseInlineTokens(text: string, localOffset: number, isTopLevel: boolean = false): InlineNode[] {');
code = code.replace(/private static scanTokens\(text: string, startIndex: number, globalOffset: number, rule: any \| null\): \{ tokens: InlineNode\[\], length: number \} \| null {/g, 'private static scanTokens(text: string, startIndex: number, localOffset: number, rule: any | null): { tokens: InlineNode[], length: number } | null {');

// Fix globalPos initialization
code = code.replace(/let globalPos = globalStartIndex;/g, '');

// Fix parseInlineTokens call
code = code.replace(/this\.parseInlineTokens\(lineText\.substring\(pos\), globalPos \+ pos, true\)/g, 'this.parseInlineTokens(lineText.substring(pos), pos, true)');

// FIX ALL OTHER globalOffsets
code = code.replace(/globalOffset/g, 'localOffset');

fs.writeFileSync(file, code);
console.log("Done");
