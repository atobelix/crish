/**
 * dev-server/previewBridgeScript.ts — 预览代理注入桥（audit-repair-202609 · T19 单轨化）
 *
 * ## 定位（单一真理路径）
 * 这是预览 DOM inspector 的**唯一**运行时客户端实现：由 dev server 的
 * `crishPreviewProxyPlugin` 注入到代理 HTML 的 `<head>`，因此对跨源页面
 * 同样生效。历史并存的 `installPreviewInspectorClient`（仅同源可用，与
 * 注入桥双发事件）与 `attachDomInspector` / legacy `crish:dom-inspected`
 * 协议已在 T19 清退。
 *
 * ## 消息契约（与宿主 previewProtocol.ts / previewHostBridge.ts 对齐）
 * - 宿主 → 桥：`{ source: 'crish-preview-host', type: 'INSPECT_TOGGLE', payload: { enabled } }`
 * - 桥 → 宿主：`{ source: 'crish-preview-inspector', type: 'INSPECT_READY' | 'INSPECT_TOGGLE' | 'INSPECT_HOVER' | 'INSPECT_SELECT', payload }`
 * - 桥 → 宿主（导航）：`{ type: 'preview:navigate', href }`
 * - `INSPECT_SELECT.xpath` 为**真实位置 XPath**（子索引轴），非历史伪实现
 *   的 `'//' + tag`。
 *
 * 本模块导出字符串常量，vite.config.ts 直接内联注入；纯字符串可被单测
 * 断言关键监听与消息形状（无 DOM 依赖）。
 */

export const PREVIEW_BRIDGE_SCRIPT_ID = '__conex_preview_bridge';

export const PREVIEW_BRIDGE_SCRIPT = `<script id="${PREVIEW_BRIDGE_SCRIPT_ID}">
(function() {
  if (window.__CONEX_PREVIEW_BRIDGE__) return;
  window.__CONEX_PREVIEW_BRIDGE__ = true;

  var inspectorActive = false;
  var hoveredEl = null;

  function toRect(el) {
    var r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x * 100) / 100,
      y: Math.round(r.y * 100) / 100,
      width: Math.round(r.width * 100) / 100,
      height: Math.round(r.height * 100) / 100
    };
  }

  function computeSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var classes = el.className.trim().split(/\\s+/).filter(Boolean);
      if (classes.length) return tag + '.' + classes.slice(0, 2).join('.');
    }
    return tag;
  }

  /**
   * 真实位置 XPath（子索引轴）：/html[1]/body[1]/div[2]/…
   * 修正历史伪实现（'//' + tagname 不含任何位置信息）。
   */
  function computeXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var index = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) index++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + index + ']');
      node = node.parentElement;
    }
    if (node && node.nodeType === 1) {
      parts.unshift(node.tagName.toLowerCase());
    }
    return '/' + parts.join('/');
  }

  function getComputedStyles(el) {
    var cs = window.getComputedStyle(el);
    return {
      display: cs.display || '',
      position: cs.position || '',
      color: cs.color || '',
      backgroundColor: cs.backgroundColor || '',
      fontSize: cs.fontSize || '',
      margin: cs.margin || '',
      padding: cs.padding || ''
    };
  }

  window.addEventListener('message', function(e) {
    try {
      if (!e.data || e.data.source !== 'crish-preview-host') return;
      if (e.data.type === 'INSPECT_TOGGLE') {
        inspectorActive = Boolean(e.data.payload && e.data.payload.enabled);
        if (!inspectorActive) {
          hoveredEl = null;
        }
      }
    } catch (_) {}
  });

  window.addEventListener('pointermove', function(e) {
    if (!inspectorActive) return;
    try {
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === hoveredEl || el === document.documentElement || el === document.body) return;
      hoveredEl = el;
      var sel = computeSelector(el);
      var rect = toRect(el);
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          source: 'crish-preview-inspector',
          type: 'INSPECT_HOVER',
          payload: {
            tagName: el.tagName.toLowerCase(),
            selector: sel,
            rect: rect
          }
        }, '*');
      }
    } catch (_) {}
  }, true);

  window.addEventListener('keydown', function(e) {
    if (!inspectorActive) return;
    if (e.key === 'Escape') {
      inspectorActive = false;
      hoveredEl = null;
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            source: 'crish-preview-inspector',
            type: 'INSPECT_TOGGLE',
            payload: { enabled: false }
          }, '*');
        }
      } catch (_) {}
    }
  }, true);

  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        source: 'crish-preview-inspector',
        type: 'INSPECT_READY',
        payload: {}
      }, '*');
    }
  } catch (_) {}

  document.addEventListener('click', function(e) {
    if (inspectorActive) {
      e.preventDefault();
      e.stopPropagation();
      try {
        var el = e.target;
        if (!el || el.nodeType !== 1) return;
        var tag = el.tagName.toLowerCase();
        var id = el.id || null;
        var classes = (typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean) : []);
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          var a = el.attributes[i];
          attrs[a.name] = a.value;
        }
        var bestSelector = computeSelector(el);
        var rect = toRect(el);
        var computedStyles = getComputedStyles(el);
        var outer = el.outerHTML || '';
        var outerSnippet = outer.length > 500 ? outer.slice(0, 500) + '...' : outer;
        var text = (el.textContent || '').trim().slice(0, 200);

        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            source: 'crish-preview-inspector',
            type: 'INSPECT_SELECT',
            payload: {
              tagName: tag,
              id: id,
              classes: classes,
              attributes: attrs,
              bestSelector: bestSelector,
              xpath: computeXPath(el),
              rect: rect,
              computedStyles: computedStyles,
              outerHtmlSnippet: outerSnippet,
              textContent: text
            }
          }, '*');
        }
      } catch (_) {}
      return;
    }

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
  document.addEventListener('submit', function(e) {
    try {
      var form = e.target;
      if (form && form.tagName === 'FORM' && window.parent && window.parent !== window) {
        var action = form.action || window.location.href;
        if ((form.method || 'GET').toUpperCase() === 'GET') {
          var formData = new FormData(form);
          var params = new URLSearchParams(formData);
          var fullUrl = action + (action.indexOf('?') === -1 ? '?' : '&') + params.toString();
          e.preventDefault();
          window.parent.postMessage({ type: 'preview:navigate', href: fullUrl }, '*');
        }
      }
    } catch (_) {}
  }, true);
})();
</script>`;
