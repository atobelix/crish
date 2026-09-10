/**
 * §6：块 ID 桌面生产强制 crypto 熵；弱 Math.random 不得出现在生产可达路径
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { isUuidV4, newNoteBlockId } from './noteBlockId';

const SRC = path.resolve(__dirname, './noteBlockId.ts');

describe('§6 noteBlockId production entropy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('source: Math.random only inside DEV/test helper; PROD throws', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(/fillWeakEntropyForDevOnly/);
    expect(src).toMatch(/import\.meta\.env\.PROD/);
    expect(src).toMatch(/crypto entropy required in production/);
    // Math.random 不得出现在 newNoteBlockId 函数体的直接路径（仅 helper）
    const fnStart = src.indexOf('export function newNoteBlockId');
    const fnBody = src.slice(fnStart);
    expect(fnBody).not.toMatch(/Math\.random/);
    expect(src).toMatch(
      /function fillWeakEntropyForDevOnly[\s\S]*Math\.random/
    );
    expect(src).toMatch(
      /if \(import\.meta\.env\.DEV \|\| import\.meta\.env\.MODE === 'test'\)/
    );
  });

  it('produces_valid_uuid_v4', () => {
    for (let i = 0; i < 50; i++) {
      expect(isUuidV4(newNoteBlockId())).toBe(true);
    }
  });

  it('ids_are_unique_across_calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newNoteBlockId());
    expect(seen.size).toBe(200);
  });

  it('falls back to getRandomValues when randomUUID missing', () => {
    const real = globalThis.crypto;
    const getRandomValues = vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (i * 17 + 3) & 0xff;
      return arr;
    });
    vi.stubGlobal('crypto', {
      getRandomValues,
      // no randomUUID
    });
    const id = newNoteBlockId();
    expect(isUuidV4(id)).toBe(true);
    expect(getRandomValues).toHaveBeenCalled();
    vi.stubGlobal('crypto', real);
  });
});
