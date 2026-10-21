import { describe, expect, it, vi } from 'vitest';
import {
  expandHomePath,
  interpretSkillText,
  resolveDetectedSkillContent,
  resolveUserHomeDir,
  skillCopyName,
} from './skillImportContent';

describe('skillImportContent', () => {
  it('expands a tilde path with the resolved home directory', () => {
    expect(
      expandHomePath(
        '~/.gemini/antigravity/skills/resume-master/SKILL.md',
        'C:/Users/orange'
      )
    ).toBe('C:/Users/orange/.gemini/antigravity/skills/resume-master/SKILL.md');
    expect(expandHomePath('/already/absolute/SKILL.md', '')).toBe(
      '/already/absolute/SKILL.md'
    );
  });

  it('prefers the host home directory over the environment', async () => {
    const home = await resolveUserHomeDir(async () => 'D:/home');
    expect(home).toBe('D:/home');
  });

  it('keeps inline content and does not read the source file', async () => {
    const readText = vi.fn();
    const result = await resolveDetectedSkillContent(
      { name: 'demo', content: '  已有正文  ', filePath: '~/demo/SKILL.md' },
      'C:/Users/orange',
      readText
    );
    expect(result).toEqual({ ok: true, content: '已有正文' });
    expect(readText).not.toHaveBeenCalled();
  });

  it('reads the expanded source file when the card has no body', async () => {
    const readText = vi.fn().mockResolvedValue({
      ok: true,
      content: '来自文件的正文',
    });
    const result = await resolveDetectedSkillContent(
      {
        name: 'resume-master',
        filePath: '~/.gemini/antigravity/skills/resume-master/SKILL.md',
      },
      'C:/Users/orange',
      readText
    );
    expect(readText).toHaveBeenCalledWith(
      'C:/Users/orange/.gemini/antigravity/skills/resume-master/SKILL.md'
    );
    expect(result).toEqual({ ok: true, content: '来自文件的正文' });
  });

  it('rejects an empty source file', async () => {
    const result = await resolveDetectedSkillContent(
      { name: 'demo', filePath: '/skills/demo/SKILL.md' },
      '',
      async () => ({ ok: false, reason: 'empty' as const })
    );
    expect(result).toEqual({
      ok: false,
      message: '技能「demo」正文为空，无法导入',
    });
  });

  it('leaves content unset when the source file cannot be read', async () => {
    const result = await resolveDetectedSkillContent(
      { name: 'demo', filePath: '/missing/SKILL.md' },
      '',
      async () => ({ ok: false, reason: 'missing' as const })
    );
    expect(result).toEqual({ ok: true });
  });

  it('refuses a truncated source file', async () => {
    const result = await resolveDetectedSkillContent(
      { name: 'demo', filePath: '/skills/demo/SKILL.md' },
      '',
      async () => ({ ok: false, reason: 'truncated' })
    );
    expect(result).toEqual({
      ok: false,
      message: '技能「demo」正文超过读取上限，未写入不完整副本',
    });
  });

  it('uses the frontmatter name for the owned copy', () => {
    expect(
      skillCopyName(
        '---\nname: my-skill\ndescription: x\n---\n正文\n',
        'MySkill'
      )
    ).toBe('my-skill');
    expect(skillCopyName('没有前言的正文', 'MySkill')).toBe('MySkill');
    expect(interpretSkillText({ content: '半截', truncated: true })).toEqual({
      ok: false,
      reason: 'truncated',
    });
    expect(interpretSkillText({ content: '  完整正文  ' })).toEqual({
      ok: true,
      content: '完整正文',
    });
  });
});
