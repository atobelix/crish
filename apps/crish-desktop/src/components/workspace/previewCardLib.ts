/**
 * PreviewCard 纯函数层：iframe 安全 src 判定 + 常量。
 * 从 PreviewCard.tsx 抽出，零副作用，可独立单测。
 *
 * audit-repair-202609 · T19 清退：`injectPreviewBridgeHtml`（与 dev-server/
 * previewBridgeScript.ts 双轨的 srcDoc 版桥，零调用方）、
 * `convertInspectedElementPayload`（legacy crish:dom-inspected 协议换轨层）、
 * `QUICK_LOCAL`（被 activePortDetector 取代）均已删除。
 */
import {
  isAboutBlank,
  isBrowseUrlOk,
  isEmbeddablePreviewUrl,
  validateBrowseUrl,
} from '../../api/previewBrowserStore';
import type { InspectSelectPayload } from './previewProtocol';

/** iframe 加载卡住时收 loading，避免转圈永驻（不 toast，状态条已反馈） */
export const LOAD_TIMEOUT_MS = 20_000;

export const HIST_PANEL_ID = 'preview-hist-panel';

/**
 * 判定是否为本地开发服务 URL（localhost / 127.0.0.1 / [::1] / 0.0.0.0 / *.local / *.internal / *.lan / 当前 origin 宿主）
 */
export function isLocalDevUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.lan') ||
      (typeof window !== 'undefined' && host === window.location.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * 外部网站自动代理：当输入的 URL 为外部网站时自动转为同源代理端点；
 * 空白页、data: URL 或本地 dev server 直接加载。
 *
 * audit-repair-202609 · T20：代理是 dev server 中间件（configureServer），
 * 生产构建不存在该端点——非 dev 环境一律返回原 URL，走 canEmbed 判定
 * 与「禁止嵌入可外部打开」既有降级，不再打到必 404 的代理路径。
 */
export function toProxyPreviewUrl(url: string): string {
  if (!url || isAboutBlank(url)) return url;
  if (url.startsWith('data:') || url.startsWith('file://')) return url;
  if (url.startsWith('/__crish_preview_proxy')) return url;
  if (url.startsWith('http://127.0.0.1:8765/v1/preview/proxy')) return url;
  if (import.meta.env.DEV && /^https?:\/\//i.test(url)) {
    if (!isLocalDevUrl(url)) {
      return `/__crish_preview_proxy?url=${encodeURIComponent(url)}`;
    }
  }
  return url;
}

/**
 * 仅当可安全内嵌时返回 iframe src；否则 null（禁止把危险/不可嵌 URL 写入 iframe）。
 * 外部网站自动转为 /__crish_preview_proxy 代理端点；本地 dev server 与 data: URL 直接加载。
 */
export function safeIframeSrc(url: string): string | null {
  if (!url || isAboutBlank(url)) return null;
  if (url.startsWith('data:')) return url;
  const checked = validateBrowseUrl(url);
  if (!isBrowseUrlOk(checked)) return null;
  if (!isEmbeddablePreviewUrl(checked.url) || isAboutBlank(checked.url)) return null;
  return toProxyPreviewUrl(checked.url);
}

/**
 * 组装拾取元素的展示标签：`tag#id.class1.class2`（用于悬停/选中浮层）。
 */
export function buildInspectorElementLabel(
  tagName: string,
  id: string | null,
  classes: string[]
): string {
  const parts = [tagName.toLowerCase()];
  if (id) parts.push(`#${id}`);
  if (classes && classes.length > 0) {
    parts.push(...classes.map((c) => `.${c}`));
  }
  return parts.join('');
}

/**
 * 生成「发送到 AI」的结构化 Prompt 片段：
 * `请分析并优化这个元素 [@DOM: <标签> (WxH)]，选择器：<bestSelector>`
 */
export function buildInspectorAiSnippet(
  tagName: string,
  id: string | null,
  classes: string[],
  rect: { width: number; height: number },
  bestSelector: string
): string {
  const label = buildInspectorElementLabel(tagName, id, classes);
  const dim = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
  return `请分析并优化这个元素 [@DOM: ${label} (${dim})]，选择器：${bestSelector}`;
}

/**
 * 判断选中元素是否带出有效 computedStyles 摘要（决定详情卡是否渲染样式行）。
 */
export function hasInspectorComputedStyles(
  el: { computedStyles?: InspectSelectPayload['computedStyles'] } | null
): boolean {
  const s = el?.computedStyles;
  return Boolean(
    s &&
      (s.display || s.position || s.fontSize || s.color || s.backgroundColor)
  );
}
