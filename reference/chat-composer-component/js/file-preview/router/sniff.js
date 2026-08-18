/**
 * file-preview/router/sniff.js — 扩展名 / mime / card 类型 → PreviewKind
 */
(function () {
  'use strict';

  var KIND = window.FilePreviewTypes.KIND;

  var EXT_MAP = {
    png: KIND.IMAGE,
    jpg: KIND.IMAGE,
    jpeg: KIND.IMAGE,
    gif: KIND.IMAGE,
    webp: KIND.IMAGE,
    svg: KIND.IMAGE,
    bmp: KIND.IMAGE,
    avif: KIND.IMAGE,
    pdf: KIND.PDF,
    md: KIND.MARKDOWN,
    mdx: KIND.MARKDOWN,
    markdown: KIND.MARKDOWN,
    docx: KIND.DOCX,
    // 老 .doc 不走真解析，归 unknown
    xlsx: KIND.SPREADSHEET,
    xls: KIND.SPREADSHEET,
    csv: KIND.SPREADSHEET,
    tsv: KIND.SPREADSHEET,
    txt: KIND.TEXT,
    log: KIND.TEXT,
    json: KIND.TEXT,
    yml: KIND.TEXT,
    yaml: KIND.TEXT,
    xml: KIND.TEXT,
    html: KIND.TEXT,
    htm: KIND.TEXT,
    css: KIND.TEXT,
    scss: KIND.TEXT,
    less: KIND.TEXT,
    js: KIND.TEXT,
    jsx: KIND.TEXT,
    ts: KIND.TEXT,
    tsx: KIND.TEXT,
    mjs: KIND.TEXT,
    cjs: KIND.TEXT,
    py: KIND.TEXT,
    rs: KIND.TEXT,
    go: KIND.TEXT,
    java: KIND.TEXT,
    c: KIND.TEXT,
    cpp: KIND.TEXT,
    h: KIND.TEXT,
    hpp: KIND.TEXT,
    cs: KIND.TEXT,
    rb: KIND.TEXT,
    php: KIND.TEXT,
    sh: KIND.TEXT,
    bash: KIND.TEXT,
    zsh: KIND.TEXT,
    ps1: KIND.TEXT,
    sql: KIND.TEXT,
    toml: KIND.TEXT,
    ini: KIND.TEXT,
    conf: KIND.TEXT,
    env: KIND.TEXT,
    gitignore: KIND.TEXT,
    dockerfile: KIND.TEXT,
  };

  var CARD_TYPE_MAP = {
    image: KIND.IMAGE,
    pdf: KIND.PDF,
    document: KIND.DOCX,
    table: KIND.SPREADSHEET,
    markdown: KIND.MARKDOWN,
    code: KIND.TEXT,
    text: KIND.TEXT,
  };

  function extOf(name) {
    if (!name || typeof name !== 'string') return '';
    var base = name.split(/[\\/]/).pop() || '';
    // Dockerfile 等无扩展名
    if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
    var i = base.lastIndexOf('.');
    if (i < 0) return '';
    return base.slice(i + 1).toLowerCase();
  }

  function kindFromMime(mime) {
    if (!mime || typeof mime !== 'string') return null;
    var m = mime.toLowerCase().split(';')[0].trim();
    if (m.indexOf('image/') === 0) return KIND.IMAGE;
    if (m === 'application/pdf') return KIND.PDF;
    if (m === 'text/markdown' || m === 'text/x-markdown') return KIND.MARKDOWN;
    if (
      m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      m === 'application/msword'
    ) {
      return m.indexOf('openxml') >= 0 ? KIND.DOCX : KIND.UNKNOWN;
    }
    if (
      m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      m === 'application/vnd.ms-excel' ||
      m === 'text/csv' ||
      m === 'text/tab-separated-values'
    ) {
      return KIND.SPREADSHEET;
    }
    if (m.indexOf('text/') === 0 || m === 'application/json' || m === 'application/javascript') {
      return KIND.TEXT;
    }
    return null;
  }

  /**
   * @param {{ name?: string, mime?: string, cardType?: string, file?: File }} input
   * @returns {string}
   */
  function sniff(input) {
    input = input || {};
    var e = extOf(input.name || (input.file && input.file.name) || '');
    if (e && EXT_MAP[e]) return EXT_MAP[e];

    if (input.cardType && CARD_TYPE_MAP[input.cardType]) {
      return CARD_TYPE_MAP[input.cardType];
    }

    var fromMime = kindFromMime(input.mime || (input.file && input.file.type) || '');
    if (fromMime) return fromMime;

    return KIND.UNKNOWN;
  }

  function languageHint(name) {
    var e = extOf(name);
    var map = {
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      json: 'json',
      yml: 'yaml',
      yaml: 'yaml',
      md: 'markdown',
      css: 'css',
      scss: 'scss',
      html: 'html',
      htm: 'html',
      xml: 'xml',
      sql: 'sql',
      sh: 'bash',
      bash: 'bash',
      ps1: 'powershell',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      cs: 'csharp',
      rb: 'ruby',
      php: 'php',
      toml: 'toml',
      log: 'log',
      txt: 'text',
    };
    return map[e] || 'text';
  }

  window.FilePreviewSniff = {
    sniff: sniff,
    extOf: extOf,
    kindFromMime: kindFromMime,
    languageHint: languageHint,
    EXT_MAP: EXT_MAP,
  };
})();
