/**
 * CONN-E2′ · 已断链 WorkspaceProductEmptyHost 已删（源码钉）
 *
 * workspaceProductMirrorDetect.tsx 亦不在。
 * 实现只在 extensions/note-paper/productMirrorPolicy.ts。
 * 删 Host / 删 re-export ≠ 打开完成 ≠ 关 EL。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const GONE = join(DIR, 'workspaceProductMirrorDetect.tsx');
const IMPL = join(
  DIR,
  '../../extensions/note-paper/productMirrorPolicy.ts'
);
const SELF = join(DIR, 'workspaceProductMirrorDetect.host-gone.test.ts');

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('CONN-E2′ · WorkspaceProductEmptyHost 已删（≠ 打开完成 · ≠ 关 EL）', () => {
  const impl = readUtf8(IMPL);
  const self = readUtf8(SELF);

  it('测头自钉：删 Host ≠ 打开完成 ≠ 关 EL', () => {
    expect(self).toMatch(/删 Host ≠ 打开完成 ≠ 关 EL/);
    expect(self).not.toMatch(/\brender\s*\(/);
  });

  it('workspaceProductMirrorDetect.tsx 不存在', () => {
    expect(existsSync(GONE)).toBe(false);
  });

  it('实现只在扩展 productMirrorPolicy；无 function WorkspaceProductEmptyHost', () => {
    expect(impl).toMatch(/export function createProductNoteMirrorIpc/);
    expect(impl).toMatch(
      /export function resolveWorkspaceProductEmptyMirrorProps/
    );
    expect(impl).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE\s*=\s*true/
    );
    expect(impl).not.toMatch(/function WorkspaceProductEmptyHost/);
    expect(impl).not.toMatch(/type WorkspaceProductEmptyHostProps/);
  });
});
