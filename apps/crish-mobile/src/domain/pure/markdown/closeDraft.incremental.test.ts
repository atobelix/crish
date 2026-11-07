// 流式增量投影：封口前缀不因每个字重新解析；回滚不能沿用过期块。
import { STREAM_DOC } from './__fixtures__/golden';
import { clearMarkdownCacheForTest, parseMarkdown } from './parseMarkdown';
import {
  prepareStreamingMarkdown,
  projectStreamingMarkdown,
  shareBlockPrefix,
  type StreamingProjection,
} from './closeDraft';

function replay(text: string): StreamingProjection {
  let previous: StreamingProjection | null = null;
  let current: StreamingProjection | null = null;
  for (let index = 1; index <= text.length; index += 1) {
    const frame = text.slice(0, index);
    current = projectStreamingMarkdown(frame, previous);
    const stateless = prepareStreamingMarkdown(frame);
    expect(current.sealed).toEqual(stateless.sealed);
    expect(current.tail).toEqual(stateless.tail);
    expect(current.tailKind).toBe(stateless.tailKind);
    previous = current;
  }
  if (!current) throw new Error('空文本没有投影');
  return current;
}

describe('流式增量投影', () => {
  it('尾部追加不重建已封口块，即使解析缓存被清空', () => {
    const base = '第一段正文\n\n尾';
    const first = projectStreamingMarkdown(base, null);
    expect(first.sealed.length).toBeGreaterThan(0);
    clearMarkdownCacheForTest();
    const next = projectStreamingMarkdown(`${base}部`, first);
    expect(next.sealed).toBe(first.sealed);
    expect(next.sealed[0]).toBe(first.sealed[0]);
    expect(next.tail).toEqual(prepareStreamingMarkdown(`${base}部`).tail);
  });

  it('同一输入直接复用投影', () => {
    const first = projectStreamingMarkdown('甲\n\n乙', null);
    expect(projectStreamingMarkdown('甲\n\n乙', first)).toBe(first);
  });

  it('回滚到更短文本时与无状态结果一致，不保留被删掉的段', () => {
    const grown = projectStreamingMarkdown('第一段\n\n第二段', null);
    clearMarkdownCacheForTest();
    const rolled = projectStreamingMarkdown('第一段', grown);
    const stateless = prepareStreamingMarkdown('第一段');
    expect(rolled.sealed).toEqual(stateless.sealed);
    expect(rolled.tail).toEqual(stateless.tail);
    expect(JSON.stringify(rolled)).not.toContain('第二段');
  });

  it('段落、引用、列表、围栏和表格逐字增长后与无状态终态一致，闭合标记还在', () => {
    const samples = [
      '引言\n\n> 引用一行\n> 引用二行\n\n- 甲\n- 乙\n\n```ts\nconst x = 1\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |\n\n结尾',
    ];
    for (const sample of samples) {
      const projected = replay(sample);
      const stateless = prepareStreamingMarkdown(sample);
      expect(projected.sealed).toEqual(stateless.sealed);
      expect(projected.tail).toEqual(stateless.tail);
      expect(sample).toContain('```');
      expect(projected.sealed.some((block) => block.type === 'code')).toBe(true);
      expect(projected.sealed.some((block) => block.type === 'table')).toBe(true);
    }
  });

  it('流式样例逐字增长后与静态解析一致，闭合围栏仍在', () => {
    const projected = replay(STREAM_DOC);
    const blocks = [...projected.sealed, ...projected.tail];
    expect(blocks).toEqual(parseMarkdown(STREAM_DOC));
    expect(blocks.some((block) => block.type === 'code')).toBe(true);
    expect(STREAM_DOC).toContain('```');
  });

  it('后一块封口时，更早的封口块保持同一引用，终态仍等于静态解析', () => {
    let text = '段0\n\n';
    let previous = projectStreamingMarkdown(text, null);
    const first = previous.sealed[0];
    expect(first).toBeDefined();
    for (let index = 1; index <= 30; index += 1) {
      if (index === 10) clearMarkdownCacheForTest();
      text += `段${index}\n\n`;
      const next = projectStreamingMarkdown(text, previous);
      expect(next.sealed[0]).toBe(first);
      expect(next.sealed).toEqual(prepareStreamingMarkdown(text).sealed);
      previous = next;
    }
    const blocks = [...previous.sealed, ...previous.tail];
    expect(blocks).toEqual(parseMarkdown(text));
    expect(blocks[0]).toBe(first);
  });

  it('标题、分隔线、有序列表、任务列表和图片逐字增长后与静态解析一致', () => {
    const sample = [
      '# 标题',
      '',
      '段落含 [链接](https://example.com/doc) 与 `代码`。',
      '',
      '---',
      '',
      '1. 第一',
      '2. 第二',
      '',
      '- [x] 完成',
      '- [ ] 未完成',
      '',
      '![示意图](https://example.com/a.png)',
      '',
      '> 引用仍在',
      '',
      '收束段',
    ].join('\n');
    const projected = replay(sample);
    const blocks = [...projected.sealed, ...projected.tail];
    expect(blocks).toEqual(parseMarkdown(sample));
    expect(blocks.map((block) => block.type)).toEqual(
      expect.arrayContaining(['heading', 'hr', 'list', 'image', 'quote', 'paragraph'])
    );
  });

  it('静态终态只走一次全量解析，并复用仍然相同的前缀块', () => {
    const text = '甲段\n\n乙段';
    const streamed = replay(text);
    clearMarkdownCacheForTest();
    const parsed = parseMarkdown(text);
    const shared = shareBlockPrefix(
      [...streamed.sealed, ...streamed.tail],
      parsed
    );
    expect(shared).toEqual(parsed);
    expect(shared[0]).toBe(streamed.sealed[0]);
  });
});
