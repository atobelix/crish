/**
 * markdown-editor/blocks/mermaid.js — Mermaid 读态 / 源码表面
 * 导出 window.MdxBlocksMermaid
 *
 * W7 / F-MMD-CORE：
 * - 首选模型：code + lang=mermaid（fence ```mermaid）；亦兼容 type=mermaid
 * - 读态：window.mermaid 可用 → SVG；否则 clean pre.mdx-mermaid-fallback（无「点击渲染」文案）
 * - 编辑：复用代码 fence 单表面（MdxBlocksCode / CodeEdit）
 * - 不把 mermaid 打进 core；宿主可可选加载 CDN
 */
(function () {
  'use strict';

  var _seq = 0;
  var _inited = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isMermaidLang(lang) {
    return String(lang || '')
      .trim()
      .toLowerCase() === 'mermaid';
  }

  /**
   * @param {object} block
   * @returns {boolean}
   */
  function isMermaidBlock(block) {
    if (!block) return false;
    if (block.type === 'mermaid') return true;
    if (block.type === 'code' && isMermaidLang(block.lang)) return true;
    return false;
  }

  /**
   * 规范化为 code 形态（编辑 / 序列化共用）
   * @param {object} block
   * @returns {{ type: string, lang: string, text: string, id?: string }}
   */
  function asCodeBlock(block) {
    block = block || {};
    return {
      id: block.id,
      type: 'code',
      lang: 'mermaid',
      text: block.text != null ? String(block.text) : '',
    };
  }

  function fenceSource(block) {
    var Code = window.MdxBlocksCode;
    if (Code && typeof Code.fenceSource === 'function') {
      return Code.fenceSource(asCodeBlock(block));
    }
    var text = block && block.text != null ? String(block.text) : '';
    return '```mermaid\n' + text.replace(/\n$/, '') + '\n```';
  }

  /**
   * 源码态 HTML：与代码块同一卡壳
   * @param {object} block
   * @returns {string}
   */
  function sourceHtml(block) {
    var Code = window.MdxBlocksCode;
    if (Code && typeof Code.sourceHtml === 'function') {
      return Code.sourceHtml(asCodeBlock(block));
    }
    var src = fenceSource(block);
    return (
      '<div class="mdx-code-card is-source" data-mdx-code-card data-mode="source" data-lang="mermaid">' +
      '<pre class="mdx-code-source-pre mdx-code-card__pre" data-mdx-edit data-mdx-code-source ' +
      'contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" ' +
      'aria-label="Mermaid 源码">' +
      esc(src) +
      '</pre></div>'
    );
  }

  /**
   * 读态：容器 + 源码 pre（hydrate 后换成 SVG）
   * 无 mermaid 时即干净 fallback 源码，无长篇提示
   * @param {object} block
   * @returns {string}
   */
  function readHtml(block) {
    block = block || {};
    var raw = block.text != null ? String(block.text) : '';
    var hasLib = !!(window.mermaid && typeof window.mermaid.render === 'function');
    return (
      '<div class="mdx-mermaid" data-mdx-mermaid data-mode="read" data-hydrated="' +
      (hasLib ? 'pending' : '0') +
      '" aria-label="Mermaid 图">' +
      '<pre class="mdx-mermaid-fallback" data-mdx-mermaid-source spellcheck="false">' +
      esc(raw) +
      '</pre>' +
      '</div>'
    );
  }

  function ensureInit() {
    if (_inited) return;
    var m = window.mermaid;
    if (!m) return;
    try {
      if (typeof m.initialize === 'function') {
        m.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
        });
      }
    } catch (e) {
      /* ignore re-init */
    }
    _inited = true;
  }

  function uniqueId() {
    _seq += 1;
    return 'mdx-mmd-' + Date.now().toString(36) + '-' + _seq;
  }

  /**
   * 将单个 .mdx-mermaid 容器 hydrate 为 SVG（若 mermaid 可用）
   * @param {HTMLElement} el
   * @returns {boolean} 是否启动了渲染
   */
  function hydrate(el) {
    if (!el || !el.getAttribute) return false;
    if (el.getAttribute('data-hydrated') === '1') return true;
    var m = window.mermaid;
    if (!m || typeof m.render !== 'function') {
      el.setAttribute('data-hydrated', '0');
      return false;
    }

    var srcEl = el.querySelector('[data-mdx-mermaid-source]');
    var text = srcEl
      ? (srcEl.textContent || '').replace(/\u00a0/g, ' ')
      : '';
    if (!String(text).trim()) {
      el.setAttribute('data-hydrated', '1');
      return true;
    }

    ensureInit();
    var id = uniqueId();
    el.setAttribute('data-hydrated', 'pending');
    el.classList.add('is-rendering');

    function applySvg(svg) {
      if (!el.isConnected) return;
      el.classList.remove('is-rendering', 'is-error');
      el.setAttribute('data-hydrated', '1');
      if (!svg) {
        // 保留 fallback pre
        return;
      }
      var wrap = document.createElement('div');
      wrap.className = 'mdx-mermaid__svg';
      wrap.setAttribute('data-cx-no-edit', '');
      wrap.innerHTML = svg;
      // 清空后只留 SVG（源码在 data 上保留便于调试）
      el.setAttribute('data-mdx-mermaid-text', text);
      el.innerHTML = '';
      el.appendChild(wrap);
    }

    function applyError() {
      if (!el.isConnected) return;
      el.classList.remove('is-rendering');
      el.classList.add('is-error');
      el.setAttribute('data-hydrated', '0');
      // 保留 pre 源码；不塞长文案
      if (!el.querySelector('[data-mdx-mermaid-source]') && srcEl) {
        el.innerHTML = '';
        el.appendChild(srcEl);
      }
    }

    try {
      var result = m.render(id, text);
      if (result && typeof result.then === 'function') {
        result.then(
          function (r) {
            var svg = typeof r === 'string' ? r : r && r.svg;
            applySvg(svg || '');
          },
          function () {
            applyError();
          }
        );
        return true;
      }
      if (typeof result === 'string') {
        applySvg(result);
        return true;
      }
      // 旧 API: render(id, text, cb)
      if (m.render.length >= 3) {
        m.render(id, text, function (svgCode) {
          applySvg(svgCode || '');
        });
        return true;
      }
      applyError();
      return false;
    } catch (err) {
      applyError();
      return false;
    }
  }

  /**
   * 在 root 下查找并 hydrate 所有 mermaid 容器
   * @param {ParentNode} [root]
   */
  function hydrateAll(root) {
    var scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    var list = scope.querySelectorAll('[data-mdx-mermaid]');
    for (var i = 0; i < list.length; i++) {
      hydrate(list[i]);
    }
  }

  function register() {
    var Reg = window.MdxRegistry;
    if (!Reg || typeof Reg.register !== 'function') return;
    Reg.register({
      type: 'mermaid',
      toMarkdown: function (b) {
        return fenceSource(b);
      },
      renderRead: function (b) {
        return readHtml(b);
      },
      renderEdit: function (b) {
        return sourceHtml(b);
      },
      slash: {
        id: 'mermaid',
        title: 'Mermaid 图',
        aliases: ['mermaid', 'diagram', 'flowchart', '图表'],
        section: '高级',
      },
    });
  }

  window.MdxBlocksMermaid = {
    isMermaidBlock: isMermaidBlock,
    isMermaidLang: isMermaidLang,
    asCodeBlock: asCodeBlock,
    fenceSource: fenceSource,
    readHtml: readHtml,
    sourceHtml: sourceHtml,
    hydrate: hydrate,
    hydrateAll: hydrateAll,
    register: register,
  };

  // 自注册（若 registry 已加载）
  try {
    register();
  } catch (e) {
    /* ignore */
  }
})();
