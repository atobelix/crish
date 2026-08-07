const { MarkdownParser } = require('../../src/core/parser.ts');

// test-bq-ci.js: 引用块 + 行内代码 / 嵌套列表的 parse 断言
console.log(JSON.stringify(MarkdownParser.parse("> - item"), null, 2));
console.log(JSON.stringify(MarkdownParser.parse("> `code` in quote"), null, 2));
console.log(JSON.stringify(MarkdownParser.parse("> > nested quote"), null, 2));
