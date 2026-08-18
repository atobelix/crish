/**
 * markdown-editor/ui/code-highlight.js — 轻量语法着色（无强制 CDN）
 * 挂到 MdxUtil.highlightCode；可选后续换 shiki/prism peer
 *
 * Token classes: mdx-tok-kw | mdx-tok-string | mdx-tok-comment |
 *                mdx-tok-number | mdx-tok-fn | mdx-tok-diff-*
 * XSS：先 esc 再包 span
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  var KEYWORDS = {
    javascript:
      'break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|async|await|of|from|as',
    typescript:
      'break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|async|await|of|from|as|type|interface|enum|implements|private|public|protected|readonly|abstract|namespace|declare|keyof|infer',
    python:
      'False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield',
    rust:
      'as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while',
    go: 'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var',
    java:
      'abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while',
    csharp:
      'abstract|as|base|bool|break|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|goto|if|implicit|in|int|interface|internal|is|lock|long|namespace|new|null|object|operator|out|override|params|private|protected|public|readonly|ref|return|sbyte|sealed|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unsafe|ushort|using|virtual|void|volatile|while|async|await|var|dynamic|nameof|when|record|init|required',
    sql: 'select|from|where|and|or|insert|into|values|update|set|delete|create|table|index|join|left|right|inner|outer|on|group|by|order|limit|as|in|is|null|not|distinct|having|union|all',
    shell:
      'if|then|else|elif|fi|for|while|do|done|case|esac|function|in|select|time|until|echo|exit|export|readonly|return|shift|test|trap|unset|local',
    bash:
      'if|then|else|elif|fi|for|while|do|done|case|esac|function|in|select|time|until|echo|exit|export|readonly|return|shift|test|trap|unset|local',
    ruby:
      'BEGIN|END|alias|and|begin|break|case|class|def|defined|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield',
    php: 'abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield',
    kotlin:
      'as|break|class|continue|do|else|false|for|fun|if|in|interface|is|null|object|package|return|super|this|throw|true|try|typealias|typeof|val|var|when|while|by|catch|constructor|delegate|dynamic|field|file|finally|get|import|init|param|property|receiver|set|setparam|where|actual|abstract|annotation|companion|const|crossinline|data|enum|expect|external|final|infix|inline|inner|internal|lateinit|noinline|open|operator|out|override|private|protected|public|reified|sealed|suspend|tailrec|value|vararg',
    json: '',
    yaml: 'true|false|null|yes|no',
    yml: 'true|false|null|yes|no',
    toml: 'true|false',
    css: 'important|from|to',
    html: '',
    xml: '',
    markdown: '',
    mermaid: '',
    c: 'auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|_Bool|_Complex|_Imaginary',
    cpp: 'alignas|alignof|and|and_eq|asm|auto|bitand|bitor|bool|break|case|catch|char|class|compl|const|constexpr|const_cast|continue|decltype|default|delete|do|double|dynamic_cast|else|enum|explicit|export|extern|false|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|noexcept|not|not_eq|nullptr|operator|or|or_eq|private|protected|public|register|reinterpret_cast|return|short|signed|sizeof|static|static_assert|static_cast|struct|switch|template|this|thread_local|throw|true|try|typedef|typeid|typename|union|unsigned|using|virtual|void|volatile|wchar_t|while|xor|xor_eq',
  };

  function normLang(lang) {
    var l = String(lang || '')
      .toLowerCase()
      .trim();
    if (l === 'js' || l === 'jsx' || l === 'mjs' || l === 'cjs') return 'javascript';
    if (l === 'ts' || l === 'tsx') return 'typescript';
    if (l === 'py') return 'python';
    if (l === 'rs') return 'rust';
    if (l === 'sh' || l === 'zsh' || l === 'bash') return 'shell';
    if (l === 'c++' || l === 'cxx' || l === 'h' || l === 'hpp') return 'cpp';
    if (l === 'cs' || l === 'c#') return 'csharp';
    if (l === 'rb') return 'ruby';
    if (l === 'kt' || l === 'kts') return 'kotlin';
    if (l === 'md' || l === 'markdown') return 'markdown';
    if (l === 'yml') return 'yaml';
    if (l === 'htm' || l === 'svg') return 'html';
    if (l === 'patch') return 'diff';
    if (l === 'golang') return 'go';
    if (l === 'plaintext' || l === 'plain' || l === 'txt' || l === 'text') return 'text';
    return l;
  }

  /**
   * Diff / patch 行级着色（保留 +/- 前缀）
   */
  function highlightDiff(escaped) {
    var lines = escaped.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var ch = line.charAt(0);
      if (ch === '+') {
        lines[i] = '<span class="mdx-tok-diff-add">' + line + '</span>';
      } else if (ch === '-') {
        lines[i] = '<span class="mdx-tok-diff-del">' + line + '</span>';
      } else if (line.indexOf('@@') === 0 || ch === '\\') {
        lines[i] = '<span class="mdx-tok-diff-meta">' + line + '</span>';
      }
    }
    return lines.join('\n');
  }

  /**
   * Markdown 轻量：heading / fence 行
   */
  function highlightMarkdown(escaped) {
    var lines = escaped.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^#{1,6}\s/.test(line)) {
        lines[i] = '<span class="mdx-tok-kw">' + line + '</span>';
      } else if (/^```/.test(line) || /^~~~/.test(line)) {
        lines[i] = '<span class="mdx-tok-comment">' + line + '</span>';
      } else if (/^&gt;\s?/.test(line)) {
        lines[i] = '<span class="mdx-tok-comment">' + line + '</span>';
      }
    }
    var t = lines.join('\n');
    t = t.replace(/`([^`\n]+)`/g, '<span class="mdx-tok-string">`$1`</span>');
    return t;
  }

  /**
   * @param {string} code
   * @param {string} [lang]
   * @returns {string} HTML (已转义 + span)
   */
  function highlightCode(code, lang) {
    var src = String(code == null ? '' : code);
    if (!src) return '';
    var L = normLang(lang);

    // 超大 body 降级（F-CODE-PERF 软限）
    if (src.length > 100000) {
      return esc(src.slice(0, 100000)) + '\n<span class="mdx-tok-comment">/* …highlight truncated */</span>';
    }

    // 先整段转义，再在转义文本上做安全着色
    var t = esc(src);

    if (L === 'diff') {
      return highlightDiff(t);
    }
    if (L === 'markdown') {
      return highlightMarkdown(t);
    }
    if (L === 'text' || L === 'mermaid' || L === '') {
      // plaintext / mermaid（W7 前当代码）：等宽原样，仅 esc
      if (L === 'text' || L === '') return t;
      // mermaid：关键字弱提示
      t = t.replace(
        /\b(flowchart|graph|sequenceDiagram|erDiagram|stateDiagram-v2|stateDiagram|classDiagram|timeline|pie|gantt)\b/g,
        '<span class="mdx-tok-kw">$1</span>'
      );
      t = t.replace(/(^|\n)(\s*)(%%.*)/g, function (_, a, sp, c) {
        return a + sp + '<span class="mdx-tok-comment">' + c + '</span>';
      });
      return t;
    }

    // 注释
    if (
      L === 'python' ||
      L === 'yaml' ||
      L === 'yml' ||
      L === 'shell' ||
      L === 'bash' ||
      L === 'ruby' ||
      L === 'toml'
    ) {
      t = t.replace(/(^|\n)(\s*)(#.*)/g, function (_, a, sp, c) {
        return a + sp + '<span class="mdx-tok-comment">' + c + '</span>';
      });
    } else if (L === 'sql') {
      t = t.replace(/(--[^\n]*)/g, '<span class="mdx-tok-comment">$1</span>');
      t = t.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="mdx-tok-comment">$1</span>');
    } else if (L !== 'html' && L !== 'xml' && L !== 'json') {
      t = t.replace(/(\/\/[^\n]*)/g, '<span class="mdx-tok-comment">$1</span>');
      t = t.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="mdx-tok-comment">$1</span>');
    }

    // 字符串 "..." '...' （转义后）
    t = t.replace(/&quot;(?:[^&]|\\.)*?&quot;/g, function (m) {
      return '<span class="mdx-tok-string">' + m + '</span>';
    });
    t = t.replace(/&#39;(?:[^&]|\\.)*?&#39;/g, function (m) {
      return '<span class="mdx-tok-string">' + m + '</span>';
    });
    t = t.replace(/`(?:[^`\\]|\\.)*`/g, function (m) {
      return '<span class="mdx-tok-string">' + m + '</span>';
    });

    // 数字
    t = t.replace(
      /\b(\d+(?:\.\d+)?)\b/g,
      '<span class="mdx-tok-number">$1</span>'
    );

    // 关键字
    var kw = KEYWORDS[L];
    if (kw) {
      var re = new RegExp('\\b(' + kw + ')\\b', 'g');
      t = t.replace(re, '<span class="mdx-tok-kw">$1</span>');
    }

    // 函数名 foo(
    if (L !== 'json' && L !== 'yaml' && L !== 'css' && L !== 'html' && L !== 'xml') {
      t = t.replace(
        /\b([A-Za-z_][\w]*)\s*(?=\()/g,
        '<span class="mdx-tok-fn">$1</span>'
      );
    }

    // JSON keys（弱）
    if (L === 'json') {
      t = t.replace(
        /&quot;([^&]*)&quot;(\s*:)/g,
        '<span class="mdx-tok-kw">&quot;$1&quot;</span>$2'
      );
    }

    return t;
  }

  /**
   * 行内 live marks 已迁至 inline/live-marks.js（MdxLiveMarks / MdxUtil.applyLiveMarks）。
   * 此处仅保留代码高亮，避免覆盖 W4 实现。
   */
  function install() {
    if (!window.MdxUtil) window.MdxUtil = {};
    window.MdxUtil.highlightCode = highlightCode;
    window.MdxUtil.normLang = normLang;
    // 不覆盖 applyLiveMarks：由 util 委托 MdxLiveMarks
  }
  install();

  window.MdxCodeHighlight = {
    highlightCode: highlightCode,
    normLang: normLang,
  };
})();
