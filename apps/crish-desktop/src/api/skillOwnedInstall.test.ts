import { describe, expect, it, vi } from 'vitest';
import {
  installOwnedSkillPreferringProject,
  type SkillCopyWriters,
} from './skillOwnedInstall';

function writers(
  project: SkillCopyWriters['createProjectSkill'],
  global: SkillCopyWriters['createGlobalSkill']
): SkillCopyWriters {
  return { createProjectSkill: project, createGlobalSkill: global };
}

describe('installOwnedSkillPreferringProject', () => {
  it('stops after the project copy is written', async () => {
    const createProjectSkill = vi.fn().mockResolvedValue({
      ok: true,
      skillPath: '/ws/.conex/skills/demo/SKILL.md',
      skillDir: '/ws/.conex/skills/demo',
    });
    const createGlobalSkill = vi.fn();
    const result = await installOwnedSkillPreferringProject(
      { name: 'demo', description: '说明', content: '正文', overwrite: true },
      writers(createProjectSkill, createGlobalSkill)
    );
    expect(result).toEqual({
      ok: true,
      scope: 'project',
      skillPath: '/ws/.conex/skills/demo/SKILL.md',
      skillDir: '/ws/.conex/skills/demo',
    });
    expect(createGlobalSkill).not.toHaveBeenCalled();
  });

  it('falls back to the global library when the project copy fails', async () => {
    const createProjectSkill = vi.fn().mockResolvedValue({
      ok: false,
      error: '未打开工作区',
    });
    const createGlobalSkill = vi.fn().mockResolvedValue({
      ok: true,
      skillPath: '/home/.crish/skills/demo/SKILL.md',
      skillDir: '/home/.crish/skills/demo',
    });
    const result = await installOwnedSkillPreferringProject(
      { name: 'demo', homeDir: '/home', overwrite: true },
      writers(createProjectSkill, createGlobalSkill)
    );
    expect(result).toMatchObject({ ok: true, scope: 'global' });
    expect(createGlobalSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo', homeDir: '/home' })
    );
  });

  it('returns the project error when neither library accepts the copy', async () => {
    const result = await installOwnedSkillPreferringProject(
      { name: 'demo' },
      writers(
        vi.fn().mockResolvedValue({ ok: false, error: '项目写入失败' }),
        vi.fn().mockResolvedValue({ ok: false, error: '全局写入失败' })
      )
    );
    expect(result).toEqual({ ok: false, error: '项目写入失败' });
  });
});
