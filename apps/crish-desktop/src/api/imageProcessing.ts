/**
 * 聊天附件图片处理：读 blob、缩略过大 dataUrl、类型判断。
 * 从 ChatCard 抽出，便于单测与复用。
 */

import type { ChatAttachment } from '../hooks/useChatStream';

/** 图片 dataUrl 体积上限（约 1.5MB 原始字节） */
export const IMAGE_DATAURL_CAP = 1.5 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 1600;

export function approxDataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.split(',')[1] || '';
  return Math.floor((b64.length * 3) / 4);
}

export function readBlobAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** 过大时用 canvas 缩到最长边 1600，并降质量，避免 prompt 爆炸 */
export async function downscaleDataUrlIfNeeded(
  dataUrl: string,
  mime: string,
): Promise<string> {
  if (approxDataUrlBytes(dataUrl) <= IMAGE_DATAURL_CAP) return dataUrl;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (!w || !h) {
        resolve(dataUrl);
        return;
      }
      const maxEdge = Math.max(w, h);
      if (maxEdge > MAX_IMAGE_EDGE) {
        const scale = MAX_IMAGE_EDGE / maxEdge;
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
      }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      const outMime =
        mime === 'image/png' || mime === 'image/webp' || !mime ? 'image/jpeg' : mime;
      let quality = 0.85;
      const draw = () => {
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL(outMime, quality);
      };
      let out = draw();
      while (approxDataUrlBytes(out) > IMAGE_DATAURL_CAP && quality > 0.4) {
        quality -= 0.1;
        out = draw();
      }
      let guard = 0;
      while (approxDataUrlBytes(out) > IMAGE_DATAURL_CAP && w > 400 && guard < 6) {
        w = Math.max(1, Math.round(w * 0.7));
        h = Math.max(1, Math.round(h * 0.7));
        out = draw();
        guard += 1;
      }
      resolve(out);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function mimeToExt(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  return 'png';
}

export async function blobToImageAttachment(
  blob: Blob,
  preferredName?: string,
): Promise<ChatAttachment> {
  const mime = blob.type || 'image/png';
  const name =
    preferredName ||
    `截图-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${mimeToExt(mime)}`;
  let dataUrl = await readBlobAsDataURL(blob);
  dataUrl = await downscaleDataUrlIfNeeded(dataUrl, mime);
  return { name, dataUrl, mime };
}

export function isImageFile(f: File): boolean {
  return f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);
}
