// @vitest-environment node
/**
 * 防回归：entry-core.tsx 的 DEV 分支必须注册 MCP guest 监听器。
 *
 * 背景（根因）：tauri-plugin-mcp 不会自动注入 guest 监听器——Cargo.toml 的
 * exclude 含 /guest-js、build.rs 只声明 commands 无 guest 打包步骤、
 * src/listener_patch.js 不含 execute-js 监听；`execute-js` 监听只在
 * guest-js/index.ts 注册。故缺了前端 setupPluginListeners() 这一拍，
 * emit_and_wait('execute-js') 的事件永远无人接收 → execute_js / query_page /
 * manage_ipc invoke 等全部 webview JS 桥工具超时。
 *
 * 断言对「注释 / 字符串」不敏感：先经 scanSource 剥离注释（字符串内容掩码为
 * 等长空白以便花括号配平），因此把注册代码注释掉必然变红。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface SourceScan {
  /** 注释已剥离、字符串原样保留（用于内容断言） */
  code: string;
  /** 注释已剥离 + 字符串内容掩码为空格（与 code 等长，用于花括号配平） */
  masked: string;
}

/** 剥离注释的源码扫描器；字符串内容在 masked 中掩码为空白（保持长度对齐） */
function scanSource(src: string): SourceScan {
  const code: string[] = [];
  const masked: string[] = [];
  const push = (c: string, m: string): void => {
    code.push(c);
    masked.push(m);
  };
  let quote: string | null = null;
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (quote !== null) {
      if (ch === '\\') {
        push(ch, ' ');
        if (i + 1 < src.length) push(next as string, ' ');
        i += 2;
        continue;
      }
      if (ch === quote) {
        push(ch, ch);
        quote = null;
        i += 1;
        continue;
      }
      push(ch, ch === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        push(' ', ' ');
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        const c = src[i] as string;
        push(c === '\n' ? '\n' : ' ', c === '\n' ? '\n' : ' ');
        i += 1;
      }
      if (i < src.length) {
        push(' ', ' ');
        push(' ', ' ');
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      push(ch, ch);
      quote = ch;
      i += 1;
      continue;
    }
    push(ch, ch);
    i += 1;
  }
  return { code: code.join(''), masked: masked.join('') };
}

/** 提取所有 `if (import.meta.env.DEV) { ... }` 块在 code/masked 中的 [start, end) 区间 */
function devGuardRanges(masked: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /if\s*\(\s*import\.meta\.env\.DEV\s*\)\s*\{/g;
  let m: RegExpExecArray | null = re.exec(masked);
  while (m !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < masked.length && depth > 0) {
      const c = masked[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
    ranges.push({ start, end: depth === 0 ? i - 1 : masked.length });
    m = re.exec(masked);
  }
  return ranges;
}

describe('MCP guest 监听器注册（entry-core DEV 分支）', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // 测试位于 apps/crish-desktop/src/__tests__/startup/ 或 tests/unit/startup/
  const candidates = [
    path.resolve(here, '../../../src'),
    path.resolve(here, '../../src'),
    path.resolve(here, '../src'),
  ];
  let desktopSrc = '';
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'main.tsx'))) {
      desktopSrc = c;
      break;
    }
  }
  const entryCorePath = path.join(desktopSrc, 'entry-core.tsx');
  const scan = scanSource(fs.readFileSync(entryCorePath, 'utf-8'));
  const ranges = devGuardRanges(scan.masked);
  const devBlocks = ranges.map((r) => scan.code.slice(r.start, r.end));
  /** 承载 MCP guest 监听器注册的 DEV 块 */
  const mcpBlock = devBlocks.find((b) => /setupPluginListeners\s*\(/.test(b)) ?? '';

  it('定位到 apps/crish-desktop/src/entry-core.tsx', () => {
    expect(desktopSrc).not.toBe('');
    expect(fs.existsSync(entryCorePath)).toBe(true);
  });

  it('扫描器自检：注释与字符串内的代码不得被计入（防断言假绿）', () => {
    const fixture = [
      '// setupPluginListeners();',
      '/* setupPluginListeners(); */',
      "const s = 'setupPluginListeners()';",
      'if (import.meta.env.DEV) {',
      '  // registerCrishMcpBridge();',
      '}',
    ].join('\n');
    const f = scanSource(fixture);
    // masked：注释体 + 字符串内容全部掩码 → 结构断言对二者均不敏感
    expect(f.masked).not.toMatch(/setupPluginListeners/);
    expect(f.masked).not.toMatch(/registerCrishMcpBridge/);
    // code：注释已剥离（注释里的注册代码不可见），字符串原样保留
    expect(f.code).not.toMatch(/^\s*\/\//m);
    expect(f.code).toMatch(/'setupPluginListeners\(\)'/);
    // 等长掩码：可用 masked 的花括号配平区间去切 code
    expect(f.masked.length).toBe(fixture.length);
    const r = devGuardRanges(f.masked);
    expect(r.length).toBe(1);
    const block = f.code.slice(r[0]!.start, r[0]!.end);
    expect(block).not.toMatch(/registerCrishMcpBridge/);
  });

  it('DEV 守卫块内动态 import 插件并调用 setupPluginListeners()', () => {
    expect(
      mcpBlock,
      'entry-core.tsx 的 DEV 分支未注册 MCP guest 监听器（execute-js 等桥工具将全部超时）'
    ).not.toBe('');
    expect(mcpBlock).toMatch(/import\(\s*['"]tauri-plugin-mcp['"]\s*\)/);
    expect(mcpBlock).toMatch(/setupPluginListeners\s*\(\s*\)/);
  });

  it('注册后串接 registerCrishMcpBridge()，且顺序在 setupPluginListeners 之后', () => {
    const setupAt = mcpBlock.search(/setupPluginListeners\s*\(/);
    const bridgeAt = mcpBlock.search(/registerCrishMcpBridge\s*\(/);
    expect(
      bridgeAt,
      'DEV 分支未串接 registerCrishMcpBridge()（app_bridge 助手仍为死代码）'
    ).toBeGreaterThan(-1);
    expect(bridgeAt).toBeGreaterThan(setupAt);
    expect(mcpBlock).toMatch(/import\(\s*['"]\.\/dev\/mcpBridge['"]\s*\)/);
  });

  it('注册失败必须显式可见（不得静默吞掉）', () => {
    expect(mcpBlock).toMatch(/\.catch\s*\(/);
    expect(mcpBlock).toMatch(/(logger|console)\.error\s*\(/);
  });

  it('setupPluginListeners 仅出现在 DEV 守卫内（无第二个无条件注册点）', () => {
    const matches = [...scan.code.matchAll(/setupPluginListeners\s*\(/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const inside = ranges.some((r) => m.index >= r.start && m.index < r.end);
      expect(
        inside,
        `setupPluginListeners 出现在 DEV 守卫之外（偏移 ${m.index}）：生产包会加载插件前端`
      ).toBe(true);
    }
  });
});
