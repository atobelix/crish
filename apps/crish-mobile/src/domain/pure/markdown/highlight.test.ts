// 高亮分词断言（批 E)：无损不变量（拼接 === 原文）逐文法钉死；关键 token
// 角色逐文法抽查；无文法返回 null（呈现层据此走原文，不乱着色）。
import { codeGrammarOf, tokenizeCode, type CodeToken } from './highlight';

function joined(tokens: CodeToken[] | null): string {
  return (tokens ?? []).map((t) => t.text).join('');
}

function roleOf(tokens: CodeToken[] | null, text: string): string | undefined {
  return (tokens ?? []).find((t) => t.text === text)?.role;
}

const SNIPPETS: ReadonlyArray<readonly [string, string]> = [
  [
    'ts',
    "const total = add(1, 2); // 求和\nconst label = `值:${total}`;\nif (total > 0x10) return 'ok';",
  ],
  ['json', '{"name": "crish", "count": 42, "ok": true, "missing": null}'],
  [
    'python',
    "def main(name):\n    # 入口\n    total = len(name) + 0x1F\n    return f'hi {name}' if total else None",
  ],
  [
    'rust',
    'fn main() { let ch = \'x\'; let s = "hi"; if true { println!("{}", s); } }',
  ],
  ['go', 'package main\n\nfunc main() { var n = 07; if n != nil { return } }'],
  [
    'bash',
    'export PATH=$HOME/bin:$PATH\nif [ -f "$HOME/.env" ]; then source "$HOME/.env"; fi # 载入',
  ],
  ['c', 'int main(void) { /* 入口 */ int n = 42; return n; }'],
  ['cpp', 'class Foo : public Bar { public: bool ok = true; };'],
  [
    'java',
    'public class Main { public static void main(String[] args) { int n = 1; } }',
  ],
  [
    'csharp',
    'public async Task Run() { var name = "x"; if (name == null) return; }',
  ],
  [
    'sql',
    "SELECT id, name FROM users WHERE age > 18 AND name LIKE 'a%' -- 成年",
  ],
  [
    'css',
    '.card { color: #fff; margin: 0 12px; } @media (min-width: 100px) { .a { top: 0; } }',
  ],
  ['html', '<div class="box" data-x="1">正文<!-- 注释 --></div>'],
  ['yaml', 'server:\n  port: 8080 # 监听\n  host: "localhost"\nenabled: true'],
  ['toml', '[server]\nport = 8080 ; 监听\nhost = "localhost"'],
  [
    'diff',
    '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context',
  ],
];

describe('tokenizeCode · 无损不变量', () => {
  it.each(SNIPPETS)('%s：拼接 === 原文', (lang, source) => {
    const tokens = tokenizeCode(lang, source);
    expect(tokens).not.toBeNull();
    expect(joined(tokens)).toBe(source);
  });

  it('空串返回空序列；无标注 / 未知语言 / 散文围栏返回 null', () => {
    expect(tokenizeCode('ts', '')).toEqual([]);
    expect(tokenizeCode(null, 'const a = 1;')).toBeNull();
    expect(tokenizeCode('brainfuck', '+++')).toBeNull();
    expect(tokenizeCode('markdown', '# 标题')).toBeNull();
    expect(codeGrammarOf('TypeScript')).toBe('js');
    expect(codeGrammarOf(' c++ ')).toBe('cpp');
  });
});

describe('tokenizeCode · 角色抽查', () => {
  it('TS：关键字 / 函数 / 字符串 / 注释 / 数字 / 类型', () => {
    const tokens = tokenizeCode(
      'ts',
      "const cfg: Config = load('a'); // 读配置\nlet n = 0x10;"
    );
    expect(roleOf(tokens, 'const')).toBe('keyword');
    expect(roleOf(tokens, 'Config')).toBe('type');
    expect(roleOf(tokens, 'load')).toBe('function');
    expect(roleOf(tokens, "'a'")).toBe('string');
    expect(roleOf(tokens, '// 读配置')).toBe('comment');
    expect(roleOf(tokens, '0x10')).toBe('number');
  });

  it('JSON：键 → property、值字符串 → string、字面量 → constant', () => {
    const tokens = tokenizeCode('json', '{"a": "b", "n": 1, "ok": false}');
    expect(roleOf(tokens, '"a"')).toBe('property');
    expect(roleOf(tokens, '"b"')).toBe('string');
    expect(roleOf(tokens, 'false')).toBe('constant');
    expect(roleOf(tokens, '1')).toBe('number');
  });

  it('Python：三引号字符串与 None / self', () => {
    const tokens = tokenizeCode(
      'python',
      "'''文档串'''\ndef f(self):\n    return None"
    );
    expect(roleOf(tokens, "'''文档串'''")).toBe('string');
    expect(roleOf(tokens, 'def')).toBe('keyword');
    expect(roleOf(tokens, 'None')).toBe('constant');
    expect(roleOf(tokens, 'self')).toBe('constant');
  });

  it('Rust：字符字面量不误伤生命周期', () => {
    const tokens = tokenizeCode('rust', "let a = 'x'; let r: &'a str = \"s\";");
    expect(roleOf(tokens, "'x'")).toBe('string');
    // 生命周期 'a 不得被吞成字符串：拼接无损已由不变量保证，此处断言无 'a 字面量 token
    expect((tokens ?? []).some((t) => t.text === "'a")).toBe(false);
    expect(roleOf(tokens, 'let')).toBe('keyword');
  });

  it('Bash：变量 → constant、注释、关键字', () => {
    const tokens = tokenizeCode('bash', 'echo $HOME && ls # 列表');
    expect(roleOf(tokens, '$HOME')).toBe('constant');
    expect(roleOf(tokens, '# 列表')).toBe('comment');
  });

  it('SQL：关键字大小写不敏感', () => {
    const tokens = tokenizeCode('sql', 'Select * From t Where id = 1');
    expect(roleOf(tokens, 'Select')).toBe('keyword');
    expect(roleOf(tokens, 'From')).toBe('keyword');
    expect(roleOf(tokens, '1')).toBe('number');
  });

  it('CSS：声明内属性名 → property、@规则 → keyword', () => {
    const tokens = tokenizeCode('css', '.a { color: red; } @media x { }');
    expect(roleOf(tokens, 'color')).toBe('property');
    expect(roleOf(tokens, '@media')).toBe('keyword');
  });

  it('HTML：标签名 / 属性名 / 属性值', () => {
    const tokens = tokenizeCode('html', '<a href="https://x.y">链</a>');
    expect(roleOf(tokens, 'a')).toBe('tag');
    expect(roleOf(tokens, 'href')).toBe('property');
    expect(roleOf(tokens, '"https://x.y"')).toBe('string');
  });

  it('配置：段头 → type、键 → property、行尾注释', () => {
    const tokens = tokenizeCode(
      'toml',
      '[server]\nport = 8080 # 监听\nhost = "h"'
    );
    expect(roleOf(tokens, '[server]')).toBe('type');
    expect(roleOf(tokens, 'port')).toBe('property');
    expect(roleOf(tokens, '# 监听')).toBe('comment');
    expect(roleOf(tokens, '8080')).toBe('number');
  });

  it('diff：增删行与 hunk 头', () => {
    const tokens = tokenizeCode('diff', '@@ -1 +1 @@\n-old\n+new\n same');
    expect(roleOf(tokens, '@@ -1 +1 @@')).toBe('type');
    expect(roleOf(tokens, '-old')).toBe('deleted');
    expect(roleOf(tokens, '+new')).toBe('inserted');
    // 上下文行与前导换行同为 plain 已合并，只断言其所在 token 的角色
    expect((tokens ?? []).find((t) => t.text.includes(' same'))?.role).toBe(
      'plain'
    );
  });
});
