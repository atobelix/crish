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
import { parseInspectedElementPayload } from './previewDomInspector';
import type { InspectSelectPayload } from './previewProtocol';

export const QUICK_LOCAL = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:8765',
] as const;

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
 */
export function toProxyPreviewUrl(url: string): string {
  if (!url || isAboutBlank(url)) return url;
  if (url.startsWith('data:') || url.startsWith('file://')) return url;
  if (url.startsWith('/__crish_preview_proxy')) return url;
  if (url.startsWith('http://127.0.0.1:8765/v1/preview/proxy')) return url;
  if (/^https?:\/\//i.test(url)) {
    if (!isLocalDevUrl(url)) {
      return `/__crish_preview_proxy?url=${encodeURIComponent(url)}`;
    }
  }
  return url;
}

/**
 * 为网页 HTML 注入 <base href="..."> 与 postMessage 导航拦截桥接脚本，
 * 确保 srcDoc 渲染时相对资源定位正确，且点击 <a> 链接时可协同通知父级。
 */
export function injectPreviewBridgeHtml(rawHtml: string, targetUrl: string): string {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  const baseTag = `<base href="${targetUrl.replace(/"/g, '&quot;')}">`;
  const bridgeScript = `<script id="__conex_preview_bridge">
(function() {
  if (window.__CONEX_PREVIEW_BRIDGE__) return;
  window.__CONEX_PREVIEW_BRIDGE__ = true;
  document.addEventListener('click', function(e) {
    try {
      var a = e.target;
      while (a && a.tagName !== 'A') {
        a = a.parentElement;
      }
      if (a && a.href && window.parent && window.parent !== window) {
        var href = a.href;
        if (href.startsWith('http://') || href.startsWith('https://')) {
          e.preventDefault();
          window.parent.postMessage({ type: 'preview:navigate', href: href }, '*');
        }
      }
    } catch (_) {}
  }, true);
})();
</script>`;

  const injection = `${baseTag}\n${bridgeScript}`;
  const lower = rawHtml.toLowerCase();
  const headIdx = lower.indexOf('<head');
  if (headIdx !== -1) {
    const headClose = lower.indexOf('>', headIdx);
    if (headClose !== -1) {
      return (
        rawHtml.slice(0, headClose + 1) +
        '\n' +
        injection +
        rawHtml.slice(headClose + 1)
      );
    }
  }

  const htmlIdx = lower.indexOf('<html');
  if (htmlIdx !== -1) {
    const htmlClose = lower.indexOf('>', htmlIdx);
    if (htmlClose !== -1) {
      return (
        rawHtml.slice(0, htmlClose + 1) +
        '\n<head>' +
        injection +
        '</head>' +
        rawHtml.slice(htmlClose + 1)
      );
    }
  }

  return `<head>${injection}</head>\n${rawHtml}`;
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

/**
 * 将 InspectedElementPayload 收敛为 INSPECT_SELECT 载荷
 * （承接 previewDomInspector 运行时 crish:dom-inspected 上报）。
 */
export function convertInspectedElementPayload(
  p: ReturnType<typeof parseInspectedElementPayload>
): InspectSelectPayload | null {
  if (!p) return null;
  return {
    tagName: p.tagName,
    id: p.id || null,
    classes: p.className
      ? p.className.trim().split(/\s+/).filter(Boolean)
      : [],
    attributes: p.attributes,
    bestSelector: p.selector,
    xpath: p.xpath,
    rect: {
      x: p.rect.x,
      y: p.rect.y,
      width: p.rect.width,
      height: p.rect.height,
    },
    computedStyles: {
      display: '',
      position: '',
      color: '',
      backgroundColor: '',
      fontSize: '',
      margin: '',
      padding: '',
    },
    outerHtmlSnippet: p.outerHtml,
    textContent: p.textContent,
  };
}
