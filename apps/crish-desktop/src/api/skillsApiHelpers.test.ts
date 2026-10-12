import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVATION_KEY,
  EXTRA_DIRS_KEY,
  ALLOWED_DOT_DIRS,
  joinPath,
  basename,
  dirname,
  legacySkillIdFromPath,
  resolveActivationFromMap,
  normalizeSlashName,
  parseFrontmatter,
  stringList,
  skillScope,
  skillActivation,
  firstMarkdownSentence,
  loadActivationMap,
  saveActivationMap,
} from './skillsApiHelpers';

describe('skillsApiHelpers', () => {
  describe('Constants', () => {
    it('defines expected storage keys and dot dirs', () => {
      expect(ACTIVATION_KEY).toBe('crish_skill_activation_v1'); // gitleaks:allow
      expect(EXTRA_DIRS_KEY).toBe('crish_skill_extra_dirs_v1'); // gitleaks:allow
      expect(ALLOWED_DOT_DIRS.has('.system')).toBe(true);
    });
  });

  describe('Path utilities', () => {
    it('joinPath joins paths with appropriate separator', () => {
      expect(joinPath('', 'file.txt')).toBe('file.txt');
      expect(joinPath('/path/to', 'file.txt')).toBe('/path/to/file.txt');
      expect(joinPath('C:\\path\\to', 'file.txt')).toBe(
        'C:\\path\\to\\file.txt'
      );
      expect(joinPath('/path/to/', 'file.txt')).toBe('/path/to/file.txt');
    });

    it('basename extracts the file or directory name', () => {
      expect(basename('/path/to/file.txt')).toBe('file.txt');
      expect(basename('C:\\path\\to\\file.txt')).toBe('file.txt');
      expect(basename('file.txt')).toBe('file.txt');
      expect(basename('/path/to/dir/')).toBe('dir');
    });

    it('dirname extracts the directory portion', () => {
      expect(dirname('/path/to/file.txt')).toBe('/path/to');
      expect(dirname('C:\\path\\to\\file.txt')).toBe('C:\\path\\to');
      expect(dirname('file.txt')).toBe('file.txt');
    });
  });

  describe('Legacy ID and activation resolution', () => {
    it('legacySkillIdFromPath converts windows and unix paths to lowercased ID', () => {
      expect(legacySkillIdFromPath('C:\\Skills\\MySkill\\SKILL.md')).toBe(
        'skill-file:c:/skills/myskill/skill.md'
      );
    });

    it('resolveActivationFromMap returns direct match without migration', () => {
      const map = { skill_123: 'enabled' as const };
      const res = resolveActivationFromMap(map, 'skill_123', '/path/skill.md');
      expect(res).toEqual({ activation: 'enabled', migrated: false });
    });

    it('resolveActivationFromMap migrates legacy skill-file key', () => {
      const legacyKey = 'skill-file:/path/skill.md';
      const map = { [legacyKey]: 'recommended' as const };
      const res = resolveActivationFromMap(
        map,
        'skill_target',
        '/path/skill.md'
      );
      expect(res).toEqual({ activation: 'recommended', migrated: true });
      expect(map['skill_target']).toBe('recommended');
      expect(map[legacyKey]).toBeUndefined();
    });
  });

  describe('Slash command and frontmatter parsing', () => {
    it('normalizeSlashName sanitizes string into kebab-style', () => {
      expect(normalizeSlashName('  My Skill Name!  ')).toBe('my-skill-name');
      expect(normalizeSlashName('---test---')).toBe('test');
    });

    it('parseFrontmatter parses YAML frontmatter key-values', () => {
      const content = `---
name: test-skill
description: A helpful skill
enabled: true
draft: false
---
# Skill Body
Content here`;
      const { data, body } = parseFrontmatter(content);
      expect(data).toEqual({
        name: 'test-skill',
        description: 'A helpful skill',
        enabled: true,
        draft: false,
      });
      expect(body).toContain('# Skill Body');
    });

    it('parseFrontmatter handles content without frontmatter', () => {
      const content = 'No frontmatter content';
      const { data, body } = parseFrontmatter(content);
      expect(data).toEqual({});
      expect(body).toBe(content);
    });
  });

  describe('Type helpers', () => {
    it('stringList parses comma-separated lists and brackets', () => {
      expect(stringList('foo, bar, baz')).toEqual(['foo', 'bar', 'baz']);
      expect(stringList('["item1", "item2"]')).toEqual(['item1', 'item2']);
      expect(stringList(null)).toEqual([]);
    });

    it('skillScope validates scope', () => {
      expect(skillScope('global')).toBe('global');
      expect(skillScope('project')).toBe('project');
      expect(skillScope('workspace')).toBe('workspace');
      expect(skillScope('unknown')).toBeUndefined();
    });

    it('skillActivation validates activation state', () => {
      expect(skillActivation('enabled')).toBe('enabled');
      expect(skillActivation('recommended')).toBe('recommended');
      expect(skillActivation('disabled')).toBe('disabled');
      expect(skillActivation('other')).toBeUndefined();
    });

    it('firstMarkdownSentence extracts first non-heading sentence', () => {
      const md = '# Title\n\nThis is the description.\nMore text.';
      expect(firstMarkdownSentence(md)).toBe('This is the description.');
    });
  });

  describe('Activation storage helpers', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('loadActivationMap and saveActivationMap persist to localStorage', () => {
      expect(loadActivationMap()).toEqual({});
      const map = { skill_abc: 'enabled' as const };
      saveActivationMap(map);
      expect(loadActivationMap()).toEqual(map);
    });
  });
});
