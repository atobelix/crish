import { describe, expect, it } from 'vitest';
import { repairToolCallJsonArguments } from './json-repair';

describe('json-repair', () => {
  it('should strip trailing backslash before completing', () => {
    const raw = '{"key": "value\\';
    const result = repairToolCallJsonArguments(raw);
    expect(result.status).toBe('repaired');
    expect(result.input).toEqual({ key: 'value' });
  });

  it('should complete truncated boolean/null literals', () => {
    const boolResult = repairToolCallJsonArguments('{"active": tr');
    expect(boolResult.status).toBe('repaired');
    expect(boolResult.input).toEqual({ active: true });

    const nullResult = repairToolCallJsonArguments('{"data": nul');
    expect(nullResult.status).toBe('repaired');
    expect(nullResult.input).toEqual({ data: null });
  });
});
