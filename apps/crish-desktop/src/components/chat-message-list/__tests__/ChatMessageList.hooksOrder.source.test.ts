/**
 * D（FINAL-PLAN P2-b-4）：ChatMessageList 的「零消息提前 return」必须位于全部 hooks 之后，
 * 否则 0 → N → 0 条消息切换会触发 Rendered more/fewer hooks。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  fileURLToPath(new URL('../ChatMessageList.tsx', import.meta.url)),
  'utf8'
);

describe('ChatMessageList hooks 顺序契约', () => {
  it('if (messages.length === 0) return null 位于最后一个 hook 调用之后', () => {
    const ret = src.indexOf('if (messages.length === 0) return null;');
    expect(ret).toBeGreaterThan(0);
    const hookRe = /\buse[A-Z][A-Za-z]*\(/g;
    let lastHook = -1;
    let m: RegExpExecArray | null;
    const bodyStart = src.indexOf('export');
    while ((m = hookRe.exec(src))) {
      if (m.index > bodyStart) lastHook = m.index;
    }
    expect(lastHook).toBeGreaterThan(0);
    expect(ret).toBeGreaterThan(lastHook);
  });
});
