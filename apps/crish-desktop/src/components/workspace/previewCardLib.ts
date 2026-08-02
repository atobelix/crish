/**
 * PreviewCard 纯函数层：iframe 安全 src 判定 + 常量。
 * 从 PreviewCard.tsx 抽出，零副作用，可独立单测。
 */
import {
  isAboutBlank,
  isBrowseUrlOk,
  isEmbeddablePreviewUrl,
  validateBrowseUrl,
} from '../../api/previewBrowserStore';

export const QUICK_LOCAL = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:8765',
] as const;

/** iframe 加载卡住时收 loading，避免转圈永驻（不 toast，状态条已反馈） */
export const LOAD_TIMEOUT_MS = 20_000;

export const HIST_PANEL_ID = 'preview-hist-panel';

/**
 * 仅当可安全内嵌时返回 iframe src；否则 null（禁止把危险/不可嵌 URL 写入 iframe）。
 * 依赖 store 的 validateBrowseUrl + isEmbeddablePreviewUrl；about:blank 走空态不进 iframe。
 */
export function safeIframeSrc(url: string): string | null {
  if (!url || isAboutBlank(url)) return null;
  const checked = validateBrowseUrl(url);
  if (!isBrowseUrlOk(checked)) return null;
  if (!isEmbeddablePreviewUrl(checked.url) || isAboutBlank(checked.url)) return null;
  return checked.url;
}
