/**
 * 产品叶活资产家：extensions/note-paper（workspace 只 re-export）。
 *
 * 测头自钉：源码钉 ≠ 打开完成 ≠ 关 EL。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveProductStrictDocId as fromWs } from '../../components/workspace/workspaceEmptyStateStrictDoc';
import { WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE as mirrorFromWs } from '../../components/workspace/workspaceProductMirrorDetect';
import { WORKSPACE_PRODUCT_ENABLE_PAPER_LIST as paperFromWs } from '../../components/workspace/workspaceProductPaperList';
import { NOTE_LEAF_HONESTY_ATTRS } from './honesty';
import { resolveProductStrictDocId as fromExt } from './productStrictDoc';
import { WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE as mirrorFromExt } from './productMirrorPolicy';
import { WORKSPACE_PRODUCT_ENABLE_PAPER_LIST as paperFromExt } from './productPaperListPolicy';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const WORKSPACE = join(DIR, '../../components/workspace');
const SELF = join(DIR, 'product-leaf-home.source.test.ts');

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
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

  it('旧路径 re-export 与扩展是同一符号；产品常量仍 true', () => {
    expect(fromWs).toBe(fromExt);
    expect(mirrorFromWs).toBe(mirrorFromExt);
    expect(paperFromWs).toBe(paperFromExt);
    expect(mirrorFromExt).toBe(true);
    expect(paperFromExt).toBe(true);
    expect(readUtf8(join(DIR, 'productMirrorPolicy.ts'))).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE\s*=\s*true/
    );
    expect(readUtf8(join(DIR, 'productPaperListPolicy.ts'))).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_PAPER_LIST\s*=\s*true/
    );
  });

  it('EmptyState 组件默认仍 false；resolver 只有一份实现', () => {
    const empty = readUtf8(join(WORKSPACE, 'WorkspaceEmptyState.tsx'));
    expect(empty).toMatch(/enableProductPaperList\s*=\s*false/);
    expect(empty).toMatch(/enableMirrorDetectSchedule\s*=\s*false/);
    expect(empty).not.toMatch(/enableProductPaperList\s*=\s*true/);
    expect(empty).not.toMatch(/enableMirrorDetectSchedule\s*=\s*true/);

    const impl = readUtf8(join(DIR, 'productStrictDoc.ts'));
    const reexport = readUtf8(
      join(WORKSPACE, 'workspaceEmptyStateStrictDoc.ts')
    );
    expect(impl).toMatch(/export function resolveProductStrictDocId/);
    expect(reexport).not.toMatch(/function resolveProductStrictDocId\s*\(/);
    expect(reexport).toMatch(/from ['"][^'"]*productStrictDoc['"]/);
  });
});
