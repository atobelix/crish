import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECENT_MESSAGE_COUNT,
  nextExpandedOlder,
  windowMessages,
} from './messageWindow';

describe('windowMessages', () => {
  const msgs = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}` }));

  it('returns all when length <= recentCount', () => {
    const short = msgs.slice(0, 10);
    const r = windowMessages(short, { recentCount: 80 });
    expect(r.visible).toHaveLength(10);
    expect(r.hiddenCount).toBe(0);
    expect(r.hasOlder).toBe(false);
    expect(r.startIndex).toBe(0);
  });

  it('windows long lists to recent tail', () => {
    const r = windowMessages(msgs, { recentCount: 80, expandedOlder: 0 });
    expect(r.visible).toHaveLength(80);
    expect(r.hiddenCount).toBe(40);
    expect(r.hasOlder).toBe(true);
    expect(r.startIndex).toBe(40);
    expect(r.visible[0].id).toBe('m40');
    expect(r.visible[r.visible.length - 1].id).toBe('m119');
  });

  it('expandedOlder reveals more history', () => {
    const r = windowMessages(msgs, { recentCount: 80, expandedOlder: 40 });
    expect(r.visible).toHaveLength(120);
    expect(r.hiddenCount).toBe(0);
    expect(r.hasOlder).toBe(false);
  });

  it('showAll bypasses window', () => {
    const r = windowMessages(msgs, { showAll: true, recentCount: 5 });
    expect(r.visible).toHaveLength(120);
    expect(r.hiddenCount).toBe(0);
  });

  it('DEFAULT_RECENT_MESSAGE_COUNT is 80', () => {
    expect(DEFAULT_RECENT_MESSAGE_COUNT).toBe(80);
  });
});

describe('nextExpandedOlder', () => {
  it('adds step capped by hiddenCount', () => {
    expect(nextExpandedOlder(0, 100, 40)).toBe(40);
    expect(nextExpandedOlder(0, 10, 40)).toBe(10);
    expect(nextExpandedOlder(40, 0, 40)).toBe(40);
  });
});
