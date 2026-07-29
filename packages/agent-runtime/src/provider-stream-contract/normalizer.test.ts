import { describe, expect, it } from 'vitest';
import { legacyFinishReason } from './normalizer';

describe('normalizer', () => {
  it('should pass through length finish reason', () => {
    expect(legacyFinishReason('length')).toBe('length');
  });

  it('should map max_tokens to length', () => {
    expect(legacyFinishReason('max_tokens')).toBe('length');
  });
});
