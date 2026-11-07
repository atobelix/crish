import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * keyframes 引用完整性守卫（keyframes 悬空修复批，2026-11-06）
 *
 * 背景（动效审计 B · T1/T8）：Vite CSS Modules 会把模块 CSS 内
 * `animation` 引用的 keyframes 名 scoped 改名；模块按名引用全局正典
 * （design-system.css / indicators.css）时，产物里的名字指向无定义
 * 名，动画静默死亡。此前守卫只验定义侧与源码意图（indicatorConvergence
 * 全绿的同时 42 处引用全死），本守卫补引用侧：
 *
 * 规则：
 * - 模块 CSS（.module.css）内，普通（非 :global）规则里的 animation
 *   引用名，必须在本文件内有同名 @keyframes 定义；否则即悬空。
 * - :global 上下文里的引用名、以及全局 CSS（非模块）里的引用名，
 *   必须在全局定义集合（全部非模块 CSS 的 @keyframes）内。
 * - `animation: :global(<名>) ...` 形态的按名引用按全局上下文校验。
 * - 全仓不存在任何定义的引用名（如历史上的 RuntimePanel `spin`，
 *   已由 keyframes 批迁为 composes: crish-anim-spin from global）
 *   在任何上下文下都算悬空。
 *
 * 存量以棘轮清单 BASELINE 登记：清单外新增悬空即红；清单内某项被
 * 修复后仍留在表里也红（逼迫同步删表，防登记腐烂，与
 * indicatorConvergence 登记表同法）。立表后 S5b 已先行消解 5 项
 * popover 悬空（TiptapSlashMenu 补本地定义、ProjectPickerMenu 级联
 * 子菜单整段删除），已同步删表；余 36 项为本批迁移面。
 */

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const SRC_ROOT = join(DIR, '..', '..');

const KEYWORDS = new Set([
  'ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out',
  'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse',
  'none', 'forwards', 'backwards', 'both', 'running', 'paused',
  'initial', 'inherit', 'unset', 'revert', 'step-start', 'step-end',
  'jump-start', 'jump-end', 'jump-none', 'jump-both', 'start', 'end',
]);

function walkCss(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walkCss(full, out);
    } else if (entry.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, '');
}

function localKeyframes(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/@(?:-webkit-)?keyframes\s+([A-Za-z_][\w-]*)/g)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

interface Refs {
  local: Set<string>;
  global: Set<string>;
}

/** 提取一个文件的 animation 引用名，按上下文分流（本地 / 全局）。 */
function animationRefs(text: string): Refs {
  const local = new Set<string>();
  const global = new Set<string>();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(text))) {
    const selector = m[1] ?? '';
    const decls = m[2] ?? '';
    const isGlobalCtx = selector.includes(':global');
    const animRe = /animation(?:-name)?\s*:\s*([^;]+)/g;
    let a: RegExpExecArray | null;
    while ((a = animRe.exec(decls))) {
      let value = a[1] ?? '';
      // :global(<名>) 按名引用：按全局上下文校验，并从本地扫描中摘除
      for (const g of value.matchAll(/:global\(\s*([A-Za-z_][\w-]*)\s*\)/g)) {
        if (g[1]) global.add(g[1]);
      }
      value = value.replace(/:global\(\s*[A-Za-z_][\w-]*\s*\)/g, ' ');
      for (const part of value.split(',')) {
        for (const tok of part.trim().split(/\s+/)) {
          if (!tok || tok.includes('(') || tok.includes(')')) continue;
          if (/^\d+(\.\d+)?(ms|s)$/.test(tok)) continue;
          if (KEYWORDS.has(tok.toLowerCase())) continue;
          if (!/^[A-Za-z_][\w-]*$/.test(tok)) continue;
          (isGlobalCtx ? global : local).add(tok);
        }
      }
    }
  }
  return { local, global };
}

interface Dangling {
  file: string;
  name: string;
}

const CSS_FILES = walkCss(SRC_ROOT, []);
const PER_FILE = CSS_FILES.map((full) => {
  const rel = relative(SRC_ROOT, full).replace(/\\/g, '/');
  const text = stripComments(readFileSync(full, 'utf8'));
  return {
    rel,
    isModule: full.endsWith('.module.css'),
    defs: localKeyframes(text),
    refs: animationRefs(text),
  };
});

const GLOBAL_DEFS = new Set<string>();
for (const pf of PER_FILE) {
  if (!pf.isModule) for (const d of pf.defs) GLOBAL_DEFS.add(d);
}

function computeDangling(): Dangling[] {
  const out: Dangling[] = [];
  for (const pf of PER_FILE) {
    for (const n of pf.refs.local) {
      if (pf.isModule) {
        if (!pf.defs.has(n)) out.push({ file: pf.rel, name: n });
      } else if (!GLOBAL_DEFS.has(n)) {
        out.push({ file: pf.rel, name: n });
      }
    }
    for (const n of pf.refs.global) {
      if (!GLOBAL_DEFS.has(n)) out.push({ file: pf.rel, name: n });
    }
  }
  return out.sort((x, y) =>
    x.file === y.file ? x.name.localeCompare(y.name) : x.file.localeCompare(y.file)
  );
}

const key = (d: Dangling) => `${d.file} :: ${d.name}`;

/**
 * 棘轮清单：立守卫时（2026-11-06）的存量悬空（已扣除 S5b 先行
 * 消解的 5 项 popover 悬空）。修复一处删一处；本批收口目标 = 归零。
 */
const BASELINE: Dangling[] = [
  // （空）2026-11-06 keyframes 悬空修复批收口：立表 41 项（审计 B 的
  // 42 处减 SEP 已由 S4 先行消解 1 处）→ S5b 先行消解 5 项 popover
  // 悬空后 36 项由本批迁移清零。后续新增悬空一律不得入表——按全局
  // 工具类（design-system.css §4b）或同文件定义解决。
];

describe('keyframes 引用完整性守卫', () => {
  it('悬空引用只许在棘轮清单内（清单外新增即红）', () => {
    const allowed = new Set(BASELINE.map(key));
    const extra = computeDangling().filter((d) => !allowed.has(key(d)));
    expect(extra.map(key)).toEqual([]);
  });

  it('棘轮清单不腐烂：每条登记都仍是真实悬空（修好必须删表）', () => {
    const actual = new Set(computeDangling().map(key));
    const stale = BASELINE.filter((d) => !actual.has(key(d)));
    expect(stale.map(key)).toEqual([]);
  });
});
