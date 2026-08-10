import { MarkdownParser } from './src/core/parser.js';

const longText = 'a'.repeat(500_000);

let start = performance.now();
const cacheKey = 'false:' + longText;
let end = performance.now();
console.log('Cache key gen:', end - start);

start = performance.now();
const hrMatch = longText.match(/^(\s*[-*+_]){3,}\s*$/);
end = performance.now();
console.log('HR match:', end - start);

start = performance.now();
const pipeCount = (longText.match(/\|/g) || []).length;
end = performance.now();
console.log('Pipe match:', end - start);

start = performance.now();
MarkdownParser.parseLine(longText, 0, false);
end = performance.now();
console.log('parseLine total:', end - start);
