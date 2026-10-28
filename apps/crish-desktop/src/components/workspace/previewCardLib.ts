/**
 * PreviewCard 纯函数层：安全 URL 判定 + 常量与拾取辅助。
 * 从 PreviewCard.tsx 抽出，零副作用，可独立单测。
 *
 * 原生浏览器改造 Wave 2：
 * - 彻底清退历史 Vite 代理（/__crish_preview_proxy 与 /v1/preview/proxy）；
 * - 公网合法 URL（如 Google、GitHub）直接放行原始地址，不再做任何代理重定向。
 */
import {
  isAboutBlank,
  isBrowseUrlOk,
  isEmbeddablePreviewUrl,
  validateBrowseUrl,
} from '../../api/previewBrowserStore';
import { t } from '../../i18n';
import type {
  DomReferenceChipPayload,
  InspectSelectPayload,
} from './previewProtocol';

/** iframe / 网页加载卡住时收 loading，避免转圈永驻 */
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
 * 仅当可安全内嵌或导航时返回安全 URL（用于原生子 Webview 或预览视口）。
 * 非法/危险 scheme（javascript:, vbscript: 等）返回 null；
 * 合法公网与本地 HTTP/HTTPS/data: 资源直接原样返回，不再做代理重定向。
 */
export function safeIframeSrc(url: string): string | null {
  if (!url || isAboutBlank(url)) return null;
  if (url.startsWith('data:')) return url;
  const checked = validateBrowseUrl(url);
  if (!isBrowseUrlOk(checked)) return null;
  if (!isEmbeddablePreviewUrl(checked.url) || isAboutBlank(checked.url))
    return null;
  return checked.url;
}

/** 语义化别名：safeNativeUrl 与 safeIframeSrc 同义，用于原生 Webview 场景 */
export const safeNativeUrl = safeIframeSrc;

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
  return t(
    'workspace.inspector.optimizeElementPrompt',
    '请分析并优化这个元素 [@DOM: {label} ({dim})]，选择器：{bestSelector}',
    { label, dim, bestSelector }
  );
}

/** 将一次 Inspector 选择复制为完整、可持久化的 DOM 引用契约。 */
export function buildDomReferenceChipPayload(
  element: InspectSelectPayload,
  sourceUrl: string,
  pageTitle: string,
  timestamp = Date.now()
): DomReferenceChipPayload {
  const attributes = Object.fromEntries(
    Object.entries(element.attributes).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
  );

  return {
    kind: 'dom_reference',
    version: '1.0',
    target: {
      tagName: element.tagName,
      id: element.id,
      classes: [...element.classes],
      attributes,
      bestSelector: element.bestSelector,
      xpath: element.xpath,
      rect: { ...element.rect },
    },
    styles: { ...element.computedStyles },
    snapshot: {
      outerHtmlSnippet: element.outerHtmlSnippet,
      textContent: element.textContent,
    },
    meta: { sourceUrl, pageTitle, timestamp },
  };
}

/** 生成 Composer 草稿文本，代码围栏内始终保留可解析的完整 JSON。 */
export function serializeDomReferenceChipForComposer(
  payload: DomReferenceChipPayload
): string {
  // JSON 字符串中的换行会转义；反引号也转义，避免内容闭合 Markdown 代码围栏。
  const json = JSON.stringify(payload, null, 2).replace(/`/g, '\\u0060');
  return [
    t(
      'workspace.inspector.optimizeElementHeader',
      '请分析并优化以下网页元素。'
    ),
    'DOM_REFERENCE_PAYLOAD schema=DomReferenceChipPayload version=1.0',
    '```json',
    json,
    '```',
  ].join('\n');
}

/**
 * 判断选中元素是否带出有效 computedStyles 摘要（决定详情卡是否渲染样式行）。
 */
export function hasInspectorComputedStyles(
  el: { computedStyles?: InspectSelectPayload['computedStyles'] } | null
): boolean {
  const s = el?.computedStyles;
  return Boolean(
    s && (s.display || s.position || s.fontSize || s.color || s.backgroundColor)
  );
}
