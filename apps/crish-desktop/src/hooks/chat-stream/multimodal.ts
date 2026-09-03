import type {
  ChatContentPart,
  StreamRequestOptions,
  StreamAttachmentMeta,
} from '../../api/chatApi';
import type { ChatAttachment } from './types';

function guessMimeFromDataUrl(dataUrl: string): string | undefined {
  const m = /^data:([^;,]+)/i.exec(dataUrl || '');
  return m?.[1] || undefined;
}

export function buildMultimodalFromAttachments(
  modelText: string,
  attachments: ChatAttachment[]
): {
  promptAttachBlock: string;
  streamOptions: StreamRequestOptions | undefined;
} {
  if (!attachments.length) {
    return { promptAttachBlock: '', streamOptions: undefined };
  }

  const content: ChatContentPart[] = [];
  const meta: StreamAttachmentMeta[] = [];
  const promptChunks: string[] = [];
  let hasImages = false;

  const baseText = (modelText || '').trim();
  if (baseText) {
    content.push({ type: 'text', text: baseText });
  }

  for (const a of attachments) {
    if (a.dataUrl) {
      hasImages = true;
      const mime = a.mime || guessMimeFromDataUrl(a.dataUrl) || 'image/png';
      meta.push({ name: a.name, mime, kind: 'image' });
      content.push({
        type: 'image_url',
        image_url: { url: a.dataUrl, detail: 'auto' },
        name: a.name,
        mime,
      });
      const note = `用户粘贴了截图 ${a.name}，请结合 OCR/视觉理解分析（图片已通过结构化 image_url 部分下发）`;
      promptChunks.push(`[图片附件: ${a.name}]\n${note}`);
    } else if (a.text) {
      meta.push({ name: a.name, kind: 'text' });
      const body = `${a.text.slice(0, 80_000)}${a.text.length > 80_000 ? '\n…(截断)' : ''}`;
      content.push({ type: 'text', text: `--- ${a.name} ---\n${body}` });
      promptChunks.push(`--- ${a.name} ---\n${body}`);
    } else {
      meta.push({ name: a.name, kind: 'file' });
      content.push({ type: 'text', text: `- ${a.name}` });
      promptChunks.push(`- ${a.name}`);
    }
  }

  const promptAttachBlock = `\n\n[附件]\n${promptChunks.join('\n\n')}`;
  const streamOptions: StreamRequestOptions = {
    content,
    hasImages,
    attachments: meta,
  };
  return { promptAttachBlock, streamOptions };
}
