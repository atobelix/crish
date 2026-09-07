import { describe, expect, it } from 'vitest';
import { buildMultimodalFromAttachments } from './multimodal';
import type { ChatAttachment } from './types';

describe('buildMultimodalFromAttachments', () => {
  it('returns empty block and undefined streamOptions when attachments is empty', () => {
    const res = buildMultimodalFromAttachments('hello', []);
    expect(res.promptAttachBlock).toBe('');
    expect(res.streamOptions).toBeUndefined();
  });

  it('builds image parts and meta when image dataUrl is provided', () => {
    const attachments: ChatAttachment[] = [
      {
        name: 'screenshot.png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        mime: 'image/png',
      },
    ];

    const res = buildMultimodalFromAttachments('Analyze this', attachments);

    expect(res.promptAttachBlock).toContain('[图片附件: screenshot.png]');
    expect(res.streamOptions).toBeDefined();
    expect(res.streamOptions?.hasImages).toBe(true);
    expect(res.streamOptions?.attachments).toHaveLength(1);
    expect(res.streamOptions!.attachments![0]).toEqual({
      name: 'screenshot.png',
      mime: 'image/png',
      kind: 'image',
    });
    expect(res.streamOptions?.content).toHaveLength(2); // text + image_url
  });

  it('handles text attachments and truncates long text exceeding 80k chars', () => {
    const longText = 'a'.repeat(90_000);
    const attachments: ChatAttachment[] = [
      {
        name: 'log.txt',
        text: longText,
      },
    ];

    const res = buildMultimodalFromAttachments('Check log', attachments);

    expect(res.streamOptions?.hasImages).toBe(false);
    expect(res.streamOptions!.attachments![0]).toEqual({
      name: 'log.txt',
      kind: 'text',
    });
    const contentText = res.streamOptions!.content![1];
    expect(contentText?.type).toBe('text');
    if (contentText?.type === 'text') {
      expect(contentText.text).toContain('…(截断)');
      expect(contentText.text.length).toBeLessThan(90_000);
    }
  });

  it('handles generic file attachments without text or dataUrl', () => {
    const attachments: ChatAttachment[] = [
      {
        name: 'archive.zip',
      },
    ];

    const res = buildMultimodalFromAttachments('', attachments);

    expect(res.promptAttachBlock).toContain('- archive.zip');
    expect(res.streamOptions!.attachments![0]).toEqual({
      name: 'archive.zip',
      kind: 'file',
    });
  });

  it('非视觉模型优雅降级：不生成 image_url 并以源数据/元数据形式下发', () => {
    const attachments: ChatAttachment[] = [
      {
        name: 'diagram.png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        mime: 'image/png',
        path: 'c:/project/diagram.png',
      },
    ];

    const res = buildMultimodalFromAttachments('请解释流程', attachments, false);

    expect(res.streamOptions?.hasImages).toBe(false);
    expect(res.streamOptions?.content).toHaveLength(2); // text (prompt) + text (image source data)
    expect(res.streamOptions?.content?.some((c) => c.type === 'image_url')).toBe(false);
    const imageTextPart = res.streamOptions?.content?.find((c) => c.type === 'text' && c.text.includes('图片源数据附件'));
    expect(imageTextPart).toBeDefined();
    expect(res.promptAttachBlock).toContain('图片源数据附件: diagram.png');
  });
});
