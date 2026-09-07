/**
 * 本地文件读取适配层：在桌面环境下支持读取外部拖拽或选择的文件绝对路径
 * - 支持图片转 Base64 dataUrl（供前端高保真缩略图与多模态模型投递）
 * - 支持文本内容读取（代码/文档）
 */

import { invokeResult } from './tauriInvoke';
import { downscaleDataUrlIfNeeded, readBlobAsDataURL } from './imageProcessing';
import { convertFileSrc } from '@tauri-apps/api/core';

export function getMimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.ppt') || lower.endsWith('.pptx')) {
    return 'application/vnd.ms-powerpoint';
  }
  if (lower.endsWith('.doc') || lower.endsWith('.docx')) {
    return 'application/msword';
  }
  if (lower.endsWith('.xls') || lower.endsWith('.xlsx')) {
    return 'application/vnd.ms-excel';
  }
  return 'application/octet-stream';
}

/**
 * 尝试将本地路径的图片文件读取为 dataUrl（自动降采样超大图）
 */
export async function readLocalImageAsDataUrl(
  filePath: string
): Promise<string | null> {
  const path = (filePath || '').trim();
  if (!path) return null;

  const mime = getMimeFromPath(path);

  // 1. 首选通道：Tauri convertFileSrc + 原生 fetch blob
  try {
    const assetUrl = convertFileSrc(path);
    if (assetUrl) {
      const res = await fetch(assetUrl);
      if (res.ok) {
        const blob = await res.blob();
        const rawDataUrl = await readBlobAsDataURL(blob);
        if (rawDataUrl) {
          return await downscaleDataUrlIfNeeded(rawDataUrl, mime);
        }
      }
    }
  } catch {
    /* fallback to secondary reading */
  }

  // 2. 兜底通道：桌面 shell 读取
  const isWin =
    typeof navigator !== 'undefined' &&
    /Win/i.test(navigator.userAgent || navigator.platform || '');

  try {
    const escaped = path.replace(/'/g, "''");
    const cmd = isWin
      ? `[Convert]::ToBase64String([System.IO.File]::ReadAllBytes('${escaped}'))`
      : `base64 < ${JSON.stringify(path)}`;

    const res = await invokeResult<{ stdout?: string }>('workbench_run_shell', {
      request: { command: cmd },
    });

    if (res.status === 'ok' && res.data?.stdout) {
      const b64 = res.data.stdout.replace(/\s+/g, '');
      if (b64) {
        const rawDataUrl = `data:${mime};base64,${b64}`;
        return await downscaleDataUrlIfNeeded(rawDataUrl, mime);
      }
    }
  } catch {
    /* swallow-ok: 外部读取失败降级 */
  }

  return null;
}

/**
 * 尽力读取本地文本内容（上限 512KB）
 */
export async function readLocalTextBestEffort(
  filePath: string
): Promise<string | null> {
  const path = (filePath || '').trim();
  if (!path) return null;

  // 1. 首选通道：Tauri convertFileSrc + fetch text
  try {
    const assetUrl = convertFileSrc(path);
    if (assetUrl) {
      const res = await fetch(assetUrl);
      if (res.ok) {
        const text = await res.text();
        return text.slice(0, 512_000);
      }
    }
  } catch {
    /* fallback */
  }

  // 2. 兜底通道：桌面 shell Get-Content 读取（规范 PowerShell cmdlet）
  const isWin =
    typeof navigator !== 'undefined' &&
    /Win/i.test(navigator.userAgent || navigator.platform || '');

  try {
    const escaped = path.replace(/'/g, "''");
    const cmd = isWin
      ? `Get-Content -LiteralPath '${escaped}' -Raw -Encoding utf8`
      : `head -c 512000 ${JSON.stringify(path)}`;

    const res = await invokeResult<{ stdout?: string }>('workbench_run_shell', {
      request: { command: cmd },
    });

    if (res.status === 'ok' && typeof res.data?.stdout === 'string') {
      return res.data.stdout;
    }
  } catch {
    /* swallow-ok: 文本读取失败降级 */
  }

  return null;
}
