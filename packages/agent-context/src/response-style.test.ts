import { describe, expect, it } from 'vitest';
import {
  mergeSystemPromptWithResponseStyle,
  normalizeResponseStyleLevel,
  responseStyleSystemGuidance,
} from './response-style';

describe('response-style', () => {
  it('normalizes english and chinese labels', () => {
    expect(normalizeResponseStyleLevel('high')).toBe('high');
    expect(normalizeResponseStyleLevel('深入')).toBe('high');
    expect(normalizeResponseStyleLevel('garbage')).toBe('medium');
  });

  it('emits distinct guidance per level', () => {
    expect(responseStyleSystemGuidance('minimal')).toContain('minimal');
    expect(responseStyleSystemGuidance('high')).toContain('thorough');
  });

  it('merges without duplicating style block', () => {
    const once = mergeSystemPromptWithResponseStyle('Be helpful.', 'low');
    expect(once).toContain('Be helpful.');
    expect(once).toContain('Response style:');
    const twice = mergeSystemPromptWithResponseStyle(once, 'high');
    expect(twice).toBe(once);
  });
});
