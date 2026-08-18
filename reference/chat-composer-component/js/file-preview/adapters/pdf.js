/**
 * file-preview/adapters/pdf.js — 真 PDF 解析（按需动态加载 pdf.js）
 *
 * - 匹配 .pdf / application/pdf
 * - 仅在 load 时注入 CDN script，不阻塞首屏
 * - Demo 卡无 live File 时使用内置极小合法多页 PDF
 * - 失败返回诚实 errorModel，禁止假 HTML 页
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  var Base = window.FilePreviewBase;
  var Sniff = window.FilePreviewSniff;

  /** pdf.js 3.x UMD，适合 script 标签场景 */
  var PDFJS_VERSION = '3.11.174';
  var PDFJS_CDN =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@' +
    PDFJS_VERSION +
    '/build/pdf.min.js';
  var PDFJS_WORKER =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@' +
    PDFJS_VERSION +
    '/build/pdf.worker.min.js';

  var loadLibPromise = null;
  var demoBufferCache = null;

  /**
   * 动态加载 pdf.js；失败抛出人话错误
   * @returns {Promise<object>} pdfjsLib
   */
  function loadPdfJs() {
    if (window.pdfjsLib) {
      ensureWorker(window.pdfjsLib);
      return Promise.resolve(window.pdfjsLib);
    }
    if (loadLibPromise) return loadLibPromise;

    loadLibPromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-fp-pdfjs]');
      if (existing) {
        // 已在加载中：轮询全局
        var tries = 0;
        var timer = setInterval(function () {
          tries += 1;
          if (window.pdfjsLib) {
            clearInterval(timer);
            ensureWorker(window.pdfjsLib);
            resolve(window.pdfjsLib);
          } else if (tries > 100) {
            clearInterval(timer);
            loadLibPromise = null;
            reject(new Error('PDF 引擎加载超时'));
          }
        }, 50);
        return;
      }

      var script = document.createElement('script');
      script.src = PDFJS_CDN;
      script.async = true;
      script.dataset.fpPdfjs = '1';
      script.onload = function () {
        if (!window.pdfjsLib) {
          loadLibPromise = null;
          reject(new Error('PDF 引擎加载后不可用'));
          return;
        }
        ensureWorker(window.pdfjsLib);
        resolve(window.pdfjsLib);
      };
      script.onerror = function () {
        loadLibPromise = null;
        script.remove();
        reject(new Error('无法加载 PDF 引擎，请检查网络后重试'));
      };
      document.head.appendChild(script);
    });

    return loadLibPromise;
  }

  function ensureWorker(pdfjsLib) {
    try {
      if (
        pdfjsLib.GlobalWorkerOptions &&
        !pdfjsLib.GlobalWorkerOptions.workerSrc
      ) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 生成 3 页极小合法 PDF（ASCII，可翻页 / 缩略图演示）
   * @returns {ArrayBuffer}
   */
  function buildDemoPdfBuffer() {
    if (demoBufferCache) return demoBufferCache;

    var body = '%PDF-1.4\n';
    var offsets = [];

    function addObj(num, content) {
      offsets[num] = body.length;
      body += num + ' 0 obj\n' + content + '\nendobj\n';
    }

    function streamObj(text) {
      var content = 'BT /F1 18 Tf 72 720 Td (' + text + ') Tj ET\n';
      return (
        '<< /Length ' +
        content.length +
        ' >>\nstream\n' +
        content +
        'endstream'
      );
    }

    addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    addObj(2, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>');
    addObj(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 6 0 R >> >> >>'
    );
    addObj(
      4,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R /Resources << /Font << /F1 6 0 R >> >> >>'
    );
    addObj(
      5,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 9 0 R /Resources << /Font << /F1 6 0 R >> >> >>'
    );
    addObj(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    addObj(7, streamObj('Demo PDF - Page 1'));
    addObj(8, streamObj('Demo PDF - Page 2'));
    addObj(9, streamObj('Demo PDF - Page 3'));

    var xrefStart = body.length;
    var xref = 'xref\n0 10\n0000000000 65535 f \n';
    for (var i = 1; i <= 9; i++) {
      var off = String(offsets[i]);
      while (off.length < 10) off = '0' + off;
      xref += off + ' 00000 n \n';
    }
    var trailer =
      'trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n' +
      xrefStart +
      '\n%%EOF\n';
    var full = body + xref + trailer;

    var bytes = new Uint8Array(full.length);
    for (var j = 0; j < full.length; j++) {
      bytes[j] = full.charCodeAt(j) & 0xff;
    }
    demoBufferCache = bytes.buffer.slice(0);
    return demoBufferCache;
  }

  /**
   * 读取源二进制；无文件时回落演示 PDF
   */
  async function resolveBuffer(norm, isCancelled) {
    if (norm.file || norm.url) {
      return Base.readBufferFromNormalized(norm, isCancelled);
    }
    // demo 卡 / 无二进制：内置迷你 PDF
    return buildDemoPdfBuffer();
  }

  var CAPS = [
    Types.CAP.CLOSE,
    Types.CAP.DOWNLOAD,
    Types.CAP.ZOOM,
    Types.CAP.PAGE,
    Types.CAP.THUMBNAILS,
  ];

  var adapter = {
    kind: Types.KIND.PDF,
    match: function (name, mime) {
      if (mime && String(mime).toLowerCase().indexOf('application/pdf') === 0) {
        return true;
      }
      return Sniff.extOf(name || '') === 'pdf';
    },
    load: async function (ctx) {
      var norm = Base.normalizeSource(ctx.source);
      var isCancelled = ctx.isCancelled || function () {
        return false;
      };

      try {
        if (isCancelled()) throw Base.cancelError();

        var pdfjsLib;
        try {
          pdfjsLib = await loadPdfJs();
        } catch (libErr) {
          return Base.errorModel(
            norm,
            Types.KIND.PDF,
            (libErr && libErr.message) || 'PDF 引擎加载失败'
          );
        }

        if (isCancelled()) throw Base.cancelError();
        if (ctx.onProgress) ctx.onProgress(0.2);

        var buffer = await resolveBuffer(norm, isCancelled);
        if (isCancelled()) throw Base.cancelError();
        if (ctx.onProgress) ctx.onProgress(0.5);

        // 魔数粗检（可选）：损坏文件给明确错误
        if (buffer && buffer.byteLength >= 4) {
          var head = new Uint8Array(buffer, 0, 5);
          var magic = String.fromCharCode(
            head[0],
            head[1],
            head[2],
            head[3]
          );
          if (magic !== '%PDF') {
            return Base.errorModel(
              norm,
              Types.KIND.PDF,
              '文件不是有效的 PDF（缺少 %PDF 头）'
            );
          }
        }

        var loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(buffer),
          // 不执行 PDF 内 JS
          isEvalSupported: false,
          useSystemFonts: true,
        });

        var pdfDocument = await loadingTask.promise;
        if (isCancelled()) {
          try {
            pdfDocument.destroy();
          } catch (e) {
            /* ignore */
          }
          throw Base.cancelError();
        }

        if (ctx.onProgress) ctx.onProgress(1);

        var numPages = pdfDocument.numPages || 0;
        if (numPages < 1) {
          try {
            pdfDocument.destroy();
          } catch (e2) {
            /* ignore */
          }
          return Base.errorModel(
            norm,
            Types.KIND.PDF,
            'PDF 不含任何页面'
          );
        }

        var downloadBlob =
          norm.file ||
          new Blob([buffer], { type: 'application/pdf' });

        return Types.createModel({
          kind: Types.KIND.PDF,
          name: norm.name,
          size: norm.size != null ? norm.size : buffer.byteLength,
          mime: norm.mime || 'application/pdf',
          status: Types.STATUS.READY,
          capabilities: CAPS.slice(),
          payload: {
            pdfDocument: pdfDocument,
            numPages: numPages,
            /** viewer destroy 时可调用 */
            dispose: function () {
              try {
                if (pdfDocument && typeof pdfDocument.destroy === 'function') {
                  pdfDocument.destroy();
                }
              } catch (e) {
                /* ignore */
              }
            },
          },
          downloadBlob: downloadBlob,
          downloadUrl: norm.url || null,
          source: ctx.source,
        });
      } catch (err) {
        if (Base.isAbort(err)) throw err;
        return Base.errorModel(
          norm,
          Types.KIND.PDF,
          (err && err.message) || 'PDF 解析失败'
        );
      }
    },
  };

  window.FilePreviewAdapters = window.FilePreviewAdapters || {};
  window.FilePreviewAdapters.pdf = adapter;
})();
