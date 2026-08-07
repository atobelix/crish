const { MarkdownParser } = require('../../src/core/parser.ts');

console.log(JSON.stringify(MarkdownParser.parse("> - item"), null, 2));
