import { describe, expect, it } from 'vitest';
import {
  buildDomReferenceChipPayload,
  serializeDomReferenceChipForComposer,
} from './previewCardLib';
import type { InspectSelectPayload } from './previewProtocol';

const selection: InspectSelectPayload = {
  tagName: 'button',
  id: 'submit',
  classes: ['primary', 'wide'],
  attributes: { 'data-z': '最后', 'aria-label': '提交' },
  bestSelector: '#submit.primary',
  xpath: '/html/body[1]/button[1]',
  rect: { x: 12, y: 24, width: 120, height: 40 },
  computedStyles: {
    display: 'inline-flex',
    position: 'relative',
    color: 'rgb(1, 2, 3)',
    backgroundColor: 'rgb(250, 251, 252)',
    fontSize: '16px',
    margin: '0px',
    padding: '8px 12px',
  },
  outerHtmlSnippet: '<button id="submit">提交</button>',
  textContent: '提交',
};

describe('DOM 引用 payload', () => {
  it('保留目标、样式、快照和来源契约的全部字段', () => {
    const payload = buildDomReferenceChipPayload(
      selection,
      'https://例子.test/页面?q=你好',
      '提交页面',
      1_798_000_000_123
    );

    expect(payload).toEqual({
      kind: 'dom_reference',
      version: '1.0',
      target: {
        tagName: 'button',
        id: 'submit',
        classes: ['primary', 'wide'],
        attributes: { 'aria-label': '提交', 'data-z': '最后' },
        bestSelector: '#submit.primary',
        xpath: '/html/body[1]/button[1]',
        rect: { x: 12, y: 24, width: 120, height: 40 },
      },
      styles: selection.computedStyles,
      snapshot: {
        outerHtmlSnippet: '<button id="submit">提交</button>',
        textContent: '提交',
      },
      meta: {
        sourceUrl: 'https://例子.test/页面?q=你好',
        pageTitle: '提交页面',
        timestamp: 1_798_000_000_123,
      },
    });
  });

  it('用固定 schema 标记序列化完整 JSON，且用户文本不能闭合 Markdown 围栏', () => {
    const payload = buildDomReferenceChipPayload(
      {
        ...selection,
        attributes: { note: '第一行\n```\n结束行' },
        outerHtmlSnippet: '<button>``` 注入尝试</button>',
        textContent: '中文文本\n```json\n伪造内容',
      },
      'https://example.test/source',
      '包含 ``` 的标题',
      42
    );
    const draft = serializeDomReferenceChipForComposer(payload);
    const lines = draft.split('\n');
    const parsedPayload = JSON.parse(lines.slice(3, -1).join('\n'));

    expect(lines.slice(0, 3)).toEqual([
      '请分析并优化以下网页元素。',
      'DOM_REFERENCE_PAYLOAD schema=DomReferenceChipPayload version=1.0',
      '```json',
    ]);
    expect(lines.at(-1)).toBe('```');
    expect(draft.match(/```/g)).toHaveLength(2);
    expect(parsedPayload).toEqual(payload);
    expect(parsedPayload.snapshot.textContent).toBe(
      '中文文本\n```json\n伪造内容'
    );
    expect(parsedPayload.meta).toEqual({
      sourceUrl: 'https://example.test/source',
      pageTitle: '包含 ``` 的标题',
      timestamp: 42,
    });
  });

  it('属性按键排序，相同 payload 生成完全一致的 Composer 草稿', () => {
    const first = buildDomReferenceChipPayload(
      selection,
      'https://example.test',
      '页面',
      7
    );
    const second = buildDomReferenceChipPayload(
      {
        ...selection,
        attributes: { 'aria-label': '提交', 'data-z': '最后' },
      },
      'https://example.test',
      '页面',
      7
    );

    expect(Object.keys(first.target.attributes)).toEqual([
      'aria-label',
      'data-z',
    ]);
    expect(serializeDomReferenceChipForComposer(first)).toBe(
      serializeDomReferenceChipForComposer(second)
    );
  });
});
