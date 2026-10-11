import { describe, expect, it } from 'vitest';
import { diffContextStateSnapshot } from './contextStateDiff';

describe('diffContextStateSnapshot', () => {
  it('first snapshot (no previous) reports every present field', () => {
    const diff = diffContextStateSnapshot(null, {
      model: 'ornith-1.5-9b',
      profile: 'local',
      permission: 'ask',
      thinking: 'High',
    });
    expect(diff.changed).toEqual(['model', 'profile', 'permission', 'thinking']);
    expect(diff.fields).toEqual({
      model: 'ornith-1.5-9b',
      profile: 'local',
      permission: 'ask',
      thinking: 'High',
    });
  });

  it('reports only fields whose value changed', () => {
    const diff = diffContextStateSnapshot(
      {
        model: 'ornith-1.5-9b',
        profile: 'local',
        permission: 'ask',
        thinking: 'High',
      },
      {
        model: 'ornith-1.5-9b',
        profile: 'local',
        permission: 'full',
        thinking: 'High',
      }
    );
    expect(diff.changed).toEqual(['permission']);
    expect(diff.fields).toEqual({ permission: 'full' });
  });

  it('returns an empty changed list when nothing changed', () => {
    const prev = { model: 'm', permission: 'ask', thinking: 'High' };
    const diff = diffContextStateSnapshot(prev, { ...prev });
    expect(diff.changed).toEqual([]);
    expect(diff.fields).toEqual({});
  });

  it('ignores blank values and treats blank the same as missing', () => {
    const diff = diffContextStateSnapshot(
      { model: 'm', thinking: 'High' },
      { model: 'm', profile: '  ', permission: '', thinking: 'High' }
    );
    expect(diff.changed).toEqual([]);
  });
});
