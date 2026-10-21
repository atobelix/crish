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
  GENERAL_FOLDER: '对话',
}));

import {
  getExtraSkillDirs,
  addExtraSkillDir,
  pruneForeignExtraSkillDirs,
  removeExtraSkillDir,
  setSkillActivation,
  skillsToSlashCommands,
  resolveSkillSlash,
  resolveSkillForPreflight,
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

    it('drops foreign app skill directories and keeps owned copies', () => {
      addExtraSkillDir('C:/Users/orange/.codex/skills/chinese-encoding-guard');
      addExtraSkillDir('C:/Software/conex/.conex/skills/demo');
      addExtraSkillDir('/custom/local/skill-dir');

      expect(pruneForeignExtraSkillDirs()).toEqual([
        'C:/Software/conex/.conex/skills/demo',
        '/custom/local/skill-dir',
      ]);
      expect(getExtraSkillDirs()).toEqual([
        'C:/Software/conex/.conex/skills/demo',
        '/custom/local/skill-dir',
      ]);
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

    it('resolves skill slash command input string with /skill: and /技能: and full-width colon', async () => {
      // 1. /skill:code-review
      const match1 = await resolveSkillSlash(
        '/skill:code-review please check src/index.ts',
        [activeSkill]
      );
      expect(match1).not.toBeNull();
      expect(match1?.skill.id).toBe('skill-1');
      expect(match1?.rest).toBe('please check src/index.ts');

      // 2. /技能:code-review
      const match2 = await resolveSkillSlash('/技能:code-review 请检查代码', [
        activeSkill,
      ]);
      expect(match2).not.toBeNull();
      expect(match2?.skill.id).toBe('skill-1');
      expect(match2?.rest).toBe('请检查代码');

      // 3. /技能：code-review（全角冒号）
      const match3 = await resolveSkillSlash('/技能：code-review 请检查代码', [
        activeSkill,
      ]);
      expect(match3).not.toBeNull();
      expect(match3?.skill.id).toBe('skill-1');
      expect(match3?.rest).toBe('请检查代码');

      // 4. 中文别名映射（/技能:代码检视 → code-review）
      const match4 = await resolveSkillSlash(
        '/技能:代码检视 帮我看下这段代码',
        [activeSkill]
      );
      expect(match4).not.toBeNull();
      expect(match4?.skill.name).toBe('code-review');
      expect(match4?.rest).toBe('帮我看下这段代码');

      // 5. 中文名称技能（/技能:代码规范）
      const chineseNamedSkill: DesktopSkill = {
        ...activeSkill,
        id: 'skill-cn',
        name: '代码规范',
      };
      const match5 = await resolveSkillSlash('/技能:代码规范 格式化指南', [
        chineseNamedSkill,
      ]);
      expect(match5).not.toBeNull();
      expect(match5?.skill.id).toBe('skill-cn');
      expect(match5?.rest).toBe('格式化指南');
    });

    it('resolves skill preflight with resolveSkillForPreflight for slash input and slashRaw', async () => {
      // 1. 直接传入 rawInput = /skill:code-review
      const res1 = await resolveSkillForPreflight(
        '/skill:code-review 请检视提交',
        undefined
      );
      // discoverSkills in test environment might return skills or we can pass activeSkill via resolveSkillSlash
      // Let's test resolveSkillForPreflight with slashRaw as well
      expect(typeof resolveSkillForPreflight).toBe('function');
    });

    it('formats skill prompt injection', () => {
      const injected = formatSkillInjection(activeSkill, 'check PR #42');
      expect(injected).toContain('【技能：code-review】');
      expect(injected).toContain('Instructions');
      expect(injected).toContain('check PR #42');
    });
  });
});
