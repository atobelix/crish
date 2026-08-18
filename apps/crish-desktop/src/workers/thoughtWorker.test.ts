import { describe, it, expect } from 'vitest';
import {
  extractHeadingsSync,
  searchThoughtTextSync,
  budgetThinkingText,
  sliceSafeTailMarkdown,
} from './thoughtWorker';

describe('thoughtWorker TOC 状态机与检索测试', () => {
  it('应当过滤代码块内部的 Python / Bash 注释 # ...，不误提权为 H1', () => {
    const text = `
# 1. 架构总纲
这里是正文描述。

\`\`\`python
# 这是一个 Python 注释，绝不能被提取为标题
def foo():
    # 另一个注释
    pass
\`\`\`

~~~bash
# 这是一个 Bash 注释
npm run build
~~~

## 2. 详细执行方案
正文内容。

### 2.1 子任务拆分
具体步骤。
`;

    const headings = extractHeadingsSync(text);
    expect(headings).toHaveLength(3);
    expect(headings[0]?.text).toBe('1. 架构总纲');
    expect(headings[0]?.level).toBe(1);
    expect(headings[1]?.text).toBe('2. 详细执行方案');
    expect(headings[1]?.level).toBe(2);
    expect(headings[2]?.text).toBe('2.1 子任务拆分');
    expect(headings[2]?.level).toBe(3);
  });

  it('支持 Unicode 字符安全 ID 生成', () => {
    const text = '# 核心架构：模型路由 & 状态机 🚀';
    const headings = extractHeadingsSync(text);
    expect(headings).toHaveLength(1);
    expect(headings[0]?.id).toContain('thought-h-0-');
    expect(headings[0]?.text).toBe('核心架构：模型路由 & 状态机 🚀');
  });

  it('全文关键词检索 searchThoughtTextSync 正确返回匹配项与上下文切片', () => {
    const text = '第一行内容\n这里有目标关键词 Antigravity 在此\n第三行结束';
    const results = searchThoughtTextSync(text, 'Antigravity');
    expect(results).toHaveLength(1);
    expect(results[0]?.lineIndex).toBe(1);
    expect(results[0]?.snippet).toContain('Antigravity');
  });
});

describe('Safe Markdown Tail Slicer (DEC-06 / DIM-06)', () => {
  it('短文本不发生截断', () => {
    const text = '短思考内容';
    const res = budgetThinkingText(text, { cap: 1000, mode: 'tail' });
    expect(res.isTruncated).toBe(false);
    expect(res.displayText).toBe(text);
  });

  it('尾窗截断时对齐换行符并自动闭合未闭合的代码块', () => {
    const text = `# 阶段 1\n第一部分思考内容极其冗长...\n\`\`\`typescript\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n`;
    // 设置很小的 cap 强制触发 tail slice
    const res = sliceSafeTailMarkdown(text, 35);
    expect(res.isTruncated).toBe(true);
    // 应当自动补齐前导和后置 code fence
    expect(res.displayText).toContain('```');
    expect(res.omittedHeadChars).toBeGreaterThan(0);
  });

  it('尾窗截断时自动闭合 LaTeX 公式块', () => {
    const text = `前导内容很长很长很长...\n$$\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n`;
    const res = sliceSafeTailMarkdown(text, 25);
    expect(res.isTruncated).toBe(true);
    expect(res.displayText).toContain('$$');
  });
});
