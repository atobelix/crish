/**
 * 产品叶活资产家：extensions/note-paper（workspace 四空壳已删）。
 *
 * 测头自钉：源码钉 ≠ 打开完成 ≠ 关 EL。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTE_LEAF_HONESTY_ATTRS } from './honesty';
import { WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE as mirrorFromExt } from './productMirrorPolicy';
import { WORKSPACE_PRODUCT_ENABLE_PAPER_LIST as paperFromExt } from './productPaperListPolicy';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const WORKSPACE = join(DIR, '../../components/workspace');
const SRC_ROOT = join(DIR, '../..');
const SELF = join(DIR, 'product-leaf-home.source.test.ts');
const HOME_REL = 'extensions/note-paper/productStrictDoc.ts';

/** 声明体：测里的 `/export function resolveProductStrictDocId/` 字面量不计 */
const EXPORT_DECL =
  /export\s+function\s+resolveProductStrictDocId\s*\(/;
const ANY_FN_BODY =
  /(?:export\s+)?(?:async\s+)?function\s+resolveProductStrictDocId\s*\(/;
const CONST_BODY = /(?:export\s+)?const\s+resolveProductStrictDocId\s*=/;

const GONE_WORKSPACE_SHELLS = [
  'workspaceEmptyStateStrictDoc.ts',
  'workspaceProductPaperList.ts',
  'workspaceProductMirrorDetect.tsx',
  'workspaceEmptyStateMirrorSlot.ts',
] as const;

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function listSrcTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSrcTs(full));
      continue;
    }
    if (extname(name) === '.ts' || extname(name) === '.tsx') {
      out.push(full);
    }
  }
  return out;
}

function relSrc(file: string): string {
  return relative(SRC_ROOT, file).replace(/\\/g, '/');
}

describe('产品叶活资产家在扩展（≠ 打开完成 ≠ 关 EL）', () => {
  it('测头自钉：源码钉 ≠ 打开完成 ≠ 关 EL', () => {
    expect(NOTE_LEAF_HONESTY_ATTRS['data-open-complete']).toBe('not-claimed');
    expect(NOTE_LEAF_HONESTY_ATTRS['data-el01']).toBe('not-claimed');
    expect(readUtf8(SELF)).toMatch(/源码钉 ≠ 打开完成 ≠ 关 EL/);
  });

  it('NoteLeafHost / productLeafBindings 不从死 workspace 目录 import', () => {
    for (const name of ['NoteLeafHost.tsx', 'productLeafBindings.ts']) {
      const src = readUtf8(join(DIR, name));
      expect(src, name).not.toMatch(
        /from\s+['"]\.\.\/\.\.\/components\/workspace\//
      );
    }
  });

  it('实现只在扩展；产品常量仍 true；workspace 四空壳不存在', () => {
    expect(mirrorFromExt).toBe(true);
    expect(paperFromExt).toBe(true);
    expect(readUtf8(join(DIR, 'productMirrorPolicy.ts'))).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE\s*=\s*true/
    );
    expect(readUtf8(join(DIR, 'productPaperListPolicy.ts'))).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_PAPER_LIST\s*=\s*true/
    );
    expect(readUtf8(join(DIR, 'productStrictDoc.ts'))).toMatch(
      /export function resolveProductStrictDocId/
    );
    expect(readUtf8(join(DIR, 'mirrorSlot.ts'))).toMatch(
      /export function useWorkspaceEmptyStateMirrorSlot/
    );
    for (const name of GONE_WORKSPACE_SHELLS) {
      expect(existsSync(join(WORKSPACE, name)), name).toBe(false);
    }
  });

  it('EmptyState 组件默认仍 false；resolver 只有一份实现', () => {
    const empty = readUtf8(join(WORKSPACE, 'WorkspaceEmptyState.tsx'));
    expect(empty).toMatch(/enableProductPaperList\s*=\s*false/);
    expect(empty).toMatch(/enableMirrorDetectSchedule\s*=\s*false/);
    expect(empty).not.toMatch(/enableProductPaperList\s*=\s*true/);
    expect(empty).not.toMatch(/enableMirrorDetectSchedule\s*=\s*true/);

    const impl = readUtf8(join(DIR, 'productStrictDoc.ts'));
    expect(impl).toMatch(/export function resolveProductStrictDocId/);
    expect(existsSync(join(WORKSPACE, 'workspaceEmptyStateStrictDoc.ts'))).toBe(
      false
    );
  });

  it('全仓 src 只有一份 resolveProductStrictDocId 函数体（productStrictDoc.ts）', () => {
    const files = listSrcTs(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const exportHits: string[] = [];
    const bodyHits: string[] = [];
    for (const file of files) {
      const src = stripComments(readUtf8(file));
      const rel = relSrc(file);
      if (EXPORT_DECL.test(src)) exportHits.push(rel);
      if (ANY_FN_BODY.test(src) || CONST_BODY.test(src)) bodyHits.push(rel);
    }

    expect(exportHits, exportHits.join('\n')).toEqual([HOME_REL]);
    expect(bodyHits, bodyHits.join('\n')).toEqual([HOME_REL]);
  });
});
