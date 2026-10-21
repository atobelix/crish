import { beforeEach, describe, expect, it, vi } from 'vitest';
import { skillCopyWriters } from '../../api/skillOwnedInstall';
import * as skillsApi from '../../api/skillsApi';
import { importDetectedSkill } from './importDetectedSkill';

describe('importDetectedSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(skillCopyWriters, 'createProjectSkill').mockResolvedValue({
      ok: true,
      skillPath: '/ws/.conex/skills/demo/SKILL.md',
      skillDir: '/ws/.conex/skills/demo',
    });
    vi.spyOn(skillCopyWriters, 'createGlobalSkill').mockResolvedValue({
      ok: false,
      error: '不应走到全局',
    });
    vi.spyOn(skillsApi, 'setSkillActivation').mockResolvedValue({
      ok: true,
      engineSynced: false,
    });
  });

  it('rejects a disallowed skill before any copy is written', async () => {
    const result = await importDetectedSkill({
      id: 'plugin',
      name: 'plugin',
      description: '宿主私有',
      source: 'Cursor',
      filePath: '/tmp/plugin/SKILL.md',
      skillDir: '/tmp/plugin',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('禁止导入');
    expect(skillCopyWriters.createProjectSkill).not.toHaveBeenCalled();
    expect(skillsApi.setSkillActivation).not.toHaveBeenCalled();
  });

  it('enables the skill only after the owned copy is written', async () => {
    const result = await importDetectedSkill({
      id: 'demo',
      name: 'demo-skill',
      description: '示例技能说明，长度足够通过校验',
      source: 'Local',
      filePath: '',
      skillDir: '',
      content:
        '这是一段足够长的技能正文，用来通过导入前的合规检查，并确认副本写入后才会启用。',
    });
    expect(result).toEqual({
      ok: true,
      message: '已成功将技能「demo-skill」导入当前工作区并启用',
    });
    expect(skillCopyWriters.createProjectSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'demo-skill',
        content: expect.stringContaining('足够长的技能正文'),
      })
    );
    expect(skillCopyWriters.createGlobalSkill).not.toHaveBeenCalled();
    expect(skillsApi.setSkillActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'demo-skill',
        scope: 'project',
        activation: 'enabled',
      }),
      'enabled'
    );
  });

  it('does not enable the skill when both copies fail', async () => {
    vi.mocked(skillCopyWriters.createProjectSkill).mockResolvedValue({
      ok: false,
      error: '项目写入失败',
    });
    vi.mocked(skillCopyWriters.createGlobalSkill).mockResolvedValue({
      ok: false,
      error: '全局写入失败',
    });
    const result = await importDetectedSkill({
      id: 'demo',
      name: 'demo-skill',
      description: '示例',
      source: 'Local',
      filePath: '',
      skillDir: '',
      content:
        '这是一段足够长的技能正文，用来通过导入前的合规检查，并确认副本写入后才会启用。',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('项目写入失败');
    expect(skillsApi.setSkillActivation).not.toHaveBeenCalled();
  });
});
