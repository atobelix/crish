/**
 * §6：flushPendingDraft 排空语义形式化；禁止固定两轮伪排空
 * （与 emergency-draft 读回契约分文件，避免并行路互相覆盖）
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PERSIST = path.resolve(__dirname, './useNoteTextPersistence.ts');

describe('§6 flushPendingDraft drain semantics', () => {
  const src = fs.readFileSync(PERSIST, 'utf8');

  it('forbids fixed two-pass fake drain (pass < 2)', () => {
    expect(src).not.toMatch(/pass\s*<\s*2/);
    expect(src).not.toMatch(/for\s*\(\s*let\s+pass\s*=\s*0/);
  });

  it('loops until queues empty or throws visible failure', () => {
    const fnStart = src.indexOf('const flushPendingDraft = useCallback');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, src.indexOf('flushPendingDraftRef', fnStart));
    expect(fnBody).toMatch(/MAX_DRAIN_ROUNDS/);
    expect(fnBody).toMatch(/candidateIds\.size === 0\) return/);
    expect(fnBody).toMatch(/throw new Error/);
    expect(fnBody).toMatch(/drain stalled|exceeded .* drain rounds/);
    expect(fnBody).toMatch(/pendingFlushRef/);
    expect(fnBody).toMatch(/blockQueueRef/);
    expect(fnBody).toMatch(/inFlightBlocksRef/);
  });
});
