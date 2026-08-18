/**
 * file-preview/adapters/docx.js — Word (.docx) 真解析
 *
 * - 仅匹配 .docx（老 .doc → 诚实 unsupported）
 * - 按需动态加载 mammoth.browser（CDN）
 * - arrayBuffer → mammoth.convertToHtml → 消毒 HTML
 * - Demo 无 live File：内置中文示例 HTML，走真 DocxViewer 路径
 * - capabilities: close, download
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  var Base = window.FilePreviewBase;

  var MAMMOTH_CDN =
    'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
  var DOMPURIFY_CDN =
    'https://cdn.jsdelivr.net/npm/dompurify@3.1.7/dist/purify.min.js';

  var loadMammothPromise = null;
  var loadPurifyPromise = null;

  /**
   * Demo 文章（已是静态安全 HTML；插入前仍会再消毒）
   * 用于无 live File 的附件卡，走 DocxViewer 真路径，不假装 PDF。
   */
  var DEMO_HTML =
    '<h1>项目需求说明书</h1>' +
    '<p><strong>文档状态</strong>：草稿 · <strong>版本</strong>：v0.9 · ' +
    '<strong>作者</strong>：产品组</p>' +
    '<h2>1. 背景与目标</h2>' +
    '<p>本说明书描述 Conex 对话工作台中「文件预览」能力的产品范围。' +
    '目标是在浏览器内对常见附件提供<strong>真实解析</strong>与可读排版，' +
    '解析失败时诚实降级，禁止用假页面冒充成功。</p>' +
    '<h2>2. 范围</h2>' +
    '<ul>' +
    '<li>支持格式：Markdown、PDF、DOCX、CSV/XLSX、图片、纯文本</li>' +
    '<li>查看优先：滚动、选中复制、下载与关闭</li>' +
    '<li>不在本阶段：完整在线协作编辑 Office、服务端转换管道</li>' +
    '</ul>' +
    '<h2>3. DOCX 预览约定</h2>' +
    '<p>DOCX 使用 mammoth 转为 HTML，经消毒后插入阅读区。' +
    '老格式 <code>.doc</code> 明确提示不支持，并提供下载。</p>' +
    '<h3>3.1 安全要求</h3>' +
    '<ol>' +
    '<li>剥离 <code>script</code> / <code>iframe</code> 等危险标签</li>' +
    '<li>移除所有 <code>on*</code> 事件属性</li>' +
    '<li>拦截 <code>javascript:</code> 协议 URL</li>' +
    '</ol>' +
    '<h2>4. 验收要点</h2>' +
    '<table>' +
    '<thead><tr><th>场景</th><th>期望</th></tr></thead>' +
    '<tbody>' +
    '<tr><td>真 .docx 文件</td><td>文章版式可读</td></tr>' +
    '<tr><td>Demo 附件卡</td><td>显示本示例文章（非假 PDF）</td></tr>' +
    '<tr><td>.doc 老格式</td><td>unsupported + 可下载</td></tr>' +
    '</tbody>' +
    '</table>' +
    '<p style="color:#5a5a5a;font-size:13px;margin-top:1.5em">' +
    '— 以上为演示内容，上传真实 .docx 后将显示解析结果 —</p>';

  function isDocxName(name) {
    var n = String(name || '').toLowerCase();
    return n.length > 5 && n.slice(-5) === '.docx';
  }

  function isLegacyDocName(name) {
    var n = String(name || '').toLowerCase();
    // .doc 但不是 .docx
    return n.length > 4 && n.slice(-4) === '.doc' && !isDocxName(n);
  }

  function isDocxMime(mime) {
    if (!mime) return false;
    var m = String(mime).toLowerCase().split(';')[0].trim();
    return (
      m ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      m ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.template'
    );
  }

  function isLegacyDocMime(mime) {
    if (!mime) return false;
    var m = String(mime).toLowerCase().split(';')[0].trim();
    return m === 'application/msword';
  }

  /**
   * 动态加载 script（带 data 标记防重复）
   */
  function loadScript(url, dataKey) {
    return new Promise(function (resolve, reject) {
      var sel = 'script[data-fp-' + dataKey + ']';
      var existing = document.querySelector(sel);
      if (existing) {
        // 已在加载：短轮询等待
        var tries = 0;
        var timer = setInterval(function () {
          tries += 1;
          if (existing.dataset.fpLoaded === '1' || checkGlobal(dataKey)) {
            clearInterval(timer);
            resolve();
          } else if (tries > 100) {
            clearInterval(timer);
            reject(new Error('脚本加载超时'));
          }
        }, 50);
        return;
      }
      var script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.setAttribute('data-fp-' + dataKey, '1');
      script.onload = function () {
        script.dataset.fpLoaded = '1';
        resolve();
      };
      script.onerror = function () {
        script.remove();
        reject(new Error('无法加载依赖脚本，请检查网络后重试'));
      };
      document.head.appendChild(script);
    });
  }

  function checkGlobal(key) {
    if (key === 'mammoth') return !!(window.mammoth && window.mammoth.convertToHtml);
    if (key === 'dompurify') return !!window.DOMPurify;
    return false;
  }

  function loadMammoth() {
    if (window.mammoth && typeof window.mammoth.convertToHtml === 'function') {
      return Promise.resolve(window.mammoth);
    }
    if (loadMammothPromise) return loadMammothPromise;
    loadMammothPromise = loadScript(MAMMOTH_CDN, 'mammoth')
      .then(function () {
        if (!window.mammoth || typeof window.mammoth.convertToHtml !== 'function') {
          loadMammothPromise = null;
          throw new Error('DOCX 引擎加载后不可用');
        }
        return window.mammoth;
      })
      .catch(function (err) {
        loadMammothPromise = null;
        throw err;
      });
    return loadMammothPromise;
  }

  function loadDomPurify() {
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
      return Promise.resolve(window.DOMPurify);
    }
    if (loadPurifyPromise) return loadPurifyPromise;
    loadPurifyPromise = loadScript(DOMPURIFY_CDN, 'dompurify')
      .then(function () {
        if (!window.DOMPurify) {
          // 失败不致命：走最小 sanitize
          loadPurifyPromise = null;
          return null;
        }
        return window.DOMPurify;
      })
      .catch(function () {
        loadPurifyPromise = null;
        return null;
      });
    return loadPurifyPromise;
  }

  /**
   * 最小 HTML 消毒（无 DOMPurify 时的兜底）
   * - 去掉 script/iframe/object/embed/form/base/link/meta
   * - 去掉 on* 事件属性
   * - 去掉 javascript: / vbscript: / data:text/html URL
   */
  function minimalSanitize(html) {
    var raw = String(html || '');
    var doc;
    try {
      doc = new DOMParser().parseFromString(
        '<!DOCTYPE html><html><body>' + raw + '</body></html>',
        'text/html'
      );
    } catch (e) {
      return '';
    }
    var body = doc.body;
    if (!body) return '';

    var killTags = [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'base',
      'link',
      'meta',
      'svg',
      'math',
    ];
    killTags.forEach(function (tag) {
      var nodes = body.querySelectorAll(tag);
      for (var i = nodes.length - 1; i >= 0; i--) {
        nodes[i].parentNode && nodes[i].parentNode.removeChild(nodes[i]);
      }
    });

    var all = body.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var attrs = Array.prototype.slice.call(el.attributes || []);
      for (var k = 0; k < attrs.length; k++) {
        var name = attrs[k].name;
        var value = attrs[k].value || '';
        var lname = name.toLowerCase();
        if (lname.indexOf('on') === 0) {
          el.removeAttribute(name);
          continue;
        }
        if (
          lname === 'href' ||
          lname === 'src' ||
          lname === 'xlink:href' ||
          lname === 'action' ||
          lname === 'formaction'
        ) {
          var v = String(value).replace(/[\u0000-\u001f\s]+/g, '').toLowerCase();
          if (
            v.indexOf('javascript:') === 0 ||
            v.indexOf('vbscript:') === 0 ||
            v.indexOf('data:text/html') === 0
          ) {
            el.removeAttribute(name);
          }
        }
        // 禁止 style 中的 expression / url(javascript
        if (lname === 'style') {
          var s = String(value).toLowerCase();
          if (
            s.indexOf('expression(') >= 0 ||
            s.indexOf('javascript:') >= 0 ||
            s.indexOf('vbscript:') >= 0
          ) {
            el.removeAttribute(name);
          }
        }
      }
    }

    return body.innerHTML;
  }

  /**
   * @param {string} html
   * @returns {Promise<string>}
   */
  async function sanitizeHtml(html) {
    var purify = await loadDomPurify();
    if (purify && typeof purify.sanitize === 'function') {
      try {
        return purify.sanitize(String(html || ''), {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base'],
          FORBID_ATTR: ['srcdoc'],
        });
      } catch (e) {
        /* fall through */
      }
    }
    return minimalSanitize(html);
  }

  /**
   * @param {ArrayBuffer} buffer
   * @returns {Promise<string>} 已消毒 HTML
   */
  async function convertDocxBuffer(buffer) {
    var mammoth = await loadMammoth();
    var result = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      {
        // 忽略嵌入脚本类资源；样式映射保持默认
        includeDefaultStyleMap: true,
      }
    );
    var html = (result && result.value) || '';
    return sanitizeHtml(html);
  }

  function readyModel(norm, html, caps) {
    return Types.createModel({
      kind: Types.KIND.DOCX,
      name: norm.name,
      size: norm.size,
      mime:
        norm.mime ||
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      status: Types.STATUS.READY,
      capabilities: caps || [Types.CAP.CLOSE, Types.CAP.DOWNLOAD],
      payload: { html: html },
      downloadBlob: norm.file || null,
      downloadUrl: norm.url || null,
      source: null,
    });
  }

  var adapter = {
    kind: Types.KIND.DOCX,

    /**
     * 仅 .docx / openxml word mime；.doc 明确不匹配
     */
    match: function (name, mime) {
      if (isLegacyDocName(name) || isLegacyDocMime(mime)) return false;
      if (isDocxName(name) || isDocxMime(mime)) return true;
      return false;
    },

    load: async function (ctx) {
      var norm = Base.normalizeSource(ctx.source);
      var caps = [Types.CAP.CLOSE, Types.CAP.DOWNLOAD];

      // 老 .doc：诚实失败
      if (isLegacyDocName(norm.name) || isLegacyDocMime(norm.mime)) {
        return Types.createModel({
          kind: Types.KIND.DOCX,
          name: norm.name,
          size: norm.size,
          mime: norm.mime || 'application/msword',
          status: Types.STATUS.ERROR,
          errorMessage:
            '不支持老版 Word 格式（.doc），请另存为 .docx 后打开',
          capabilities: [Types.CAP.CLOSE, Types.CAP.DOWNLOAD],
          payload: {
            name: norm.name,
            size: norm.size,
            mime: norm.mime,
            unsupported: true,
          },
          downloadBlob: norm.file || null,
          downloadUrl: norm.url || null,
          source: ctx.source,
        });
      }

      try {
        // 无 live 内容：演示文章
        if (!norm.file && !norm.url) {
          if (ctx.isCancelled && ctx.isCancelled()) throw Base.cancelError();
          var demoHtml = await sanitizeHtml(DEMO_HTML);
          return readyModel(norm, demoHtml, [Types.CAP.CLOSE, Types.CAP.DOWNLOAD]);
        }

        if (ctx.onProgress) ctx.onProgress(0.1);
        var buffer = await Base.readBufferFromNormalized(norm, ctx.isCancelled);
        if (ctx.isCancelled && ctx.isCancelled()) throw Base.cancelError();
        if (ctx.onProgress) ctx.onProgress(0.45);

        var html = await convertDocxBuffer(buffer);
        if (ctx.isCancelled && ctx.isCancelled()) throw Base.cancelError();
        if (ctx.onProgress) ctx.onProgress(1);

        if (!html || !String(html).replace(/\s+/g, '')) {
          return Base.errorModel(
            norm,
            Types.KIND.DOCX,
            '文档内容为空或无法解析',
            caps
          );
        }

        return readyModel(norm, html, caps);
      } catch (err) {
        if (Base.isAbort(err)) throw err;
        return Base.errorModel(
          norm,
          Types.KIND.DOCX,
          (err && err.message) || 'DOCX 解析失败',
          caps
        );
      }
    },
  };

  window.FilePreviewAdapters = window.FilePreviewAdapters || {};
  window.FilePreviewAdapters.docx = adapter;

  // 若 Router 已就绪，主动注册
  if (window.FilePreviewRouter && window.FilePreviewRouter.registerAdapter) {
    window.FilePreviewRouter.registerAdapter(Types.KIND.DOCX, adapter);
  }
  if (window.FilePreview && window.FilePreview.registerAdapter) {
    window.FilePreview.registerAdapter(Types.KIND.DOCX, adapter);
  }
})();
