import { MarkdownEngine } from './src/components/MarkdownEngine';
import { MarkdownParser } from './src/core/parser';

const text = "空标签测试：** **、**  **、****、**、* *、~~ ~~、====。";
const ast = MarkdownParser.parseLine(text, 0, false);
console.log(JSON.stringify(ast, null, 2));
