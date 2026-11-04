// 封口代码块语法高亮（批 E，2026-11-03)：纯词法分词，不依赖第三方高亮库。
// 口径：
// - 只对**封口**代码块调用（呈现层把关）：流式尾块保持等宽原文（MD 教义），
//   封口后一次性着色，无中间态；
// - 无损：任意输入下 tokens 顺序拼接 === 原文（单测钉死)，着色只加角色、
//   不改一字；无文法（未知语言 / 无标注 / markdown 等散文围栏）返回 null，
//   调用方按原文呈现——宁可不着色，不乱着色；
// - 文法集按 agent 实际产出收敛：JS/TS 家族、JSON、Python、Rust、Go、
//   Shell、C 家族（c/cpp/java/csharp)、SQL、CSS、HTML、配置（yaml/toml/ini)、
//   diff。每种文法只做词法层（注释 / 字符串 / 数字 / 关键字 / 函数调用 /
//   类型名 / 常量），不做语法分析；已知近似：Rust 字符字面量与生命周期靠
//   形态消歧、模板字符串不解析内插、CSS 属性名靠括号深度判定。
export type CodeTokenRole =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'constant'
  | 'property'
  | 'tag'
  | 'inserted'
  | 'deleted';

export interface CodeToken {
  text: string;
  role: CodeTokenRole;
}

type GrammarId =
  | 'js'
  | 'json'
  | 'python'
  | 'rust'
  | 'go'
  | 'bash'
  | 'c'
  | 'cpp'
  | 'java'
  | 'csharp'
  | 'sql'
  | 'css'
  | 'html'
  | 'config'
  | 'diff';

const LANG_ALIASES: Record<string, GrammarId> = {
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  py: 'python',
  python: 'python',
  python3: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  shellsession: 'bash',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  java: 'java',
  cs: 'csharp',
  csharp: 'csharp',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  ini: 'config',
  env: 'config',
  properties: 'config',
  conf: 'config',
  diff: 'diff',
  patch: 'diff',
};

/** 围栏语言标注 → 文法 id；无文法返回 null（呈现层按原文) */
export function codeGrammarOf(lang: string | null): GrammarId | null {
  if (!lang) return null;
  return LANG_ALIASES[lang.trim().toLowerCase()] ?? null;
}

const kw = (words: string): ReadonlySet<string> =>
  new Set(words.split(' ').filter((w) => w !== ''));

const JS_KEYWORDS = kw(
  'const let var function return if else for while do switch case break continue new class extends super import from export default try catch finally throw typeof instanceof in of delete void yield async await static get set interface type enum namespace implements readonly abstract public private protected declare as is keyof infer this'
);
const JS_CONSTANTS = kw('true false null undefined NaN Infinity');

const PYTHON_KEYWORDS = kw(
  'def return if elif else for while import from as class try except finally with lambda pass break continue raise yield async await global nonlocal assert del in is not and or'
);
const PYTHON_CONSTANTS = kw('True False None self cls');

const RUST_KEYWORDS = kw(
  'fn let mut const struct enum impl trait for in if else match return pub use mod crate super where async await move ref static type unsafe while loop break continue as dyn'
);
const RUST_CONSTANTS = kw('true false');

const GO_KEYWORDS = kw(
  'func var const type struct interface map chan go defer return if else for range switch case default break continue package import select fallthrough'
);
const GO_CONSTANTS = kw('true false nil iota');

const BASH_KEYWORDS = kw(
  'if then else elif fi for in do done while until case esac function return local export declare readonly set unset shift source eval exec exit'
);
const BASH_CONSTANTS = kw('true false');

const C_KEYWORDS = kw(
  'auto break case char const continue default do double else enum extern float for goto if int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while inline _Bool _Complex'
);
const CPP_KEYWORDS = kw(
  'alignas alignof asm auto bool break case catch char char16_t char32_t class concept const constexpr consteval constinit continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while'
);
const JAVA_KEYWORDS = kw(
  'abstract assert boolean break byte case catch char class const continue default do double else enum exports extends final finally float for goto if implements import instanceof int interface long module native new package private protected public requires return short static strictfp super switch synchronized this throw throws transient transitive try uses var void volatile while yield record sealed permits'
);
const CSHARP_KEYWORDS = kw(
  'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while get set add remove where'
);
const C_FAMILY_CONSTANTS = kw('true false null nullptr NULL this');

const SQL_KEYWORDS = kw(
  'select from where insert into values update set delete create table drop alter add column primary key foreign references not null unique index view join left right inner outer full on group by order asc desc limit offset having distinct union all as and or in is between like exists case when then else end begin commit rollback transaction grant revoke'
);

interface CLikeConfig {
  lineComments: readonly string[];
  blockComment: boolean;
  quotes: readonly string[];
  /** Python 三引号字符串 */
  tripleQuotes?: boolean;
  /** Rust 字符字面量 'a' / '\n'（与生命周期 'a 消歧） */
  charLiteral?: boolean;
  /** Shell $VAR / ${VAR} 变量着色 */
  shellVars?: boolean;
  keywords: ReadonlySet<string>;
  constants: ReadonlySet<string>;
  caseInsensitiveKeywords?: boolean;
}

const NUMBER_AT =
  /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[fFuUlL]*)/;
const IDENT_START = /[A-Za-z_$#@]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** 相邻同角色合并（少建呈现节点）；无损拼接不变量靠合并只拼不改 */
function pushToken(
  tokens: CodeToken[],
  text: string,
  role: CodeTokenRole
): void {
  if (text === '') return;
  const last = tokens[tokens.length - 1];
  if (last && last.role === role) {
    last.text += text;
    return;
  }
  tokens.push({ text, role });
}

/** C 族扫描器：注释 / 字符串 / 数字 / 标识符分类，其余皆 plain */
function tokenizeCLike(source: string, config: CLikeConfig): CodeToken[] {
  const tokens: CodeToken[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i]!;

    // 注释（行 / 块）
    let consumed = false;
    for (const marker of config.lineComments) {
      if (source.startsWith(marker, i)) {
        let end = source.indexOf('\n', i);
        if (end < 0) end = n;
        pushToken(tokens, source.slice(i, end), 'comment');
        i = end;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;
    if (config.blockComment && source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      pushToken(tokens, source.slice(i, end), 'comment');
      i = end;
      continue;
    }

    // 字符串（Python 三引号优先）
    if (
      config.tripleQuotes &&
      (source.startsWith("'''", i) || source.startsWith('"""', i))
    ) {
      const quote = source.slice(i, i + 3);
      const close = source.indexOf(quote, i + 3);
      const end = close < 0 ? n : close + 3;
      pushToken(tokens, source.slice(i, end), 'string');
      i = end;
      continue;
    }
    if (config.quotes.includes(ch)) {
      let j = i + 1;
      while (j < n) {
        const c = source[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === ch) {
          j += 1;
          break;
        }
        if (c === '\n' && ch !== '`') break; // 未闭合单行字符串：就地收束，不吞后续行
        j += 1;
      }
      pushToken(tokens, source.slice(i, j), 'string');
      i = j;
      continue;
    }

    // Rust 字符字面量：'x' / '\n' 形态才认，'a 生命周期按普通字符过
    if (config.charLiteral && ch === "'") {
      const match = /^'(?:\\.|[^'\\])'/.exec(source.slice(i, i + 5));
      if (match) {
        pushToken(tokens, match[0], 'string');
        i += match[0].length;
        continue;
      }
    }

    // Shell 变量：$NAME / ${...} / $1
    if (config.shellVars && ch === '$') {
      const match =
        /^\$(?:\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/.exec(
          source.slice(i)
        );
      if (match) {
        pushToken(tokens, match[0], 'constant');
        i += match[0].length;
        continue;
      }
    }

    // 数字
    if (ch >= '0' && ch <= '9') {
      const match = NUMBER_AT.exec(source.slice(i));
      if (match) {
        pushToken(tokens, match[0], 'number');
        i += match[0].length;
        continue;
      }
    }

    // 标识符分类
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(source[j]!)) j += 1;
      const word = source.slice(i, j);
      const keywordProbe = config.caseInsensitiveKeywords
        ? word.toLowerCase()
        : word;
      let role: CodeTokenRole = 'plain';
      if (config.keywords.has(keywordProbe)) {
        role = 'keyword';
      } else if (config.constants.has(word)) {
        role = 'constant';
      } else {
        // 函数调用：标识符后（隔空白）紧跟 (
        let k = j;
        while (k < n && (source[k] === ' ' || source[k] === '\t')) k += 1;
        if (source[k] === '(') role = 'function';
        else if (word[0]! >= 'A' && word[0]! <= 'Z') role = 'type';
      }
      pushToken(tokens, word, role);
      i = j;
      continue;
    }

    pushToken(tokens, ch, 'plain');
    i += 1;
  }
  return tokens;
}

/** JSON：键字符串 → property、值字符串 → string、字面量 → constant */
function tokenizeJson(source: string, allowComments: boolean): CodeToken[] {
  const tokens: CodeToken[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i]!;
    if (allowComments && source.startsWith('//', i)) {
      let end = source.indexOf('\n', i);
      if (end < 0) end = n;
      pushToken(tokens, source.slice(i, end), 'comment');
      i = end;
      continue;
    }
    if (allowComments && source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      pushToken(tokens, source.slice(i, end), 'comment');
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        const c = source[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      let k = j;
      while (k < n && /\s/.test(source[k]!)) k += 1;
      pushToken(
        tokens,
        source.slice(i, j),
        source[k] === ':' ? 'property' : 'string'
      );
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const match = NUMBER_AT.exec(source.slice(i));
      if (match) {
        pushToken(tokens, match[0], 'number');
        i += match[0].length;
        continue;
      }
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(source[j]!)) j += 1;
      const word = source.slice(i, j);
      pushToken(
        tokens,
        word,
        word === 'true' || word === 'false' || word === 'null'
          ? 'constant'
          : 'plain'
      );
      i = j;
      continue;
    }
    pushToken(tokens, ch, 'plain');
    i += 1;
  }
  return tokens;
}

/** 配置文法（yaml/toml/ini)：行首键 → property，行内走字符串 / 数字 / 注释 */
function tokenizeConfig(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) pushToken(tokens, '\n', 'plain');
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
      pushToken(tokens, line, 'comment');
      return;
    }
    // [section] 整行作组名
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) {
      pushToken(tokens, line, 'type');
      return;
    }
    const keyMatch = /^(\s*)([A-Za-z0-9_.-]+)(\s*)([:=])/.exec(line);
    let rest = line;
    if (keyMatch) {
      pushToken(tokens, keyMatch[1]!, 'plain');
      pushToken(tokens, keyMatch[2]!, 'property');
      pushToken(tokens, keyMatch[3]! + keyMatch[4]!, 'plain');
      rest = line.slice(keyMatch[0].length);
    }
    // 值侧迷你扫描：字符串 / 数字 / 布尔 / 行尾注释
    let i = 0;
    while (i < rest.length) {
      const ch = rest[i]!;
      if (ch === '#' || (ch === ';' && (i === 0 || rest[i - 1] === ' '))) {
        pushToken(tokens, rest.slice(i), 'comment');
        break;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < rest.length && rest[j] !== ch) {
          if (rest[j] === '\\') j += 1;
          j += 1;
        }
        if (j < rest.length) j += 1;
        pushToken(tokens, rest.slice(i, j), 'string');
        i = j;
        continue;
      }
      if (ch >= '0' && ch <= '9') {
        const match = NUMBER_AT.exec(rest.slice(i));
        if (match) {
          pushToken(tokens, match[0], 'number');
          i += match[0].length;
          continue;
        }
      }
      if (IDENT_START.test(ch)) {
        let j = i + 1;
        while (j < rest.length && IDENT_PART.test(rest[j]!)) j += 1;
        const word = rest.slice(i, j);
        pushToken(
          tokens,
          word,
          word === 'true' || word === 'false' ? 'constant' : 'plain'
        );
        i = j;
        continue;
      }
      pushToken(tokens, ch, 'plain');
      i += 1;
    }
  });
  return tokens;
}

/** CSS：靠括号深度区分选择器与声明；声明内 属性名 → property */
function tokenizeCss(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const n = source.length;
  let i = 0;
  let depth = 0;
  while (i < n) {
    const ch = source[i]!;
    if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      pushToken(tokens, source.slice(i, end), 'comment');
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      if (j < n) j += 1;
      pushToken(tokens, source.slice(i, j), 'string');
      i = j;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      pushToken(tokens, ch, 'plain');
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      pushToken(tokens, ch, 'plain');
      i += 1;
      continue;
    }
    if (ch === '@') {
      let j = i + 1;
      while (j < n && /[A-Za-z-]/.test(source[j]!)) j += 1;
      pushToken(tokens, source.slice(i, j), 'keyword');
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const match = NUMBER_AT.exec(source.slice(i));
      if (match) {
        pushToken(tokens, match[0], 'number');
        i += match[0].length;
        continue;
      }
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(source[j]!)) j += 1;
      const word = source.slice(i, j);
      let k = j;
      while (k < n && source[k] === ' ') k += 1;
      const role: CodeTokenRole =
        depth > 0 && source[k] === ':' ? 'property' : 'plain';
      pushToken(tokens, word, role);
      i = j;
      continue;
    }
    pushToken(tokens, ch, 'plain');
    i += 1;
  }
  return tokens;
}

/** HTML/XML：标签名 → tag、属性名 → property、属性值 → string */
function tokenizeHtml(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i + 4);
      const end = close < 0 ? n : close + 3;
      pushToken(tokens, source.slice(i, end), 'comment');
      i = end;
      continue;
    }
    if (source[i] === '<') {
      pushToken(tokens, '<', 'plain');
      i += 1;
      if (source[i] === '/') {
        pushToken(tokens, '/', 'plain');
        i += 1;
      }
      if (i < n && /[A-Za-z!]/.test(source[i]!)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9-]/.test(source[j]!)) j += 1;
        pushToken(tokens, source.slice(i, j), 'tag');
        i = j;
      }
      // 标签内：属性扫描至 >
      while (i < n && source[i] !== '>') {
        const c = source[i]!;
        if (c === '"' || c === "'") {
          let j = i + 1;
          while (j < n && source[j] !== c) j += 1;
          if (j < n) j += 1;
          pushToken(tokens, source.slice(i, j), 'string');
          i = j;
          continue;
        }
        if (/[A-Za-z]/.test(c)) {
          let j = i + 1;
          while (j < n && /[A-Za-z0-9-]/.test(source[j]!)) j += 1;
          pushToken(tokens, source.slice(i, j), 'property');
          i = j;
          continue;
        }
        pushToken(tokens, c, 'plain');
        i += 1;
      }
      if (i < n) {
        pushToken(tokens, '>', 'plain');
        i += 1;
      }
      continue;
    }
    pushToken(tokens, source[i]!, 'plain');
    i += 1;
  }
  return tokens;
}

/** diff：整行着色（文件头行除外） */
function tokenizeDiff(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) pushToken(tokens, '\n', 'plain');
    if (line.startsWith('+++') || line.startsWith('---')) {
      pushToken(tokens, line, 'plain');
    } else if (line.startsWith('+')) {
      pushToken(tokens, line, 'inserted');
    } else if (line.startsWith('-')) {
      pushToken(tokens, line, 'deleted');
    } else if (line.startsWith('@@')) {
      pushToken(tokens, line, 'type');
    } else {
      pushToken(tokens, line, 'plain');
    }
  });
  return tokens;
}

const CLIKE_CONFIGS: Partial<Record<GrammarId, CLikeConfig>> = {
  js: {
    lineComments: ['//'],
    blockComment: true,
    quotes: ["'", '"', '`'],
    keywords: JS_KEYWORDS,
    constants: JS_CONSTANTS,
  },
  python: {
    lineComments: ['#'],
    blockComment: false,
    quotes: ["'", '"'],
    tripleQuotes: true,
    keywords: PYTHON_KEYWORDS,
    constants: PYTHON_CONSTANTS,
  },
  rust: {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"'],
    charLiteral: true,
    keywords: RUST_KEYWORDS,
    constants: RUST_CONSTANTS,
  },
  go: {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'", '`'],
    keywords: GO_KEYWORDS,
    constants: GO_CONSTANTS,
  },
  bash: {
    lineComments: ['#'],
    blockComment: false,
    quotes: ["'", '"'],
    shellVars: true,
    keywords: BASH_KEYWORDS,
    constants: BASH_CONSTANTS,
  },
  c: {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'"],
    keywords: C_KEYWORDS,
    constants: C_FAMILY_CONSTANTS,
  },
  cpp: {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'"],
    keywords: CPP_KEYWORDS,
    constants: C_FAMILY_CONSTANTS,
  },
  java: {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'"],
    keywords: JAVA_KEYWORDS,
    constants: C_FAMILY_CONSTANTS,
  },
  csharp: {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'"],
    keywords: CSHARP_KEYWORDS,
    constants: C_FAMILY_CONSTANTS,
  },
  sql: {
    lineComments: ['--'],
    blockComment: true,
    quotes: ["'"],
    keywords: SQL_KEYWORDS,
    constants: kw('true false null'),
    caseInsensitiveKeywords: true,
  },
};

/**
 * 代码原文 → 着色 token 序列；无文法返回 null。
 * 不变量：返回值非 null 时 tokens 拼接 === source（无损）。
 */
export function tokenizeCode(
  lang: string | null,
  source: string
): CodeToken[] | null {
  const grammar = codeGrammarOf(lang);
  if (!grammar) return null;
  if (source === '') return [];
  switch (grammar) {
    case 'json':
      return tokenizeJson(source, lang?.trim().toLowerCase() !== 'json');
    case 'config':
      return tokenizeConfig(source);
    case 'css':
      return tokenizeCss(source);
    case 'html':
      return tokenizeHtml(source);
    case 'diff':
      return tokenizeDiff(source);
    default:
      return tokenizeCLike(source, CLIKE_CONFIGS[grammar]!);
  }
}
