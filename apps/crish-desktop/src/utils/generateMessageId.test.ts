import { describe, expect, it } from 'vitest';
import { generateMessageId, resetCounter } from './generateMessageId';

describe('generateMessageId', () => {
  it('uses role-msg prefix and includes entropy beyond Date.now', () => {
    resetCounter();
    const id = generateMessageId('user');
    expect(id.startsWith('user-msg-')).toBe(true);
    // ts + rand + seq → 至少 3 段连字符分隔的后缀
    const parts = id.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts[0]).toBe('user');
    expect(parts[1]).toBe('msg');
  });

  it('same-ms batch produces unique ids via counter', () => {
    resetCounter();
    const ids = new Set(
      Array.from({ length: 32 }, () => generateMessageId('assistant'))
    );
    expect(ids.size).toBe(32);
    for (const id of ids) {
      expect(id.startsWith('assistant-msg-')).toBe(true);
    }
  });
});
