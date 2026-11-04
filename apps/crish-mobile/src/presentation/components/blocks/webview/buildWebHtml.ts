// WebView 文档拼装（批 E，2026-11-03)：公式（KaTeX）/ 图（Mermaid）块的
// 本地 HTML 文档。纯函数：库源码字符串来自 generated/ 钉版生成物，文档在
// 设备本地拼装，公式 / 图文本不出设备、不请求任何第三方服务。
// 协议：渲染完成后页面经 ReactNativeWebView.postMessage 回传
//   { t: 'h', h: <内容高度> } 或 { t: 'err', m: <错误信息> }，
// 宿主（WebContentBlock）据此定高或回落原文呈现。
import { KATEX_CSS, KATEX_JS } from './generated/katex';
import { MERMAID_JS } from './generated/mermaid';

export type WebBlockKind = 'math' | 'mermaid';

export interface WebHtmlInput {
  kind: WebBlockKind;
  /** 公式 TeX 原文 / Mermaid 图原文（逐字保真，不做任何改写） */
  source: string;
  dark: boolean;
  /** 正文色（公式字色与图标签色随主题，页面底色恒透明、由宿主容器底色承担） */
  textColor: string;
}

/** 源码嵌入 <script> 的 JSON 字面量（转义 < 与行分隔符，防提前闭合） */
function scriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const BRIDGE = `
  var root = document.getElementById('root');
  function post(o) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(o));
    }
  }
  function measure() {
    var h = Math.max(root.scrollHeight, root.offsetHeight);
    post({ t: 'h', h: Math.ceil(h) });
  }
  function fail(e) {
    post({ t: 'err', m: String(e && e.message ? e.message : e) });
  }
  window.addEventListener('load', function () { setTimeout(measure, 0); });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { measure(); });
  }
`;

function mathDocument(input: WebHtmlInput): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>${KATEX_CSS}</style>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { color: ${input.textColor}; }
  #root { padding: 2px 0; }
  .katex-display { margin: 0; padding: 2px 0; overflow-x: auto; overflow-y: hidden; }
</style>
</head>
<body>
<div id="root"></div>
<script>${KATEX_JS}</script>
<script>
(function () {
  ${BRIDGE}
  try {
    katex.render(${scriptLiteral(input.source)}, root, {
      displayMode: true,
      throwOnError: true,
      trust: false,
      strict: false
    });
    measure();
  } catch (e) { fail(e); }
})();
</script>
</body>
</html>`;
}

function mermaidDocument(input: WebHtmlInput): string {
  const graphTheme = input.dark ? 'dark' : 'default';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { color: ${input.textColor}; }
  #root { padding: 2px 0; text-align: center; }
  svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
<div id="root"></div>
<script>${MERMAID_JS}</script>
<script>
(function () {
  ${BRIDGE}
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: '${graphTheme}',
      fontFamily: 'inherit'
    });
    mermaid.render('crish-graph', ${scriptLiteral(input.source)}).then(
      function (result) { root.innerHTML = result.svg; measure(); },
      function (e) { fail(e); }
    );
  } catch (e) { fail(e); }
})();
</script>
</body>
</html>`;
}

/** 块种类 → 完整 WebView 文档字符串 */
export function buildWebHtml(input: WebHtmlInput): string {
  return input.kind === 'math' ? mathDocument(input) : mermaidDocument(input);
}
