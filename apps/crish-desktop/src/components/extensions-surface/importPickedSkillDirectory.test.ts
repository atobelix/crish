import { describe, expect, it } from 'vitest';
import { collectSkillFileTargets } from './importPickedSkillDirectory';

describe('collectSkillFileTargets', () => {
  it('uses the folder name when the selected directory itself is a skill', () => {
    expect(
      collectSkillFileTargets('C:/outside/resume-master', [
        { name: 'SKILL.md', isDir: false },
        { name: 'notes', isDir: true },
      ])
    ).toEqual([
      {
        name: 'resume-master',
        filePath: 'C:/outside/resume-master/SKILL.md',
      },
    ]);
  });

  it('collects child skills and skips hidden directories', () => {
    expect(
      collectSkillFileTargets('/skills', [
        { name: '.hidden', is_dir: true },
        { name: 'alpha', is_dir: true },
        { name: 'README.md', is_dir: false },
      ])
    ).toEqual([{ name: 'alpha', filePath: '/skills/alpha/SKILL.md' }]);
  });

  it('returns nothing when the directory has no skill folders', () => {
    expect(
      collectSkillFileTargets('/empty', [{ name: 'notes.txt', isDir: false }])
    ).toEqual([]);
  });
});
