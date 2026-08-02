import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
    },
    configurable: true,
  });
});

vi.mock('./projectStore', () => ({
  getWorkspacePath: vi.fn(() => '/workspace/test-project'),
}));

import {
  getExtraSkillDirs,
  addExtraSkillDir,
  removeExtraSkillDir,
  setSkillActivation,
  skillsToSlashCommands,
  resolveSkillSlash,
  formatSkillInjection,
  type DesktopSkill,
} from './skillsApi';

describe('skillsApi', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe('Extra Skills Directories', () => {
    it('manages extra skills directory paths in localStorage', () => {
      expect(getExtraSkillDirs()).toEqual([]);

      const updated = addExtraSkillDir('/custom/skills/dir');
      expect(updated).toEqual(['/custom/skills/dir']);
      expect(getExtraSkillDirs()).toEqual(['/custom/skills/dir']);

      // Prevents duplicates
      addExtraSkillDir('/custom/skills/dir');
      expect(getExtraSkillDirs()).toHaveLength(1);

      removeExtraSkillDir('/custom/skills/dir');
      expect(getExtraSkillDirs()).toEqual([]);
    });
  });

  describe('Skill Activation', () => {
    it('sets skill activation state and stores in localStorage', async () => {
      const mockSkill: DesktopSkill = {
        id: 'skill-review',
        name: 'code-review',
        description: 'Code Review Skill',
        filePath: '/workspace/.conex/skills/code-review/SKILL.md',
        baseDir: '/workspace/.conex/skills/code-review',
        content: 'Review code carefully',
        raw: '',
        scope: 'project',
        activation: 'recommended',
        tags: [],
        appliesTo: [],
        disableModelInvocation: false,
      };

      const result = await setSkillActivation(mockSkill, 'disabled');
      expect(result.ok).toBe(true);
      // T03.7：scoped-context 本地-only，engineSynced 恒 false
      expect(result.engineSynced).toBe(false);
    });
  });

  describe('Skill Slash Commands & Injection Formatting', () => {
    const activeSkill: DesktopSkill = {
      id: 'skill-1',
      name: 'code-review',
      description: 'Runs automated code review',
      filePath: '/skills/code-review/SKILL.md',
      baseDir: '/skills/code-review',
      content: '## Instructions\nRead code line by line.',
      raw: '--- name: code-review ---',
      scope: 'project',
      activation: 'enabled',
      tags: ['git'],
      appliesTo: ['*'],
      disableModelInvocation: false,
    };

    it('generates slash commands from enabled desktop skills', () => {
      const disabledSkill: DesktopSkill = {
        ...activeSkill,
        id: 'skill-2',
        name: 'disabled-skill',
        activation: 'disabled',
      };

      const slashCommands = skillsToSlashCommands([activeSkill, disabledSkill]);
      expect(slashCommands).toHaveLength(1);
      expect(slashCommands[0].cmd).toBe('/skill:code-review');
      expect(slashCommands[0].skillId).toBe('skill-1');
    });

    it('resolves skill slash command input string', async () => {
      const match = await resolveSkillSlash('/skill:code-review please check src/index.ts', [activeSkill]);
      expect(match).not.toBeNull();
      expect(match?.skill.id).toBe('skill-1');
      expect(match?.rest).toBe('please check src/index.ts');
    });

    it('formats skill prompt injection', () => {
      const injected = formatSkillInjection(activeSkill, 'check PR #42');
      expect(injected).toContain('【技能：code-review】');
      expect(injected).toContain('Instructions');
      expect(injected).toContain('check PR #42');
    });
  });
});
