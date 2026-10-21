import { describe, expect, it } from 'vitest';
import { isForeignExtraSkillDir } from './skillsApiFs';

describe('isForeignExtraSkillDir', () => {
  it('treats foreign app roots as external skill trees', () => {
    expect(isForeignExtraSkillDir('C:/Users/orange/.codex')).toBe(true);
    expect(isForeignExtraSkillDir('C:/Users/orange/.codex/skills/pkg')).toBe(
      true
    );
    expect(isForeignExtraSkillDir('C:/Users/orange/.gemini')).toBe(true);
    expect(isForeignExtraSkillDir('C:/Users/orange/.claude')).toBe(true);
    expect(isForeignExtraSkillDir('C:/Users/orange/.cursor')).toBe(true);
    expect(isForeignExtraSkillDir('C:/Users/orange/.agents')).toBe(true);
    expect(
      isForeignExtraSkillDir('C:/proj/.codex/skills/pkg/.conex/skills/nested')
    ).toBe(true);
  });

  it('keeps this app skill libraries', () => {
    expect(isForeignExtraSkillDir('C:/Software/conex/.conex/skills/demo')).toBe(
      false
    );
    expect(isForeignExtraSkillDir('C:/Users/orange/.crish/skills/demo')).toBe(
      false
    );
    expect(
      isForeignExtraSkillDir(
        'C:/Software/conex/.conex/skills/demo/.gemini/notes'
      )
    ).toBe(false);
  });
});
