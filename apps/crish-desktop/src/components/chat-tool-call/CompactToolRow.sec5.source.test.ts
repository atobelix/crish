/**
 * §5.2：缺审批回调时显式不可用，禁止静默 noop
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, './CompactToolRow.tsx');

describe('CompactToolRow §5.2 approval unavailable', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('renders explicit unavailable when callbacks missing', () => {
    expect(src).toMatch(/approval-unavailable/);
    expect(src).toMatch(/审批操作不可用/);
    expect(src).toMatch(/approvalWired/);
  });
});
