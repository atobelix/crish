const { MarkdownParser } = require('../../src/core/parser.ts');

const cases = [
    "- item",
    "* item",
    "+ item",
    "  - nested",
    "-   item with spaces",
    "-",
    "- ",
    " - ",
    "*bold*",
    "**bold**",
    "***bold italic***",
    "- *bold in list*",
    " - *bold in nested list*",
    "- [ ] task",
    "- [x] task",
];
for (const text of cases) {
    console.log(`\n=== "${text}" ===`);
    console.log(JSON.stringify(MarkdownParser.parse(text), null, 2));
}
