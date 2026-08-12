/**
 * slash 写模式解析纯测（SD-13 · CONN-B）
 *
 * **≠ EL-01**；纯函数 ≠ 产品 e2e。
 */
import { describe, expect, it } from 'vitest';
import {
  isSlashReadOnly,
  resolveSlashWriteMode,
  toSlashDataWriteMode,
} from './slashMenuOverlayWriteMode';

const fakeSink = {
  submitIntent: async () => ({ ok: true as const }),
};

describe('slashMenuOverlayWriteMode', () => {
  it('未传 → legacy；非只读', () => {
    const r = resolveSlashWriteMode(undefined);
    expect(r).toBe('legacy');
    expect(isSlashReadOnly(r)).toBe(false);
  });

  it('readonly → 禁提交 data', () => {
    const r = resolveSlashWriteMode('readonly');
    expect(isSlashReadOnly(r)).toBe(true);
    expect(toSlashDataWriteMode(r, fakeSink)).toBe('readonly');
    expect(toSlashDataWriteMode(r, undefined)).toBe('readonly');
  });

  it('writable + sink → writable；无 sink → writable', () => {
    const r = resolveSlashWriteMode('writable');
    expect(toSlashDataWriteMode(r, fakeSink)).toBe('writable');
    expect(toSlashDataWriteMode(r, undefined)).toBe('writable');
  });

  it('legacy 无 sink → intent-only；有 sink → writable', () => {
    const r = resolveSlashWriteMode(undefined);
    expect(toSlashDataWriteMode(r, undefined)).toBe('intent-only');
    expect(toSlashDataWriteMode(r, fakeSink)).toBe('writable');
  });
});
