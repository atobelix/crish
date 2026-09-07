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
  attachments: ChatAttachment[],
  isVisionSupported = true
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
      const mime = a.mime || guessMimeFromDataUrl(a.dataUrl) || 'image/png';
      meta.push({ name: a.name, mime, kind: 'image' });

      if (isVisionSupported) {
        // 多模态视觉模型：下发结构化 image_url
        hasImages = true;
        content.push({
          type: 'image_url',
          image_url: { url: a.dataUrl, detail: 'auto' },
          name: a.name,
          mime,
        });
        const note = `用户上传了图片 ${a.name}，请结合 OCR/视觉理解分析（图片已通过结构化 image_url 部分下发）`;
        promptChunks.push(`[图片附件: ${a.name}]\n${note}`);
      } else {
        // 纯文本非视觉模型：用户裁决允许使用源数据。将图片作为源数据引用传递，杜绝服务端 400 崩溃
        const pathInfo = a.path ? ` | 路径: ${a.path}` : '';
        const sourceDataSnippet = a.dataUrl.length <= 2048
          ? `\n源数据: ${a.dataUrl}`
          : `\n源数据摘要: ${a.dataUrl.slice(0, 120)}…[已截断，共${a.dataUrl.length}字符]`;
        const note = `[图片源数据附件: ${a.name} | 格式: ${mime}${pathInfo}]\n（当前模型为纯文本模型，不接收结构化图像多模态输入，图片以源数据引用形式下发）${sourceDataSnippet}`;
        content.push({
          type: 'text',
          text: note,
        });
        promptChunks.push(note);
      }
    } else if (a.annotation) {
      meta.push({ name: a.name, kind: 'text' });
      const sel =
        a.annotation.selectedText.length > 800
          ? `${a.annotation.selectedText.slice(0, 800)}…`
          : a.annotation.selectedText;
      const note = [
        `[代码选区批注: ${a.path || a.name}]`,
        `选中代码:`,
        '```',
        sel,
        '```',
        `批注建议: ${a.annotation.comment}`,
      ].join('\n');
      content.push({ type: 'text', text: note });
      promptChunks.push(note);
    } else if (a.text) {
      meta.push({ name: a.name, kind: 'text' });
      const body = `${a.text.slice(0, 80_000)}${a.text.length > 80_000 ? '\n…(截断)' : ''}`;
      content.push({ type: 'text', text: `--- ${a.name} ---\n${body}` });
      promptChunks.push(`--- ${a.name} ---\n${body}`);
    } else {
      meta.push({ name: a.name, kind: 'file' });
      const pathInfo = a.path ? ` (${a.path})` : '';
      content.push({ type: 'text', text: `- ${a.name}${pathInfo}` });
      promptChunks.push(`- ${a.name}${pathInfo}`);
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
