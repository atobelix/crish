import { describe, expect, it } from 'vitest';
import { isConversationSlash, resolveSlashCommand } from './resolveSlashCommand';

describe('resolveSlashCommand', () => {
  it('returns none for plain text', () => {
    expect(resolveSlashCommand('hello')).toEqual({ kind: 'none', raw: 'hello' });
    expect(resolveSlashCommand('')).toEqual({ kind: 'none', raw: '' });
  });

  it('parses schedule / teamwork / browser', () => {
    expect(resolveSlashCommand('/schedule')).toEqual({ kind: 'schedule' });
    expect(resolveSlashCommand('/teamwork-preview')).toEqual({ kind: 'teamwork-preview' });
    expect(resolveSlashCommand('/browser https://a.com')).toEqual({
      kind: 'browser',
      url: 'https://a.com',
    });
    expect(resolveSlashCommand('/browser')).toEqual({ kind: 'browser', url: '' });
  });

  it('parses learn / goal / grill-me with missing args', () => {
    expect(resolveSlashCommand('/learn')).toMatchObject({ kind: 'learn', missingArg: true });
    expect(resolveSlashCommand('/learn no any')).toEqual({ kind: 'learn', rule: 'no any' });
    expect(resolveSlashCommand('/goal')).toMatchObject({ kind: 'goal', missingArg: true });
    expect(resolveSlashCommand('/goal fix tests')).toEqual({ kind: 'goal', goal: 'fix tests' });
    expect(resolveSlashCommand('/grill-me feature x')).toEqual({
      kind: 'grill-me',
      topic: 'feature x',
    });
  });

  it('parses skill command', () => {
    const r = resolveSlashCommand('/skill:foo do bar');
    expect(r.kind).toBe('skill');
    if (r.kind === 'skill') {
      expect(r.skillRest).toContain('foo');
    }
  });

  it('isConversationSlash', () => {
    expect(isConversationSlash('goal')).toBe(true);
    expect(isConversationSlash('schedule')).toBe(false);
  });
});
