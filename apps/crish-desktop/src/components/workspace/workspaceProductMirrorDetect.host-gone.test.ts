/**
 * CONN-E2′ · 已断链 WorkspaceProductEmptyHost 已删（源码钉）
 *
 * 策略常量 / resolve 仍给扩展叶用；不再有产品 Host 组件。
 * 删 Host ≠ 打开完成 ≠ 关 EL。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const SRC = join(DIR, 'workspaceProductMirrorDetect.tsx');
const SELF = join(DIR, 'workspaceProductMirrorDetect.host-gone.test.ts');

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('CONN-E2′ · WorkspaceProductEmptyHost 已删（≠ 打开完成 · ≠ 关 EL）', () => {
  const src = readUtf8(SRC);
  const self = readUtf8(SELF);

  it('测头自钉：删 Host ≠ 打开完成 ≠ 关 EL', () => {
    expect(self).toMatch(/删 Host ≠ 打开完成 ≠ 关 EL/);
    expect(self).not.toMatch(/\brender\s*\(/);
  });

  it('源码不再出现 function WorkspaceProductEmptyHost', () => {
    expect(src).not.toMatch(/function WorkspaceProductEmptyHost/);
    expect(src).not.toMatch(/type WorkspaceProductEmptyHostProps/);
    expect(src).not.toMatch(/from ['"]\.\/WorkspaceEmptyState['"]/);
    expect(src).not.toMatch(/WORKSPACE_PRODUCT_ENABLE_PAPER_LIST/);
    expect(src).toMatch(/WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE/);
    expect(src).toMatch(/export function createProductNoteMirrorIpc/);
    expect(src).toMatch(/export function resolveWorkspaceProductEmptyMirrorProps/);
    expect(src).toMatch(/策略常量给扩展叶用，不再有产品 Host 组件/);
  });
});
