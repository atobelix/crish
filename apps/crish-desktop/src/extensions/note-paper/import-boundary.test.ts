/**
 * 02 / 08 激活模块 import 面：禁深路径（三包）、禁第二套插件、禁 sessionId 打开旁路。
 *
 * 测头自钉：本测绿 ≠ 打开完成（G-HYD）≠ 关 EL ≠ 独立软件已拆。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTE_LEAF_HONESTY_ATTRS } from './honesty';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const DESKTOP_SRC = join(DIR, '../..');

const ACTIVATION_FILES = [
  join(DESKTOP_SRC, 'services/view-registry/registerBuiltInViews.tsx'),
  join(DESKTOP_SRC, 'services/view-registry/registerBuiltInViews.ts'),
  join(DESKTOP_SRC, 'main.tsx'),
] as const;

/** 三包深路径：公开桶与 css export 合法；包名后接 /src/ 或相对 packages/.../src 非法 */
const DEEP_PATH_RES: Array<{ id: string; re: RegExp }> = [
  {
    id: 'block-paper-src',
    re: /(?:from\s+|import\s*\(\s*)['"]@crish\/block-paper\/src\//,
  },
  {
    id: 'editor-kit-src',
    re: /(?:from\s+|import\s*\(\s*)['"]@crish\/editor-kit\/src\//,
  },
  {
    id: 'block-paper-contract-src',
    re: /(?:from\s+|import\s*\(\s*)['"]@crish\/block-paper-contract\/src\//,
  },
  {
    id: 'rel-block-paper-src',
    re: /(?:from\s+|import\s*\(\s*)['"][^'"]*packages\/block-paper\/src\//,
  },
  {
    id: 'rel-editor-kit-src',
    re: /(?:from\s+|import\s*\(\s*)['"][^'"]*packages\/editor-kit\/src\//,
  },
  {
    id: 'rel-contract-src',
    re: /(?:from\s+|import\s*\(\s*)['"][^'"]*packages\/block-paper-contract\/src\//,
  },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.includes('.test.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (extname(name) === '.ts' || extname(name) === '.tsx') {
      out.push(full);
    }
  }
  return out;
}

function listDesktopProductSource(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.includes('.test.') || name.includes('.spec.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') {
        continue;
      }
      out.push(...listDesktopProductSource(full));
      continue;
    }
    if (extname(name) === '.ts' || extname(name) === '.tsx') {
      out.push(full);
    }
  }
  return out;
}

function collectDeepPathHits(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const line of src.split(/\r?\n/)) {
      if (!/\bfrom\b/.test(line) && !/\bimport\s*\(/.test(line)) continue;
      for (const { id, re } of DEEP_PATH_RES) {
        if (re.test(line)) hits.push(`${id} ${file}: ${line.trim()}`);
      }
    }
  }
  return hits;
}

describe('note-paper extension import 边界', () => {
  const files = listSourceFiles(DIR);

  it('测头自钉：绿 ≠ 打开完成 ≠ 关 EL ≠ 独立软件已拆', () => {
    expect(NOTE_LEAF_HONESTY_ATTRS['data-open-complete']).toBe('not-claimed');
    expect(NOTE_LEAF_HONESTY_ATTRS['data-el08']).toBe('not-claimed');
  });

  it('产品源无 plugins / ContributeViewRegistry / setChatMainSurface(note)', () => {
    const hits: string[] = [];
    const banned = [
      /from\s+['"][^'"]*\/plugins\//,
      /ContributeViewRegistry/,
      /setChatMainSurface\s*\(\s*['"]note['"]/,
      /from\s+['"]@crish\/block-paper\/src\//,
      /from\s+['"]@crish\/editor-kit\/src\//,
      /from\s+['"]@crish\/block-paper-contract\/src\//,
      /from\s+['"][^'"]*reference[/\\]markdown-editor/,
      /invoke\s*\(\s*['"]note_document_hydrate['"]/,
      /\bDocSession\b/,
      /createDocSessionApplySink/,
    ];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const line of src.split(/\r?\n/)) {
        if (
          !/^\s*import\b/.test(line) &&
          !line.includes('setChatMainSurface')
        ) {
          if (!/\bDocSession\b/.test(line) && !/invoke\s*\(/.test(line)) {
            continue;
          }
        }
        for (const re of banned) {
          if (re.test(line)) hits.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('activate 不同步引用 NotePaperStrictPanel', () => {
    const src = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(src).not.toMatch(/NotePaperStrictPanel/);
    expect(src).not.toMatch(/from\s+['"].*note-paper\/NotePaper/);
  });

  it('桌面产品源 + 三包：无 @crish/*/src 与 packages/*/src 深路径', () => {
    const product = listDesktopProductSource(DESKTOP_SRC);
    expect(product.length).toBeGreaterThan(0);
    expect(collectDeepPathHits(product)).toEqual([]);
  });

  it('registerBuiltInViews / main.tsx 激活点无深路径、无 note 内置键', () => {
    for (const file of ACTIVATION_FILES) {
      const src = readFileSync(file, 'utf8');
      expect(collectDeepPathHits([file]), file).toEqual([]);
      if (file.endsWith('registerBuiltInViews.tsx')) {
        expect(src).not.toMatch(/registerView\s*\(\s*['"]note['"]/);
        expect(src).not.toMatch(/id:\s*['"]note['"]/);
      }
      if (file.endsWith('main.tsx')) {
        expect(src).not.toMatch(/builtinViewFactories[\s\S]*?\bnote\s*:/);
        expect(src).toMatch(/activateNotePaper\s*\(/);
        const builtinIdx = src.indexOf(
          'registerBuiltInViews(builtinViewFactories)'
        );
        const activateIdx = src.indexOf('activateNotePaper()');
        expect(builtinIdx).toBeGreaterThan(-1);
        expect(activateIdx).toBeGreaterThan(builtinIdx);
      }
    }
  });

  it('产品叶 / productLeafBindings 不再从 components/workspace 拉活资产', () => {
    for (const name of ['NoteLeafHost.tsx', 'productLeafBindings.ts']) {
      const src = readFileSync(join(DIR, name), 'utf8');
      expect(src, name).not.toMatch(
        /from\s+['"]\.\.\/\.\.\/components\/workspace\//
      );
    }
  });

  it('registerView(id: note) 只出现在 activate.ts，不进内置名单', () => {
    const activate = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(activate).toMatch(
      /registerView\s*\(\s*\{[\s\S]*?id:\s*['"]note['"]/
    );
    const builtin = readFileSync(ACTIVATION_FILES[0], 'utf8');
    expect(builtin).not.toMatch(/id:\s*['"]note['"]/);
    const main = readFileSync(ACTIVATION_FILES[2], 'utf8');
    expect(main).not.toMatch(/registerView\s*\(/);
  });
});
