const fs = require('fs');
const path = require('path');

const HEADINGS = [
    '# H1',
    '## H2',
    '### H3',
    '#### H4',
    '##### H5',
    '###### H6',
    '####### Invalid H7',
    '#Invalid H1 no space',
    '#       H1 with many spaces',
];

const BLOCKS = [
    '> Blockquote simple',
    '> Blockquote with **bold** and *italic*',
    '> > Nested blockquote',
    '---\n',
    '***\n',
    '___\n',
];

const CODE_FENCES = [
    '```javascript\nconst a = 1;\n```',
    '```\nNo lang fence\n```',
    '~~~~html\n<div></div>\n~~~~',
];

const MATH = [
    '$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$',
    '$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$',
];

const INLINES = [
    'Some text with **bold**.',
    'Some text with *italic*.',
    'Some text with ~~strikethrough~~.',
    'Some text with `inline code`.',
    'Some text with $E=mc^2$.',
    'Some text with a [link](https://example.com).',
    'Some text with an ![image](image.png).',
    'Some text with ~subscript~ and ^superscript^.',
    'A deeply nested ***~~`combo`~~***!',
];

function getRandomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function generateMarkdown(numLines) {
    let md = '';
    const choices = [HEADINGS, BLOCKS, CODE_FENCES, MATH, INLINES];
    
    for (let i = 0; i < numLines; i++) {
        // Randomly pick a category
        const category = getRandomItem(choices);
        md += getRandomItem(category) + '\n\n';
    }
    return md;
}

const OUT_DIR = path.join(__dirname, '../tests/e2e/fuzz-data');
if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
}

console.log('Generating Tricky Markdown Fuzz Files...');
for (let i = 1; i <= 5; i++) {
    const lines = Math.floor(Math.random() * 50) + 20; // 20 to 70 blocks
    const content = generateMarkdown(lines);
    const fileName = `fuzz-test-${i}.md`;
    fs.writeFileSync(path.join(OUT_DIR, fileName), content, 'utf-8');
    console.log(`- Created ${fileName} with ${lines} random blocks`);
}
console.log('Generation complete. These can be loaded into E2E tests for randomized layout thrash testing.');
