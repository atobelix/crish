// 流式草稿断言（审计 §D.2)：逐帧前缀回放——中间帧不存在表格节点、代码围栏以
// 定型块承载、悬空标记不以符号形态出现；终态与静态解析一致（结构与内容全等）。
import { parseMarkdown } from './parseMarkdown';
import { closeInlineDangling, prepareStreamingMarkdown } from './closeDraft';
import type { MdBlock, MdSpan } from './types';
import { STREAM_DOC, streamFrameAt } from './__fixtures__/golden';

function allBlocks(prepared: {
  sealed: MdBlock[];
  tail: MdBlock[];
}): MdBlock[] {
  return [...prepared.sealed, ...prepared.tail];
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

function paragraphTexts(blocks: readonly MdBlock[]): string[] {
  return blocks
    .filter((b) => b.type === 'paragraph')
    .map((b) => spanTexts((b as { spans: MdSpan[] }).spans));
}

describe('prepareStreamingMarkdown · 逐帧回放', () => {
  // STREAM_DOC 的全部前缀帧（逐字推进，强度高于抽样帧）
  const frames: string[] = [];
  for (let i = 1; i <= STREAM_DOC.length; i += 1) {
    frames.push(STREAM_DOC.slice(0, i));
  }

  it('任何中间帧都不出现表格节点（整表暂缓口径）', () => {
    // 口径边界：表格被空行 + 后续段落终止后进入封口区即成型，那是最终形态
    // （见「表格被后续段落终止后」一测）；「整表暂缓」约束的是表格仍居尾块、
    // 尚未被终止的阶段。故本断言在「文档截到表格末行」的前缀族上回放：
    // 任一真前缀里表格都不得成型为节点，截断全文帧才允许出现。
    const anchor = '| 甲二 | 乙二 |';
    const tableDoc = STREAM_DOC.slice(
      0,
      STREAM_DOC.indexOf(anchor) + anchor.length
    );
    for (let i = 1; i < tableDoc.length; i += 1) {
      const blocks = allBlocks(prepareStreamingMarkdown(tableDoc.slice(0, i)));
      expect(blocks.some((b) => b.type === 'table')).toBe(false);
    }
    // 截断全文在流式口径下仍属未终止（尾块暂缓中）；其终态口径（message-end
    // 的静态解析）则成型为表格——两口径在此对齐登记。
    const streamed = prepareStreamingMarkdown(tableDoc);
    expect(streamed.tailKind).toBe('table');
    expect(parseMarkdown(tableDoc).some((b) => b.type === 'table')).toBe(true);
  });

  it('任何中间帧的段落原文里不出现悬空标记符号', () => {
    for (const frame of frames) {
      const texts = paragraphTexts(allBlocks(prepareStreamingMarkdown(frame)));
      for (const text of texts) {
        // 表格暂缓期的纯文本行允许出现管道符（合法中间态），其余符号不许
        if (text.includes('|')) continue;
        expect(text).not.toContain('**');
        expect(text).not.toContain('```');
      }
    }
  });

  it('围栏开启后：尾块立即以代码块形态承载（定型容器口径）', () => {
    const frame = streamFrameAt('```ts\nconst ans');
    const prepared = prepareStreamingMarkdown(frame);
    expect(prepared.tailKind).toBe('code');
    const code = prepared.tail[prepared.tail.length - 1]!;
    expect(code).toMatchObject({ type: 'code', lang: 'ts' });
    expect((code as { text: string }).text).toContain('const ans');
  });

  it('表格只到表头 + 分隔行时：整表暂缓为纯文本行', () => {
    const frame = streamFrameAt('| --- | --- |');
    const prepared = prepareStreamingMarkdown(frame);
    expect(prepared.tailKind).toBe('table');
    expect(prepared.tail).toHaveLength(1);
    const texts = paragraphTexts(prepared.tail);
    expect(texts[0]).toContain('| 列甲 | 列乙 |');
    expect(texts[0]).toContain('| --- | --- |');
  });

  it('表格被后续段落终止后：进入封口区并成型为表格', () => {
    const frame = streamFrameAt('结尾段落');
    const prepared = prepareStreamingMarkdown(frame);
    expect(prepared.sealed.some((b) => b.type === 'table')).toBe(true);
  });

  it('终态（全文）与静态解析全等', () => {
    const prepared = prepareStreamingMarkdown(STREAM_DOC);
    expect(allBlocks(prepared)).toEqual(parseMarkdown(STREAM_DOC));
  });

  it('封口块在尾块生长期间保持同一引用（缓存命中、memo 不重渲）', () => {
    const a = prepareStreamingMarkdown(streamFrameAt('结尾段落，表格在'));
    const b = prepareStreamingMarkdown(STREAM_DOC);
    expect(a.sealed.length).toBeGreaterThan(0);
    expect(a.sealed[0]).toBe(b.sealed[0]);
  });
});

describe('closeInlineDangling · 保守补闭合', () => {
  it('悬空粗体补闭合后成 strong span，符号不直显', () => {
    const prepared = prepareStreamingMarkdown('这是 **重点内容');
    const texts = paragraphTexts(allBlocks(prepared));
    expect(texts[0]).toBe('这是 重点内容');
    const paragraph = allBlocks(prepared)[0]!;
    if (paragraph.type !== 'paragraph') throw new Error('期望段落');
    expect(
      paragraph.spans.some(
        (span) =>
          span.type === 'strong' && spanTexts(span.children) === '重点内容'
      )
    ).toBe(true);
  });

  it('悬空链接构造整段暂隐，前文保留', () => {
    const prepared = prepareStreamingMarkdown('请看 [接入文档](https://exam');
    const texts = paragraphTexts(allBlocks(prepared));
    // 解析路径：悬空链接整段暂隐、前文保留（段尾空格在解析时归一化，不计较）
    expect(texts[0]).toBe('请看');
    // 原始字符串口径：截断点保留前文原样（含段尾空格）
    expect(closeInlineDangling('请看 [接入文档](https://exam')).toBe('请看 ');
  });

  it('悬空行内代码补反引号成型', () => {
    const prepared = prepareStreamingMarkdown('运行 `npm test` 与 `npm run bu');
    const paragraph = allBlocks(prepared)[0]!;
    if (paragraph.type !== 'paragraph') throw new Error('期望段落');
    const codes = paragraph.spans.filter((span) => span.type === 'code');
    expect(codes).toHaveLength(2);
  });

  it('已闭合的正常文本不被改动', () => {
    const text = '正常 **粗体** 与 `代码` 和 [链接](https://example.com)。';
    expect(closeInlineDangling(text)).toBe(text);
  });
});

describe('prepareStreamingMarkdown · 边界', () => {
  it('空文本与单块文本', () => {
    expect(prepareStreamingMarkdown('')).toEqual({
      sealed: [],
      tail: [],
      tailKind: 'none',
    });
    const single = prepareStreamingMarkdown('只有一段');
    expect(single.sealed).toEqual([]);
    expect(single.tailKind).toBe('flow');
    expect(paragraphTexts(single.tail)).toEqual(['只有一段']);
  });

  it('以空行结尾：全部封口、尾块为空', () => {
    const prepared = prepareStreamingMarkdown('第一段\n\n第二段\n\n');
    expect(prepared.tailKind).toBe('none');
    expect(prepared.tail).toEqual([]);
    expect(prepared.sealed.map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
    ]);
  });
});
