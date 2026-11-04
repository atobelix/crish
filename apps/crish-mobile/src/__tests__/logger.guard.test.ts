// 日志门面守卫（工程健康审计 M-5 防再发）：
//
// 修复波之前「失败静默」的工程温床之一是非 UI 层随手 console.warn：
// 无分级、无域标签、生产与开发同响度，且没有任何规范回压。本守卫把
// 口径钉死：**生产源码禁止裸 console.***，一律走
// src/adapters/platform/logger.ts 的 createLogger 门面。
//
// 扫描面：src/ 与 app/ 全部非测试源码（收口批已把 UI 呈现层
// src/presentation/ 与 app/ 的最后 4 处 console 迁入 logger 门面，守卫
// 覆盖面随之全量扩展——不再有呈现层豁免）。排除——
// - 测试文件（*.test.ts(x) 与 __tests__/）：测试里 spy console 是正当用法；
// - 豁免清单 EXEMPT_FILES：门面自身（全仓唯一允许直触 console 的
//   生产文件）。新增豁免必须改本清单并说明理由，不设行内豁免标记。
// 扫描前剥离注释与字符串字面量（仓内多处注释会提及 console.warn 的
// 历史叙事、字符串里也可能出现同名文本，均不算调用）。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = join(__dirname, '..', '..');
/** 扫描根：src/ 与 app/（呈现层已迁移并入守卫，收口批） */
const SCAN_ROOTS = [join(ROOT, 'src'), join(ROOT, 'app')];

/** 豁免清单（相对仓库根的 posix 路径）：门面自身 */
const EXEMPT_FILES = new Set(['src/adapters/platform/logger.ts']);

const CONSOLE_CALL = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/;

function collectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') return [];
      return collectFiles(full);
    }
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

/** 相对仓库根的 posix 路径 */
function repoRel(file: string): string {
  return relative(ROOT, file).split(sep).join('/');
}

/** 该文件是否在本守卫范围内（src/ 与 app/ 的非测试、非豁免源码） */
export function isGuardedSourcePath(relPosix: string): boolean {
  if (EXEMPT_FILES.has(relPosix)) return false;
  if (/\.test\.(ts|tsx)$/.test(relPosix) || relPosix.includes('__tests__/')) {
    return false;
  }
  return relPosix.startsWith('src/') || relPosix.startsWith('app/');
}

/**
 * 剥离注释与字符串/模板字面量内容（保留换行以便行号对齐）。
 * 模板字面量中的 ${...} 表达式回到代码态正常扫描。
 */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  type Frame = { kind: 'tpl' } | { kind: 'expr'; depth: number };
  const stack: Frame[] = [];
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  let i = 0;
  const blank = (c: string) => (c === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (state === 'line') {
      if (c === '\n') state = 'code';
      out.push(blank(c));
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        out.push('  ');
        i += 2;
        state = 'code';
      } else {
        out.push(blank(c));
        i++;
      }
      continue;
    }
    if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      if (c === '\\') {
        out.push('  ');
        i += 2;
        continue;
      }
      out.push(blank(c));
      i++;
      if (c === quote) state = 'code';
      continue;
    }
    if (state === 'tpl') {
      if (c === '\\') {
        out.push('  ');
        i += 2;
        continue;
      }
      if (c === '`') {
        out.push(' ');
        i++;
        stack.pop();
        state = 'code';
        continue;
      }
      if (c === '$' && n === '{') {
        out.push('  ');
        i += 2;
        stack.push({ kind: 'expr', depth: 0 });
        state = 'code';
        continue;
      }
      out.push(blank(c));
      i++;
      continue;
    }
    // state === 'code'
    if (c === '/' && n === '/') {
      state = 'line';
      out.push('  ');
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      state = 'block';
      out.push('  ');
      i += 2;
      continue;
    }
    if (c === "'") {
      state = 'sq';
      out.push(' ');
      i++;
      continue;
    }
    if (c === '"') {
      state = 'dq';
      out.push(' ');
      i++;
      continue;
    }
    if (c === '`') {
      state = 'tpl';
      stack.push({ kind: 'tpl' });
      out.push(' ');
      i++;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top?.kind === 'expr') {
      if (c === '{') top.depth++;
      else if (c === '}') {
        if (top.depth === 0) {
          stack.pop();
          state = 'tpl';
          out.push(' ');
          i++;
          continue;
        }
        top.depth--;
      }
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** 在一份源码中找裸 console 调用，返回「行号: 方法」列表 */
export function findBareConsoleCalls(src: string): string[] {
  const stripped = stripCommentsAndStrings(src);
  const hits: string[] = [];
  const re = new RegExp(CONSOLE_CALL.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push(`${line}: console.${m[1]}`);
  }
  return hits;
}

describe('日志守卫 · 扫描器自检', () => {
  it('裸 console.warn 被拦', () => {
    expect(findBareConsoleCalls(`console.warn('x');`)).toEqual([
      '1: console.warn',
    ]);
  });

  it('注释与字符串中的 console 提及不算调用', () => {
    const src = [
      '// 旧实现把异常吞成 console.warn → 静默丢失',
      '/* console.error 历史叙事 */',
      "const s = 'console.log';",
      'const t = `模板 console.debug 文本`;',
    ].join('\n');
    expect(findBareConsoleCalls(src)).toEqual([]);
  });

  it('模板表达式内的真实调用仍被拦', () => {
    const src = 'const t = `${console.warn(1)}`;';
    expect(findBareConsoleCalls(src)).toEqual(['1: console.warn']);
  });

  it('路径分类：src/ 与 app/ 全面受守卫，仅测试与门面豁免', () => {
    expect(isGuardedSourcePath('src/adapters/wiring/feedBridge.ts')).toBe(true);
    expect(isGuardedSourcePath('src/network/RelaySocket.ts')).toBe(true);
    expect(isGuardedSourcePath('src/db/dbBootstrap.ts')).toBe(true);
    // 呈现层已迁移入守卫（收口批）：不再豁免
    expect(isGuardedSourcePath('src/presentation/ui/Sheet.tsx')).toBe(true);
    expect(
      isGuardedSourcePath('src/presentation/components/ErrorBoundary.tsx')
    ).toBe(true);
    expect(isGuardedSourcePath('src/adapters/platform/logger.ts')).toBe(false);
    expect(isGuardedSourcePath('src/adapters/wiring/feedBridge.test.ts')).toBe(
      false
    );
    expect(isGuardedSourcePath('app/_layout.tsx')).toBe(true);
  });
});

describe('日志守卫 · 全仓扫描', () => {
  it('生产源码无裸 console.*（一律走 logger 门面）', () => {
    const problems: string[] = [];
    for (const scanRoot of SCAN_ROOTS) {
      for (const file of collectFiles(scanRoot)) {
        const rel = repoRel(file);
        if (!isGuardedSourcePath(rel)) continue;
        const hits = findBareConsoleCalls(readFileSync(file, 'utf8'));
        for (const hit of hits) problems.push(`${rel}:${hit}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
