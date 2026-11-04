// 解析层断言（审计 §D.2)：黄金样本 → AST 结构（块序列 / span 标记 / 表格维度 /
// 列表嵌套 / 任务勾选），以及安全与保真口径（HTML 原文、脚注原文、危险协议不
// 成链接）。解析器实现细节不泄漏：断言只对自有 AST。
import { parseMarkdown } from './parseMarkdown';
import type { MdBlock, MdSpan } from './types';
import { GOLDEN_MARKDOWN } from './__fixtures__/golden';

function blockTypes(blocks: readonly MdBlock[]): string[] {
  return blocks.map((block) => block.type);
}

function spanTexts(spans: readonly MdSpan[]): string {
  let out = '';
  for (const span of spans) {
    if (span.type === 'text' || span.type === 'code') out += span.text;
    else if (span.type === 'image') out += span.alt;
    else if (span.type === 'break') out += '\n';
    else out += spanTexts(span.children);
  }
  return out;
}

describe('parseMarkdown · 黄金样本结构', () => {
  const blocks = parseMarkdown(GOLDEN_MARKDOWN);

  it('块类型序列与样本排版一致', () => {
    expect(blockTypes(blocks)).toEqual([
      'heading', // # Crish 会话周报
      'heading', // ## 本周进展
      'paragraph', // 本周完成了 …
      'heading', // ### 细节说明
      'heading', // #### 四级标题
      'paragraph', // 下面是一段长代码
      'code', // ```ts 长代码块
      'list', // 无序（含嵌套）
      'list', // 有序
      'quote', // 引用
      'table', // 六列表格
      'list', // 任务列表
      'hr', // 分割线
      'image', // 独立图片段 → 块级占位
      'paragraph', // 内嵌 HTML 原文
      'paragraph', // 脚注引用行
      'paragraph', // 脚注定义行
    ]);
  });

  it('标题层级逐级落位', () => {
    const headings = blocks.filter((b) => b.type === 'heading');
    expect(headings.map((b) => (b as { level: number }).level)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('正文段 span：粗 / 斜 / 删除线 / 行内代码 / 链接齐全', () => {
    const paragraph = blocks[2]!;
    if (paragraph.type !== 'paragraph') throw new Error('期望段落');
    const kinds = paragraph.spans.map((span) => span.type);
    expect(kinds).toContain('strong');
    expect(kinds).toContain('em');
    expect(kinds).toContain('del');
    expect(kinds).toContain('code');
    expect(kinds).toContain('link');
    const link = paragraph.spans.find((span) => span.type === 'link');
    expect(link).toMatchObject({ href: 'https://example.com/crish' });
    // 裸 URL 经 linkify 成链接 span
    const hrefs = paragraph.spans
      .filter((span) => span.type === 'link')
      .map((span) => (span as { href: string }).href);
    expect(hrefs).toContain('https://example.com/docs');
    expect(spanTexts(paragraph.spans)).toContain('流式渲染');
  });

  it('代码块：语言标注与原文（剥尾换行）', () => {
    const code = blocks.find((b) => b.type === 'code');
    if (!code || code.type !== 'code') throw new Error('期望代码块');
    expect(code.lang).toBe('ts');
    expect(code.text).toContain('export interface SessionConfig');
    expect(code.text.endsWith('\n')).toBe(false);
    expect(code.text.split('\n').length).toBeGreaterThanOrEqual(50);
  });

  it('列表嵌套：三级深度成树，任务列表勾选态落位', () => {
    const lists = blocks.filter((b) => b.type === 'list');
    const unordered = lists[0]!;
    if (unordered.type !== 'list') throw new Error('期望列表');
    expect(unordered.ordered).toBe(false);
    expect(unordered.items).toHaveLength(3);
    const second = unordered.items[1]!;
    const nested = second.blocks.find((b) => b.type === 'list');
    if (!nested || nested.type !== 'list') throw new Error('期望嵌套列表');
    expect(nested.items).toHaveLength(2);
    const deep = nested.items[1]!.blocks.find((b) => b.type === 'list');
    expect(deep).toBeTruthy();

    const ordered = lists[1]!;
    if (ordered.type !== 'list') throw new Error('期望有序列表');
    expect(ordered.ordered).toBe(true);
    expect(ordered.start).toBe(1);

    const tasks = lists[2]!;
    if (tasks.type !== 'list') throw new Error('期望任务列表');
    expect(tasks.items.map((item) => item.checked)).toEqual([true, false]);
    // 勾选标记已从正文剥除
    const firstPara = tasks.items[0]!.blocks[0]!;
    if (firstPara.type !== 'paragraph') throw new Error('期望段落');
    expect(spanTexts(firstPara.spans)).toBe('解析层落地');
  });

  it('表格：表头 6 列、行维度与单元格行内代码', () => {
    const table = blocks.find((b) => b.type === 'table');
    if (!table || table.type !== 'table') throw new Error('期望表格');
    expect(table.header).toHaveLength(6);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toHaveLength(6);
    expect(table.align[2]).toBe('center');
    const codeCell = table.rows[0]![3]!;
    expect(codeCell.some((span) => span.type === 'code')).toBe(true);
    expect(spanTexts(codeCell)).toBe('parse');
    expect(spanTexts(table.header[0]!)).toBe('批次');
  });

  it('独立图片段提升为块级图片占位（src / alt 落位，不加载）', () => {
    const image = blocks.find((b) => b.type === 'image');
    expect(image).toMatchObject({
      type: 'image',
      src: 'https://example.com/images/weekly.png',
      alt: '周报配图',
    });
  });
});

describe('parseMarkdown · 保真与安全口径', () => {
  it('内嵌 HTML 按纯文本呈现（源码可见、不成结构）', () => {
    const blocks = parseMarkdown(GOLDEN_MARKDOWN);
    const htmlPara = blocks.find(
      (b) =>
        b.type === 'paragraph' &&
        spanTexts((b as { spans: MdSpan[] }).spans).includes('<div')
    );
    expect(htmlPara).toBeTruthy();
    expect(spanTexts((htmlPara as { spans: MdSpan[] }).spans)).toContain(
      '内嵌 HTML 按原文呈现'
    );
  });

  it('脚注语法按原文呈现（不支持渲染，诚实登记）', () => {
    const blocks = parseMarkdown(GOLDEN_MARKDOWN);
    const texts = blocks
      .filter((b) => b.type === 'paragraph')
      .map((b) => spanTexts((b as { spans: MdSpan[] }).spans));
    expect(texts.some((text) => text.includes('[^1]'))).toBe(true);
  });

  it('javascript: 链接不被解析为链接 span（解析器协议校验 + 出口白名单双保险）', () => {
    const blocks = parseMarkdown('点 [这里](javascript:alert(1)) 继续');
    const paragraph = blocks[0]!;
    if (paragraph.type !== 'paragraph') throw new Error('期望段落');
    expect(paragraph.spans.some((span) => span.type === 'link')).toBe(false);
  });

  it('空文本 → 空块列；结果按全文缓存（同文本同引用）', () => {
    expect(parseMarkdown('')).toEqual([]);
    const text = '缓存探针 **一段**';
    expect(parseMarkdown(text)).toBe(parseMarkdown(text));
  });

  it('无标注围栏与缩进代码块 lang 为 null', () => {
    const fenced = parseMarkdown('```\nplain\n```');
    expect(fenced[0]).toMatchObject({
      type: 'code',
      lang: null,
      text: 'plain',
    });
    const indented = parseMarkdown('正文\n\n    indented = true');
    expect(indented[1]).toMatchObject({ type: 'code', lang: null });
  });
});
