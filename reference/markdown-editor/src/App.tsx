import { useEffect } from 'react';
import { useEditorStore } from './core/EditorStore';
import { MarkdownEngine } from './components/MarkdownEngine';
import './index.css';

// Generate a massive Markdown document for performance testing
function generateMassiveMarkdown(linesCount: number) {
  const chunks = [];
  chunks.push(`# 高性能 Markdown 渲染引擎全面压力测试`);
  chunks.push(`> 当前渲染规模: ${linesCount} 行。本测试用例文档已全面穷举，覆盖 Markdown 所有基础语法与极端解析场景。`);
  chunks.push(`---`);
  
  for (let i = 0; i < linesCount / 140; i++) {
    chunks.push(`## 核心交互测试区块 ${i + 1}`);
    chunks.push(``);
    chunks.push(`### 1. 标题边缘测试 (Headings)`);
    chunks.push(`# 一级标题 H1`);
    chunks.push(`## 二级标题 H2`);
    chunks.push(`### 三级标题 H3`);
    chunks.push(`#### 四级标题 H4`);
    chunks.push(`##### 五级标题 H5`);
    chunks.push(`###### 六级标题 H6`);
    chunks.push(`####### 非法七级标题（应被解析为普通文本）`);
    chunks.push(`#紧凑无效标题（无空格）`);
    chunks.push(`##   多空格标题测试`);
    chunks.push(``);
    chunks.push(`### 2. 文本格式化极端组合 (Emphasis & Inline Styles)`);
    chunks.push(`基础样式：**加粗**，*斜体*，~~删除线~~，==高亮==，\`行内代码\`。`);
    chunks.push(`变态重叠组合：***加粗斜体***，**加粗内的*斜体*测试**，*斜体内的**加粗**测试*。`);
    chunks.push(`深度嵌套组合：**~~*==高亮斜体删除线加粗==*~~**。`);
    chunks.push(`空标签测试：** **、**  **、****、**、* *、~~ ~~、====。`);
    chunks.push(`单边未闭合测试：**未闭合的加粗、*未闭合的斜体、~~未闭合的删除线。`);
    chunks.push(`带中英文混合：Testing **Bold English** and *Italic English* and ~~Strike English~~ mixed with 中文。`);
    chunks.push(`行内代码逃逸测试：\`包含 反引号 \` 的代码\`，\`\`包含 两个 反引号 \`\` 的代码\`\`，\`包含 *特殊符号* 的代码\`。`);
    chunks.push(``);
    chunks.push(`### 3. 多媒体、超链接与转义 (Links, Images & Escaping)`);
    chunks.push(`基础链接：[普通链接文本](https://google.com)`);
    chunks.push(`无地址链接：[空链接文本]()`);
    chunks.push(`特殊字符链接：[包含空格 的链接](https://google.com?q=hello world)`);
    chunks.push(`带括号的链接：[带括号的链接](https://google.com/test(1))`);
    chunks.push(`图片加载：![这是一个占位图](https://via.placeholder.com/150)`);
    chunks.push(`图片链接嵌套：[![点击图片跳转](https://via.placeholder.com/150)](https://google.com)`);
    chunks.push(`转义字符测试：\\*这不是斜体\\*，\\*\\*这不是加粗\\*\\*，\\[这不是链接\\]，\\# 这不是标题。`);
    chunks.push(`脚注引用测试：这是一段包含脚注引用的文字[^1]和另一处引用[^footnote2]。`);
    chunks.push(``);
    chunks.push(`### 4. 复杂列表结构 (Complex Lists)`);
    chunks.push(`#### 4.1 无序列表与任务列表混合`);
    chunks.push(`- [x] 顶层已完成任务`);
    chunks.push(`- [ ] 顶层未完成任务`);
    chunks.push(`  - 普通嵌套列表 1`);
    chunks.push(`  - [x] 嵌套已完成任务`);
    chunks.push(`    - [ ] 二级嵌套未完成任务`);
    chunks.push(`    - [X] 大写X任务`);
    chunks.push(`    - [ ]    多空格任务`);
    chunks.push(`* 使用星号的无序列表`);
    chunks.push(`+ 使用加号的无序列表`);
    chunks.push(``);
    chunks.push(`#### 4.2 有序列表与混合缩进`);
    chunks.push(`1. 有序列表第一步`);
    chunks.push(`2. 有序列表第二步`);
    chunks.push(`999. 超大数字的有序列表`);
    chunks.push(`0. 零开头的有序列表`);
    chunks.push(`   1. 嵌套的有序列表 1`);
    chunks.push(`   2. 嵌套的有序列表 2`);
    chunks.push(`      - 混合嵌套无序列表`);
    chunks.push(`      - 混合嵌套无序列表`);
    chunks.push(``);
    chunks.push(`### 5. 引用块深层嵌套 (Deep Blockquotes)`);
    chunks.push(`> 第一层引用`);
    chunks.push(`> > 第二层嵌套引用`);
    chunks.push(`> > > 第三层深层引用`);
    chunks.push(`> `);
    chunks.push(`> 第一层引用继续，中间带有空引用行`);
    chunks.push(`> 引用内包含列表：`);
    chunks.push(`> - [x] 引用内的任务`);
    chunks.push(`> - [ ] 引用内的任务 2`);
    chunks.push(`> `);
    chunks.push(`> 引用内包含代码块：`);
    chunks.push(`> \`\`\`json`);
    chunks.push(`> { "key": "value" }`);
    chunks.push(`> \`\`\``);
    chunks.push(``);
    chunks.push(`### 6. 代码块与 HTML (Code & HTML)`);
    chunks.push(`\`\`\`javascript`);
    chunks.push(`// 标准代码块测试`);
    chunks.push(`function fibonacci(n) {`);
    chunks.push(`    if (n <= 1) return n;`);
    chunks.push(`    return fibonacci(n - 1) + fibonacci(n - 2);`);
    chunks.push(`}`);
    chunks.push(`\`\`\``);
    chunks.push(``);
    chunks.push(`\`\`\``);
    chunks.push(`无指定语言代码块`);
    chunks.push(`Plain text code block test.`);
    chunks.push(`\`\`\``);
    chunks.push(``);
    chunks.push(`\`\`\`html`);
    chunks.push(`<!-- 包含HTML语法的代码块 -->`);
    chunks.push(`<div>`);
    chunks.push(`  <span style="color: red;">内联HTML解析逃逸测试</span>`);
    chunks.push(`</div>`);
    chunks.push(`\`\`\``);
    chunks.push(``);
    chunks.push(`内联 HTML 标签解析逃逸：<span style="color: blue">这是蓝色文字吗？</span>还是作为纯文本显示？`);
    chunks.push(``);
    chunks.push(`### 7. 表格高级排版 (Tables)`);
    chunks.push(`| 功能模块 | 修复状态 | 性能开销 (ms) |`);
    chunks.push(`| :--- | :---: | ---: |`);
    chunks.push(`| 虚拟列表滚动 | 🟢 已完成 | < 2ms |`);
    chunks.push(`| AST 增量解析 | 🟢 已完成 | ~5ms |`);
    chunks.push(`| 表格内 **加粗** | *斜体* 测试 | ~~删除线~~ |`);
    chunks.push(`| 包含 \`代码\` | [链接](#) | 🖼图片占位 |`);
    chunks.push(`| 极简表格测试 | 自动对齐 | 空单元格下方 |`);
    chunks.push(`| | | |`);
    chunks.push(``);
    chunks.push(`### 8. 水平分割线异形结构 (Horizontal Rules)`);
    chunks.push(`---`);
    chunks.push(`***`);
    chunks.push(`___`);
    chunks.push(`- - -`);
    chunks.push(`* * *`);
    chunks.push(``);
    chunks.push(`### 9. 扩展语法 (Math, Kbd, Spoiler, Sub/Sup)`);
    chunks.push(`数学公式: 质能等价公式 $E = mc^2$，复数解析 $e^{i\\pi} + 1 = 0$。`);
    chunks.push(`独立块公式：`);
    chunks.push(`$$`);
    chunks.push(`\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}`);
    chunks.push(`$$`);
    chunks.push(`按键标记: 终止任务请按 <kbd>Ctrl</kbd> + <kbd>C</kbd>，清屏按 <kbd>Cmd</kbd> + <kbd>K</kbd>。`);
    chunks.push(`上下标: H<sub>2</sub>O 是水，2<sup>10</sup> = 1024。以及简写水 H~2~O 和次方 2^10^。`);
    chunks.push(`剧透警告: 杀手其实是 ||那个一直在微笑的管家||。`);
    chunks.push(``);
    chunks.push(`=== 区块 ${i + 1} 测试结束 ===`);
    chunks.push(``);
  }
  
  return chunks.join('\n');
}

function App() {
  const { text, setText } = useEditorStore();

  useEffect(() => {
    // Generate ~10,000 lines of markdown
    const massiveDoc = generateMassiveMarkdown(1000);
    setText(massiveDoc);
  }, []);

  return (
    <div className="grid-paper">
      <MarkdownEngine markdown={text} />
    </div>
  );
}

export default App;
