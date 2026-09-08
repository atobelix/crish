/**
 * 本地文件读取适配层：支持本机绝对路径与工作区相对路径，经受控 convertFileSrc 读盘。
 * 禁止经 shell 拼路径读盘作为产品路径；用户选择或拖拽的外部文件经受控 convertFileSrc 读取。
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { downscaleDataUrlIfNeeded, readBlobAsDataURL } from './imageProcessing';
import { isAbsoluteFsPath, getWorkspacePath } from './workspaceFsApi';

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

const TEXT_READ_BYTE_CAP = 512_000;

/**
 * 规范化并校验本地文件路径（空路径/非法字符优雅抛错）。
 * 支持系统任意目录的绝对路径（放行外部目录，不设工作区拦截），以及工作区相对路径。
 */
export function resolveLocalPath(filePath: string): string {
  const raw = (filePath || '').trim();
  if (!raw) {
    throw new Error('文件路径为空');
  }
  if (raw.includes('\0')) {
    throw new Error(`非法本地文件路径: ${filePath}`);
  }
  if (isAbsoluteFsPath(raw)) {
    return raw;
  }
  const norm = raw.replace(/\\/g, '/');
  if (/(^|\/)\.\.($|\/)/.test(norm)) {
    throw new Error(`非法相对路径组件: ${filePath}`);
  }
  const workspaceRoot = getWorkspacePath()?.trim();
  if (workspaceRoot) {
    const rel = raw.replace(/^\.[\\/]/, '');
    const sep = workspaceRoot.includes('\\') ? '\\' : '/';
    return `${workspaceRoot.replace(/[\\/]+$/, '')}${sep}${rel}`;
  }
  return raw;
}

/**
 * 本地资源抓取：接收任意绝对路径或工作区相对路径。
 * 绝对路径直接转为 asset:// 协议 URL 并通过 fetch 读取。
 * 若 fetch 失败（如文件不存在或 404），抛出明确错误 `读取本地文件失败 (${res.status}): ${filePath}`。
 */
export async function fetchLocalAsset(filePath: string): Promise<Response> {
  const resolved = resolveLocalPath(filePath);
  const assetUrl = convertFileSrc(resolved);
  if (!assetUrl) {
    throw new Error(`无法解析本地资源 URL: ${filePath}`);
  }
  const res = await fetch(assetUrl);
  if (!res.ok) {
    throw new Error(`读取本地文件失败 (${res.status}): ${filePath}`);
  }
  return res;
}

/** 保持原有导出兼容 */
export const fetchWorkspaceAsset = fetchLocalAsset;

/**
 * 将本地图片读取为 dataUrl（自动降采样超大图）。
 * 接收绝对路径（支持工作区外）或相对路径，空路径/非法路径/读失败优雅抛错。
 */
export async function readLocalImageAsDataUrl(filePath: string): Promise<string> {
  const resolved = resolveLocalPath(filePath);
  const mime = getMimeFromPath(resolved);
  const res = await fetchLocalAsset(filePath);
  const blob = await res.blob();
  const rawDataUrl = await readBlobAsDataURL(blob);
  if (!rawDataUrl) {
    throw new Error(`图片转 dataUrl 失败: ${filePath}`);
  }
  return await downscaleDataUrlIfNeeded(rawDataUrl, mime);
}

/**
 * 读取本地文本（上限 512KB）。
 * 接收绝对路径（支持工作区外）或相对路径，空路径/非法路径/读失败优雅抛错。
 */
export async function readLocalTextBestEffort(filePath: string): Promise<string> {
  const res = await fetchLocalAsset(filePath);
  const text = await res.text();
  return text.slice(0, TEXT_READ_BYTE_CAP);
}
