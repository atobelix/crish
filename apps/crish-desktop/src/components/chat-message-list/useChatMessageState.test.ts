/**
 * Pure pin helpers — no React / store. OPT-D8: pin path must not depend on a
 * second full-messages store subscription; parent passes allMessages.
 */
import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../store/types';
import {
  buildPinnedItems,
  pinnedItemsEqual,
} from './useChatMessageState';

function msg(
  partial: Pick<SessionMessage, 'id' | 'sender'> &
    Partial<SessionMessage>
): SessionMessage {
  return {
    text: '',
    status: 'completed',
    timestamp: 0,
    ...partial,
  } as SessionMessage;
}

describe('buildPinnedItems', () => {
  it('returns empty stable list when no pins', () => {
    const a = buildPinnedItems([], [msg({ id: '1', sender: 'user', text: 'hi' })]);
    const b = buildPinnedItems([], []);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    // Same EMPTY_PINNED_ITEMS reference for memo stability
    expect(a).toBe(b);
  });

  it('resolves pins from full list by id (filter-safe upsert)', () => {
    const all: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'question one' }),
      msg({ id: 'a1', sender: 'assistant', text: 'answer one' }),
      msg({ id: 'u2', sender: 'user', text: 'question two' }),
    ];
    const items = buildPinnedItems(['a1', 'u2'], all);
    expect(items).toEqual([
      { id: 'a1', sender: 'assistant', snippet: 'answer one' },
      { id: 'u2', sender: 'user', snippet: 'question two' },
    ]);
  });

  it('skips missing ids and non user/assistant senders', () => {
    const all: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'keep' }),
      msg({ id: 'sys', sender: 'system' as SessionMessage['sender'], text: 'nope' }),
    ];
    const items = buildPinnedItems(['missing', 'sys', 'u1'], all);
    expect(items).toEqual([{ id: 'u1', sender: 'user', snippet: 'keep' }]);
  });

  it('preserves pin id order from pinnedMessageIds', () => {
    const all: SessionMessage[] = [
      msg({ id: 'a', sender: 'user', text: 'A' }),
      msg({ id: 'b', sender: 'user', text: 'B' }),
    ];
    expect(buildPinnedItems(['b', 'a'], all).map((p) => p.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('truncates long snippets via pinSnippet', () => {
    const long = 'x'.repeat(100);
    const items = buildPinnedItems(
      ['u1'],
      [msg({ id: 'u1', sender: 'user', text: long })]
    );
    expect(items[0]?.snippet.length).toBeLessThanOrEqual(73);
    expect(items[0]?.snippet.endsWith('…')).toBe(true);
  });
});

describe('pinnedItemsEqual', () => {
  it('is true for same reference and equal content', () => {
    const a = [{ id: '1', sender: 'user' as const, snippet: 'hi' }];
    expect(pinnedItemsEqual(a, a)).toBe(true);
    expect(
      pinnedItemsEqual(a, [{ id: '1', sender: 'user', snippet: 'hi' }])
    ).toBe(true);
  });

  it('is false when id / sender / snippet differ (stream text on pin)', () => {
    const base = [{ id: '1', sender: 'user' as const, snippet: 'hi' }];
    expect(
      pinnedItemsEqual(base, [{ id: '1', sender: 'user', snippet: 'hi!' }])
    ).toBe(false);
    expect(
      pinnedItemsEqual(base, [
        { id: '1', sender: 'assistant', snippet: 'hi' },
      ])
    ).toBe(false);
    expect(
      pinnedItemsEqual(base, [{ id: '2', sender: 'user', snippet: 'hi' }])
    ).toBe(false);
  });

  it('guards virtualizer: non-pin message stream does not change pin equality', () => {
    // Simulate two buildPinnedItems results when only a non-pinned row's text changed
    const pins = ['p1'] as const;
    const baseMsgs = [
      msg({ id: 'p1', sender: 'user', text: 'pinned' }),
      msg({ id: 'live', sender: 'assistant', text: 'tok' }),
    ];
    const streamedMsgs = [
      msg({ id: 'p1', sender: 'user', text: 'pinned' }),
      msg({ id: 'live', sender: 'assistant', text: 'token stream…' }),
    ];
    const a = buildPinnedItems(pins, baseMsgs);
    const b = buildPinnedItems(pins, streamedMsgs);
    expect(pinnedItemsEqual(a, b)).toBe(true);
  });
});
