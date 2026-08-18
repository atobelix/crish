/**
 * file-preview/adapters/spreadsheet.js
 * CSV/TSV 自研解析 + XLSX/XLS 按需加载 SheetJS
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  function getBase() { return window.FilePreviewBase || {}; }
  function getSniff() { return window.FilePreviewSniff || {}; }

  /** 默认最多保留的行数（含表头） */
  var DEFAULT_MAX_ROWS = 2000;

  /** SheetJS CDN（按需动态加载，失败则诚实报错） */
  var SHEETJS_CDN =
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

  var sheetJsPromise = null;



  // ── CSV / TSV 解析（引号、转义 ""、字段内换行）────────────────

  /**
   * @param {string} text
   * @param {string} delimiter  ',' 或 '\t'
   * @returns {string[][]}
   */
  function parseDelimited(text, delimiter) {
    if (text == null) return [];
    text = String(text);
    // UTF-8 BOM
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }

    var rows = [];
    var row = [];
    var field = '';
    var i = 0;
    var len = text.length;
    var inQuotes = false;

    while (i < len) {
      var c = text.charAt(i);

      if (inQuotes) {
        if (c === '"') {
          // 转义 "" → "
          if (i + 1 < len && text.charAt(i + 1) === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += c;
        i += 1;
        continue;
      }

      if (c === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }

      if (c === delimiter) {
        row.push(field);
        field = '';
        i += 1;
        continue;
      }

      // 行结束：\r\n / \n / \r
      if (c === '\n' || c === '\r') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        i += 1;
        if (c === '\r' && i < len && text.charAt(i) === '\n') {
          i += 1;
        }
        continue;
      }

      field += c;
      i += 1;
    }

    // 末尾字段（无换行结尾）
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    // 去掉文件末尾纯空行
    while (
      rows.length > 0 &&
      rows[rows.length - 1].length === 1 &&
      rows[rows.length - 1][0] === ''
    ) {
      rows.pop();
    }

    return rows;
  }

  function delimiterFor(name, mime, textHint) {
    var ext = getSniff().extOf(name || '');
    if (ext === 'tsv') return '\t';
    if (ext === 'csv') return ',';
    var m = (mime || '').toLowerCase();
    if (m.indexOf('tab-separated') >= 0) return '\t';
    if (m === 'text/csv') return ',';
    // 启发式：首行 tab 多于逗号则视为 TSV
    if (textHint) {
      var firstLine = String(textHint).split(/\r?\n/, 1)[0] || '';
      var tabs = (firstLine.match(/\t/g) || []).length;
      var commas = (firstLine.match(/,/g) || []).length;
      if (tabs > commas) return '\t';
    }
    return ',';
  }

  /**
   * @param {string[][]} rows
   * @param {number} maxRows
   * @returns {{ rows: string[][], truncated: boolean, maxRows: number }}
   */
  function applyRowCap(rows, maxRows) {
    maxRows = maxRows > 0 ? maxRows : DEFAULT_MAX_ROWS;
    if (!rows || rows.length <= maxRows) {
      return { rows: rows || [], truncated: false, maxRows: maxRows };
    }
    return {
      rows: rows.slice(0, maxRows),
      truncated: true,
      maxRows: maxRows,
    };
  }

  /** 单元格统一为 string */
  function stringifyRows(rows) {
    return (rows || []).map(function (r) {
      if (!r || !r.length) return [''];
      return r.map(function (c) {
        if (c == null) return '';
        return String(c);
      });
    });
  }

  function isBinarySpreadsheet(name, mime) {
    var ext = getSniff().extOf(name || '');
    if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return true;
    var m = (mime || '').toLowerCase().split(';')[0].trim();
    if (
      m ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      m === 'application/vnd.ms-excel' ||
      m ===
        'application/vnd.ms-excel.sheet.macroenabled.12'
    ) {
      return true;
    }
    return false;
  }

  function isCsvLike(name, mime) {
    var ext = getSniff().extOf(name || '');
    if (ext === 'csv' || ext === 'tsv') return true;
    var m = (mime || '').toLowerCase().split(';')[0].trim();
    return m === 'text/csv' || m === 'text/tab-separated-values';
  }

  // ── SheetJS 动态加载 ──────────────────────────────────────────

  function loadSheetJS() {
    if (window.XLSX && window.XLSX.read) {
      return Promise.resolve(window.XLSX);
    }
    if (sheetJsPromise) return sheetJsPromise;

    sheetJsPromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-fp-sheetjs]');
      if (existing) {
        existing.addEventListener('load', function () {
          if (window.XLSX) resolve(window.XLSX);
          else reject(new Error('SheetJS 已加载但未暴露 XLSX 全局变量'));
        });
        existing.addEventListener('error', function () {
          sheetJsPromise = null;
          reject(new Error('SheetJS 脚本加载失败'));
        });
        return;
      }

      var script = document.createElement('script');
      script.src = SHEETJS_CDN;
      script.async = true;
      script.setAttribute('data-fp-sheetjs', '1');
      script.onload = function () {
        if (window.XLSX && window.XLSX.read) {
          resolve(window.XLSX);
        } else {
          sheetJsPromise = null;
          reject(new Error('SheetJS 已加载但未暴露 XLSX 全局变量'));
        }
      };
      script.onerror = function () {
        sheetJsPromise = null;
        reject(
          new Error('无法加载 SheetJS（网络或 CDN 不可用），xlsx 预览暂不可用')
        );
      };
      document.head.appendChild(script);
    });

    return sheetJsPromise;
  }

  /**
   * @param {ArrayBuffer} buffer
   * @param {number} maxRows
   * @returns {Promise<{ sheets: Array, truncated: boolean, maxRows: number }>}
   */
  async function parseWorkbook(buffer, maxRows) {
    var XLSX = await loadSheetJS();
    var wb;
    try {
      wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    } catch (e) {
      throw new Error(
        'Excel 文件解析失败' + (e && e.message ? '：' + e.message : '')
      );
    }

    if (!wb || !wb.SheetNames || !wb.SheetNames.length) {
      throw new Error('工作簿中没有工作表');
    }

    var anyTrunc = false;
    var sheets = wb.SheetNames.map(function (name) {
      var ws = wb.Sheets[name];
      var raw = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
      });
      var rows = stringifyRows(raw);
      var capped = applyRowCap(rows, maxRows);
      if (capped.truncated) anyTrunc = true;
      return {
        name: name || 'Sheet',
        rows: capped.rows,
        truncated: capped.truncated,
      };
    });

    return {
      sheets: sheets,
      truncated: anyTrunc || !!(sheets[0] && sheets[0].truncated),
      maxRows: maxRows,
    };
  }

  function rowsToCsv(rows) {
    return (rows || [])
      .map(function (row) {
        return (row || [])
          .map(function (cell) {
            var s = cell == null ? '' : String(cell);
            if (/[",\r\n]/.test(s)) {
              return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
          })
          .join(',');
      })
      .join('\r\n');
  }

  function buildReadyModel(norm, sheets, meta, caps) {
    meta = meta || {};
    var activeIndex = 0;
    var truncated = !!meta.truncated;
    if (sheets[0] && sheets[0].truncated) truncated = true;

    var maxRows = meta.maxRows != null ? meta.maxRows : DEFAULT_MAX_ROWS;
    var capabilities = caps || [Types.CAP.CLOSE, Types.CAP.DOWNLOAD];
    if (sheets.length > 1) {
      if (capabilities.indexOf(Types.CAP.SHEET) < 0) {
        capabilities = capabilities.concat([Types.CAP.SHEET]);
      }
    }

    var downloadBlob = norm.file || null;
    var downloadUrl = norm.url || null;
    // demo / 纯文本源：生成 CSV 供下载
    if (!downloadBlob && !downloadUrl && sheets[0]) {
      downloadBlob = new Blob([rowsToCsv(sheets[0].rows)], {
        type: 'text/csv;charset=utf-8',
      });
    }

    return Types.createModel({
      kind: Types.KIND.SPREADSHEET,
      name: norm.name,
      size: norm.size,
      mime: norm.mime,
      status: Types.STATUS.READY,
      capabilities: capabilities,
      payload: {
        sheets: sheets.map(function (s) {
          return {
            name: s.name,
            rows: s.rows,
            truncated: !!s.truncated,
          };
        }),
        activeIndex: activeIndex,
        truncated: truncated,
        maxRows: maxRows,
      },
      downloadBlob: downloadBlob,
      downloadUrl: downloadUrl,
      source: null,
    });
  }

  // ── Adapter ───────────────────────────────────────────────────

  var adapter = {
    kind: Types.KIND.SPREADSHEET,

    match: function (name, mime) {
      return (
        getSniff().sniff({ name: name, mime: mime }) === Types.KIND.SPREADSHEET
      );
    },

    load: async function (ctx) {
      var norm = getBase().normalizeSource(ctx.source);
      var maxRows = DEFAULT_MAX_ROWS;

      try {
        if (ctx.isCancelled && ctx.isCancelled()) {
          throw getBase().cancelError();
        }

        // 二进制 Excel
        if (
          isBinarySpreadsheet(norm.name, norm.mime) &&
          (norm.file || norm.url)
        ) {
          var buffer = await getBase().readBufferFromNormalized(
            norm,
            ctx.isCancelled
          );
          if (ctx.isCancelled && ctx.isCancelled()) {
            throw getBase().cancelError();
          }
          if (ctx.onProgress) ctx.onProgress(0.4);
          var parsed = await parseWorkbook(buffer, maxRows);
          if (ctx.onProgress) ctx.onProgress(1);
          var model = buildReadyModel(norm, parsed.sheets, {
            truncated: parsed.truncated,
            maxRows: parsed.maxRows,
          });
          model.source = ctx.source;
          return model;
        }

        // 无内容的二进制扩展名：不可假装解析
        if (isBinarySpreadsheet(norm.name, norm.mime) && !norm.file && !norm.url) {
          // 演示卡通常是 csv；若明确是 xlsx 且无文件则诚实失败
          if (!isCsvLike(norm.name, norm.mime) && getSniff().extOf(norm.name)) {
            return getBase().errorModel(
              norm,
              Types.KIND.SPREADSHEET,
              '当前没有可解析的 Excel 文件内容'
            );
          }
        }

        // CSV / TSV / 文本源
        var text = null;
        if (norm.file || norm.url || norm.text != null) {
          text = await getBase().readTextFromNormalized(norm, ctx.isCancelled);
        } else {
          return getBase().errorModel(
            norm,
            Types.KIND.SPREADSHEET,
            '没有可读取的表格数据'
          );
        }

        if (ctx.isCancelled && ctx.isCancelled()) {
          throw getBase().cancelError();
        }

        var delim = delimiterFor(norm.name, norm.mime, text);
        var rows = stringifyRows(parseDelimited(text, delim));
        if (!rows.length) {
          return getBase().errorModel(
            norm,
            Types.KIND.SPREADSHEET,
            '表格内容为空'
          );
        }

        var capped = applyRowCap(rows, maxRows);
        var sheetName =
          (norm.name && norm.name.replace(/\.[^.]+$/, '')) || 'Sheet1';
        var out = buildReadyModel(
          norm,
          [
            {
              name: sheetName,
              rows: capped.rows,
              truncated: capped.truncated,
            },
          ],
          { truncated: capped.truncated, maxRows: capped.maxRows }
        );
        // 文本源保留可下载
        if (!out.downloadBlob && text != null) {
          out.downloadBlob = new Blob([text], {
            type: 'text/csv;charset=utf-8',
          });
        }
        out.source = ctx.source;
        return out;
      } catch (err) {
        if (getBase().isAbort(err)) throw err;
        return getBase().errorModel(
          norm,
          Types.KIND.SPREADSHEET,
          (err && err.message) || '表格解析失败'
        );
      }
    },
  };

  // 导出解析器便于控制台/测试
  adapter.parseDelimited = parseDelimited;
  adapter.applyRowCap = applyRowCap;
  adapter.DEFAULT_MAX_ROWS = DEFAULT_MAX_ROWS;

  window.FilePreviewAdapters = window.FilePreviewAdapters || {};
  window.FilePreviewAdapters.spreadsheet = adapter;

  if (
    window.FilePreviewRouter &&
    typeof window.FilePreviewRouter.registerAdapter === 'function'
  ) {
    window.FilePreviewRouter.registerAdapter(
      Types.KIND.SPREADSHEET,
      adapter
    );
  }
})();
