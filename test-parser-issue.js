require('ts-node').register();
const { MarkdownParser } = require('./reference/markdown-editor/src/core/parser.ts');

const text1 = "mc平方$后面一连串都变成上标了呢。";
const text2 = "H~2~O 没有正常显示。";
const text3 = "E=mc^2$ 看看";

console.log('Text 1:', JSON.stringify(MarkdownParser.parse(text1), null, 2));
console.log('Text 2:', JSON.stringify(MarkdownParser.parse(text2), null, 2));
console.log('Text 3:', JSON.stringify(MarkdownParser.parse(text3), null, 2));
