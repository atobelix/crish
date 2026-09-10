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

function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 非视觉路径：仅脱敏元数据（文件名/类型/大小），禁止 dataUrl 与绝对路径 */
function redactNonVisionImageNote(a: ChatAttachment, mime: string): string {
  const size =
    a.imageMeta?.size ??
    (typeof a.dataUrl === 'string' ? Math.floor((a.dataUrl.length * 3) / 4) : undefined);
  return [
    `[图片附件元数据: ${a.name}]`,
    `格式: ${mime}`,
    `大小: ${formatBytes(size)}`,
    '（当前模型为纯文本非视觉模型：不接收结构化图像，亦不下发 dataUrl / 本机绝对路径）',
  ].join('\n');
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
        const note = redactNonVisionImageNote(a, mime);
        content.push({ type: 'text', text: note });
        promptChunks.push(note);
      }
    } else if (a.annotation) {
      meta.push({ name: a.name, kind: 'text' });
      const sel =
        a.annotation.selectedText.length > 800
          ? `${a.annotation.selectedText.slice(0, 800)}…`
          : a.annotation.selectedText;
      const note = [
        `[代码选区批注: ${a.name}]`,
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
      // 非视觉/通用文件：只报文件名，禁止拼绝对路径
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