import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { locateFirstPlaceholder } from '../tiptapInjectionUtils';

const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    text: { inline: true },
  },
});

describe('locateFirstPlaceholder', () => {
  it('应当正确深入段落节点扫描首个 [描述...] 占位符', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [
        testSchema.text('请执行定时任务：[描述希望定时执行的任务...]'),
      ]),
    ]);

    const result = locateFirstPlaceholder(doc);
    expect(result).not.toBeNull();
    expect(result?.text).toBe('[描述希望定时执行的任务...]');
  });

  it('应当正确深入多个段落节点扫描首个 {{占位}}', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('普通前言段落')]),
      testSchema.node('paragraph', null, [
        testSchema.text('参数为 {{taskName}} 和 {{cron}}'),
      ]),
    ]);

    const result = locateFirstPlaceholder(doc);
    expect(result).not.toBeNull();
    expect(result?.text).toBe('{{taskName}}');
  });

  it('无占位符时应当返回 null', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('这是一段普通对话内容')]),
    ]);

    const result = locateFirstPlaceholder(doc);
    expect(result).toBeNull();
  });
});
