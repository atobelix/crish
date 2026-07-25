import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zCoerceArray, zDefaultEmpty, zCoerceObject } from './common';

describe('validators/common', () => {
  it('should coerce single value to array', () => {
    const schema = zCoerceArray(z.string());
    expect(schema.parse('hello')).toEqual(['hello']);
    expect(schema.parse(['hello'])).toEqual(['hello']);
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('should default null/undefined to empty string', () => {
    const schema = zDefaultEmpty(z.string());
    expect(schema.parse('hello')).toBe('hello');
    expect(schema.parse(undefined)).toBe('');
    expect(schema.parse('')).toBe('');
  });

  it('should coerce primitive to { value } wrapper', () => {
    const schema = zCoerceObject(z.number());
    expect(schema.parse(42)).toEqual({ value: 42 });
    expect(schema.parse({ value: 42 })).toEqual({ value: 42 });
    expect(schema.parse({ value: 99 })).toEqual({ value: 99 });
  });
});
