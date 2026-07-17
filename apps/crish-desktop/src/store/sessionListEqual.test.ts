import { describe, expect, it } from 'vitest';
import {
  sessionShellEqual,
  sessionShellFingerprint,
  sessionsShellEqual,
  sessionsSidebarEqual,
  sidebarSessionsEqual,
} from './sessionListEqual';
import type { SessionState } from './types';

function sess(partial: Partial<SessionState> & { id: string }): SessionState {
  return {
    title: 't',
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: '2026-01-01T00:00:00.000Z',
    messages: [],
    ...partial,
  };
}

describe('sessionShellEqual', () => {
  it('same reference is equal', () => {
    const a = sess({ id: 'a' });
    expect(sessionShellEqual(a, a)).toBe(true);
  });

  it('ignores message body changes when length/status shell same', () => {
    const a = sess({
      id: 'a',
      messages: [{ id: 'm1', sender: 'user', text: 'hello', timestamp: 1 }],
    });
    const b = sess({
      id: 'a',
      messages: [{ id: 'm1', sender: 'user', text: 'hello world stream…', timestamp: 1 }],
    });
    expect(sessionShellEqual(a, b)).toBe(true);
  });

  it('detects processing badge flip', () => {
    const a = sess({
      id: 'a',
      messages: [
        { id: 'm1', sender: 'assistant', text: '', timestamp: 1, status: 'processing' },
      ],
    });
    const b = sess({
      id: 'a',
      messages: [
        { id: 'm1', sender: 'assistant', text: 'done', timestamp: 1, status: 'completed' },
      ],
    });
    expect(sessionShellEqual(a, b)).toBe(false);
  });

  it('detects message length change', () => {
    const a = sess({ id: 'a', messages: [] });
    const b = sess({
      id: 'a',
      messages: [{ id: 'm1', sender: 'user', text: 'x', timestamp: 1 }],
    });
    expect(sessionShellEqual(a, b)).toBe(false);
  });

  it('detects agents shell fingerprint change', () => {
    const a = sess({
      id: 'a',
      agents: [{ id: 'ag1', status: 'running', description: 'scan' } as never],
    });
    const b = sess({
      id: 'a',
      agents: [{ id: 'ag1', status: 'completed', description: 'scan' } as never],
    });
    expect(sessionShellEqual(a, b)).toBe(false);
  });

  it('detects last-message activity ms change without body/length flip', () => {
    const a = sess({
      id: 'a',
      messages: [{ id: 'm1', sender: 'user', text: 'x', timestamp: 100 }],
    });
    const b = sess({
      id: 'a',
      messages: [{ id: 'm1', sender: 'user', text: 'x', timestamp: 999 }],
    });
    expect(sessionShellEqual(a, b)).toBe(false);
  });
});

describe('sidebarSessionsEqual', () => {
  it('returns true for identical shell arrays (new refs)', () => {
    const a = [sess({ id: '1' }), sess({ id: '2', title: 'B' })];
    const b = [sess({ id: '1' }), sess({ id: '2', title: 'B' })];
    expect(sidebarSessionsEqual(a, b)).toBe(true);
    expect(sessionsShellEqual(a, b)).toBe(true);
  });

  it('needMessageBodies forces inequality on any new array ref', () => {
    const a = [sess({ id: '1' })];
    const b = [sess({ id: '1' })];
    expect(sidebarSessionsEqual(a, b, true)).toBe(false);
    expect(sessionsSidebarEqual(a, b, true)).toBe(false);
  });

  it('detects reordering', () => {
    const a = [sess({ id: '1' }), sess({ id: '2' })];
    const b = [sess({ id: '2' }), sess({ id: '1' })];
    expect(sidebarSessionsEqual(a, b)).toBe(false);
  });

  it('sessionsShellEqual treats undefined as unequal', () => {
    expect(sessionsShellEqual(undefined, [])).toBe(false);
    expect(sessionsShellEqual(undefined, undefined)).toBe(true);
  });
});

describe('sessionShellFingerprint', () => {
  it('is stable across message body edits', () => {
    const a = sess({
      id: 'x',
      messages: [{ id: 'm', sender: 'user', text: 'a', timestamp: 1 }],
    });
    const b = sess({
      id: 'x',
      messages: [{ id: 'm', sender: 'user', text: 'ab', timestamp: 1 }],
    });
    expect(sessionShellFingerprint(a)).toBe(sessionShellFingerprint(b));
  });

  it('changes when title changes', () => {
    const a = sess({ id: 'x', title: 'A' });
    const b = sess({ id: 'x', title: 'B' });
    expect(sessionShellFingerprint(a)).not.toBe(sessionShellFingerprint(b));
  });

  it('changes when activity shell ms changes', () => {
    const a = sess({
      id: 'x',
      messages: [{ id: 'm', sender: 'user', text: 'a', timestamp: 1 }],
    });
    const b = sess({
      id: 'x',
      messages: [{ id: 'm', sender: 'user', text: 'a', timestamp: 2 }],
    });
    expect(sessionShellFingerprint(a)).not.toBe(sessionShellFingerprint(b));
  });
});
