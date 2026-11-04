import type { WebSearchSource } from '@crish/shared-types';
import { describe, expect, it } from 'vitest';
import { isCitationSegment, parseMessageCitations } from './citationParser';

describe('citationParser - parseMessageCitations 正文引用解析器', () => {
  const mockSources: WebSearchSource[] = [
    {
      id: 'src-alpha',
      title: 'TypeScript 官方文档',
      url: 'https://www.typescriptlang.org/docs/',
      snippet: 'TypeScript 是具有类型语法的 JavaScript。',
      domain: 'typescriptlang.org',
      provider: 'tavily',
    },
    {
      id: 'src-beta',
      title: 'Rust 编程语言',
      url: 'https://www.rust-lang.org/',
      snippet: '一门赋予每个人构建可靠且高效软件能力的语言。',
      domain: 'rust-lang.org',
      provider: 'bing_html',
    },
    {
      id: '3',
      title: 'Vite 官方文档',
      url: 'https://vitejs.dev/',
      snippet: '下一代前端工具链。',
      domain: 'vitejs.dev',
      provider: 'duckduckgo_html',
    },
  ];

  it('处理空串与空白内容', () => {
    const emptyRes = parseMessageCitations('');
    expect(emptyRes.segments).toEqual([]);
    expect(emptyRes.citedSourceIds).toEqual([]);
    expect(emptyRes.spans).toEqual([]);
  });

  it('处理无引用的纯文本，维持单一文本分段与偏移量一致', () => {
    const text = '这是一段完全没有引文标记的纯文本。';
    const res = parseMessageCitations(text);

    expect(res.segments).toHaveLength(1);
    expect(res.segments[0]!).toEqual({
      type: 'text',
      text,
      startOffset: 0,
      endOffset: text.length,
    });
    expect(res.citedSourceIds).toEqual([]);
    expect(res.spans).toEqual([]);
  });

  it('正确解析标准 Markdown 脚注角标 [^1]', () => {
    const text = '根据最新研究[^1]，TypeScript 显著提升了维护性[^2]。';
    const res = parseMessageCitations(text);

    expect(res.segments).toHaveLength(5);

    expect(res.segments[0]!).toEqual({
      type: 'text',
      text: '根据最新研究',
      startOffset: 0,
      endOffset: 6,
    });

    expect(res.segments[1]!).toMatchObject({
      type: 'citation',
      text: '[^1]',
      rawMatch: '[^1]',
      citationIndex: 1,
      index: 1,
      citationId: '1',
      startOffset: 6,
      endOffset: 10,
    });

    expect(res.segments[2]!).toEqual({
      type: 'text',
      text: '，TypeScript 显著提升了维护性',
      startOffset: 10,
      endOffset: 30,
    });

    expect(res.segments[3]!).toMatchObject({
      type: 'citation',
      text: '[^2]',
      rawMatch: '[^2]',
      citationIndex: 2,
      index: 2,
      citationId: '2',
      startOffset: 30,
      endOffset: 34,
    });

    expect(res.segments[4]!).toEqual({
      type: 'text',
      text: '。',
      startOffset: 34,
      endOffset: 35,
    });

    expect(res.citedSourceIds).toEqual(['1', '2']);
  });

  it('正确解析常用中英文括号数字角标 [1] 与 【2】', () => {
    const text = '第 1 点[1]与第 2 点【2】。';
    const res = parseMessageCitations(text);

    expect(res.segments).toHaveLength(5);

    const seg1 = res.segments[1]!;
    expect(seg1.type).toBe('citation');
    expect(seg1.text).toBe('[1]');
    expect(seg1.citationIndex).toBe(1);

    const seg3 = res.segments[3]!;
    expect(seg3.type).toBe('citation');
    expect(seg3.text).toBe('【2】');
    expect(seg3.citationIndex).toBe(2);

    expect(res.segments.map((s) => s.text).join('')).toBe(text);
  });

  it('正确解析显式引用格式 [cite:id]、[source:id]、[ref:id] 与全角形式', () => {
    const text =
      '参考[cite:src-alpha]、[source:2]、[ref:3]以及【cite:doc-4】。';
    const res = parseMessageCitations(text);

    const citeSegments = res.segments.filter((s) => s.type === 'citation');
    expect(citeSegments).toHaveLength(4);

    // [cite:src-alpha] (非纯数字 ID)
    expect(citeSegments[0]!).toMatchObject({
      type: 'citation',
      text: '[cite:src-alpha]',
      citationId: 'src-alpha',
      citationIndex: undefined,
    });

    // [source:2] (纯数字)
    expect(citeSegments[1]!).toMatchObject({
      type: 'citation',
      text: '[source:2]',
      citationId: '2',
      citationIndex: 2,
    });

    // [ref:3]
    expect(citeSegments[2]!).toMatchObject({
      type: 'citation',
      text: '[ref:3]',
      citationId: '3',
      citationIndex: 3,
    });

    // 【cite:doc-4】
    expect(citeSegments[3]!).toMatchObject({
      type: 'citation',
      text: '【cite:doc-4】',
      citationId: 'doc-4',
    });
  });

  it('正确绑定事实源（sources），填充 CitationItem 与 spans', () => {
    // [1] 对应 mockSources[0] (1-based index)
    // [cite:src-beta] 对应 mockSources[1] (by id)
    // 【3】 对应 mockSources[2] (by id='3' & index=3)
    const text =
      '结论由 TypeScript[1] 与 Rust[cite:src-beta] 支持，结合前端【3】。';
    const res = parseMessageCitations(text, mockSources);

    expect(res.citedSourceIds).toEqual(['src-alpha', 'src-beta', '3']);
    expect(res.spans).toHaveLength(3);

    // 检查第 1 个引用的绑定
    const segCitation1 = res.segments.find(
      (s): s is typeof s & { type: 'citation' } =>
        isCitationSegment(s) && s.citationIndex === 1
    );
    expect(segCitation1).toBeDefined();
    expect(isCitationSegment(segCitation1!)).toBe(true);
    expect(segCitation1?.citation).toEqual({
      index: 1,
      sourceId: 'src-alpha',
      title: 'TypeScript 官方文档',
      url: 'https://www.typescriptlang.org/docs/',
      domain: 'typescriptlang.org',
      quoteSnippet: 'TypeScript 是具有类型语法的 JavaScript。',
    });

    // 检查第 2 个按 ID 绑定的引用
    const segCitation2 = res.segments.find(
      (s): s is typeof s & { type: 'citation' } =>
        isCitationSegment(s) && s.citationId === 'src-beta'
    );
    expect(segCitation2).toBeDefined();
    expect(isCitationSegment(segCitation2!)).toBe(true);
    expect(segCitation2?.citation?.title).toBe('Rust 编程语言');

    // 检查 spans
    expect(res.spans[0]!).toMatchObject({
      sourceIds: ['src-alpha'],
      labelIndex: 1,
    });
    expect(res.spans[1]!).toMatchObject({
      sourceIds: ['src-beta'],
    });
  });

  it('支持相邻连续引用，不产生冗余空文本分段', () => {
    const text = '重大发现[^1][^2][cite:src-beta]！';
    const res = parseMessageCitations(text, mockSources);

    // '重大发现' + 3个引用 + '！' = 5段
    expect(res.segments).toHaveLength(5);
    expect(res.segments.map((s) => s.text).join('')).toBe(text);

    // 确保没有长度为 0 的 text 分段
    const emptyTexts = res.segments.filter(
      (s) => s.type === 'text' && s.text.length === 0
    );
    expect(emptyTexts).toHaveLength(0);
  });

  it('首尾角标边缘用例测试', () => {
    const textOnlyCitation = '[^1]';
    const resOnly = parseMessageCitations(textOnlyCitation);
    expect(resOnly.segments).toHaveLength(1);
    expect(resOnly.segments[0]!.type).toBe('citation');
    expect(resOnly.segments[0]!.text).toBe('[^1]');
    expect(resOnly.segments[0]!.startOffset).toBe(0);
    expect(resOnly.segments[0]!.endOffset).toBe(4);

    const textHeadTail = '[1]在开头，在结尾[2]';
    const resHeadTail = parseMessageCitations(textHeadTail);
    expect(resHeadTail.segments[0]!.type).toBe('citation');
    expect(resHeadTail.segments[0]!.text).toBe('[1]');
    expect(resHeadTail.segments[2]!.type).toBe('citation');
    expect(resHeadTail.segments[2]!.text).toBe('[2]');
  });

  it('刚性保证字符切片完全同构不变式（Invariance Assertion）', () => {
    const complexText =
      '前言 [^1] 中间 1 【2】 中间 2 [cite:alpha-99] 中间 3 [source:7] 结束。';
    const res = parseMessageCitations(complexText);

    // 不变量 1: 分段拼接完全等于原文本
    expect(res.segments.map((s) => s.text).join('')).toBe(complexText);

    // 不变量 2: 每一个分段的 startOffset/endOffset 严丝合缝
    let cursor = 0;
    for (const segment of res.segments) {
      expect(segment.startOffset).toBe(cursor);
      expect(segment.endOffset).toBe(cursor + segment.text.length);
      expect(complexText.slice(segment.startOffset, segment.endOffset)).toBe(
        segment.text
      );
      cursor = segment.endOffset;
    }
    expect(cursor).toBe(complexText.length);
  });
});
