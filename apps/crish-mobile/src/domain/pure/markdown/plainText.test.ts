// 列表面纯文本摘取断言（MD3）：标题 / 摘要 / hub 摘要只呈现纯文本——
// 结构标记（**、围栏、管道符、#、任务框）不泄漏，文本内容保真；
// 流式半截内容（悬空标记）摘取后不带半截符号。
import { markdownPreviewText } from './plainText';

describe('markdownPreviewText · 标记不泄漏', () => {
  it('行内标记：粗体 / 行内代码 / 链接只留文本', () => {
    const out = markdownPreviewText(
      '**重点** 讨论 `方案` 与 [接入文档](https://example.com)'
    );
    expect(out).toBe('重点 讨论 方案 与 接入文档');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
    expect(out).not.toContain('](');
  });

  it('标题与段落：# 不出现，层级拍平为一行文本', () => {
    const out = markdownPreviewText('# 周报标题\n\n正文有 **粗体**。');
    expect(out).toBe('周报标题 正文有 粗体。');
    expect(out).not.toContain('#');
  });

  it('代码围栏：只取代码头部文本，围栏与语言标不出现', () => {
    const out = markdownPreviewText('```ts\nconst a = 1;\nconst b = 2;\n```');
    expect(out).toContain('const a = 1;');
    expect(out).not.toContain('```');
    expect(out).not.toContain('ts');
  });

  it('表格：单元格文本空格拼接，管道符与分隔行不出现', () => {
    const out = markdownPreviewText(
      '| 列甲 | 列乙 |\n| --- | --- |\n| 甲一 | 乙一 |'
    );
    expect(out).toBe('列甲 列乙 甲一 乙一');
    expect(out).not.toContain('|');
  });

  it('列表与任务列表：项目符号 / 勾选框不出现', () => {
    const out = markdownPreviewText(
      '- [x] 已完成项\n- [ ] 待办项\n\n1. 第一步'
    );
    expect(out).toContain('已完成项');
    expect(out).toContain('待办项');
    expect(out).toContain('第一步');
    expect(out).not.toContain('[ ]');
    expect(out).not.toContain('[x]');
  });

  it('图片只留 alt，引用留正文，分割线不产出', () => {
    const out = markdownPreviewText(
      '![周报配图](https://example.com/i.png)\n\n> 引用一句\n\n---'
    );
    expect(out).toBe('周报配图 引用一句');
    expect(out).not.toContain('![');
    expect(out).not.toContain('>');
  });
});

describe('markdownPreviewText · 流式半截与边界', () => {
  it('悬空粗体：半截符号不摘入（补闭合口径）', () => {
    const out = markdownPreviewText('前文 **重点');
    expect(out).toBe('前文 重点');
    expect(out).not.toContain('**');
  });

  it('悬空链接构造：整段不摘入，前文保留', () => {
    const out = markdownPreviewText('请看 [接入文档](https://exam');
    expect(out).toBe('请看');
    expect(out).not.toContain('[');
  });

  it('空与纯空白 → 空串', () => {
    expect(markdownPreviewText('')).toBe('');
    expect(markdownPreviewText('  \n\n ')).toBe('');
  });

  it('超窗源文：头部摘取仍不带标记（切片尾悬空已处理）', () => {
    const source = `**标题** ${'长正文'.repeat(900)}`;
    const out = markdownPreviewText(source);
    expect(out.startsWith('标题')).toBe(true);
    expect(out).not.toContain('**');
  });
});
