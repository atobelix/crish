import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isParseErr,
  isParseOk,
  parseErr,
  parseOk,
  type ParseResult,
} from './parseResult';

describe('parseResult（C3.2：原 engineEventSchema 共用的结果判别联合，独立成最小工具）', () => {
  it('isParseOk / isParseErr are exclusive type guards', () => {
    const ok = parseOk({ n: 1 });
    const err = parseErr('boom');
    expect(isParseOk(ok)).toBe(true);
    expect(isParseErr(ok)).toBe(false);
    expect(isParseOk(err)).toBe(false);
    expect(isParseErr(err)).toBe(true);
  });

  it('isParseOk narrows to data; isParseErr narrows to error', () => {
    const r: ParseResult<{ id: string }> = parseOk({ id: 'x' });
    if (isParseOk(r)) {
      expect(r.data.id).toBe('x');
      expectTypeOf(r.data).toEqualTypeOf<{ id: string }>();
      expectTypeOf(r).not.toHaveProperty('error');
    } else {
      expect.fail('expected ok');
    }

    const e: ParseResult<number> = parseErr('  missing  ');
    if (isParseErr(e)) {
      expect(e.error).toBe('missing');
      expectTypeOf(e.error).toEqualTypeOf<string>();
      expectTypeOf(e).not.toHaveProperty('data');
    } else {
      expect.fail('expected err');
    }
  });

  it('parseErr never yields empty error string', () => {
    expect(parseErr('').error).toBe('parse failed');
    expect(parseErr('   ').error).toBe('parse failed');
    expect(parseErr(' real ').error).toBe('real');
  });
});
