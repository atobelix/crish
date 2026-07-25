// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSkillsSettingsState, skillSlashCmd, scopeGroupLabel } from './useSkillsSettingsState';

vi.mock('../../api/skillsApi', () => ({
  addExtraSkillDir: vi.fn(),
  createProjectSkill: vi.fn(async () => ({ ok: true, skillPath: '/path/to/SKILL.md' })),
  discoverSkills: vi.fn(async () => ({
    skills: [
      {
        id: 'skill-1',
        name: 'test-skill',
        description: 'Test skill desc',
        scope: 'project',
        activation: 'enabled',
        system: false,
        tags: ['test'],
        filePath: '/path/to/SKILL.md',
        raw: '# test-skill',
        content: 'content',
      },
    ],
  })),
  getExtraSkillDirs: vi.fn(() => []),
  invalidateSkillSlashCache: vi.fn(),
  pickSkillDirectory: vi.fn(async () => '/extra/dir'),
  removeExtraSkillDir: vi.fn(),
  setSkillActivation: vi.fn(async () => ({ daemonSynced: true })),
  skillsFsAvailable: vi.fn(async () => true),
  syncSkillsToDaemon: vi.fn(async () => ({ ok: 1, fail: 0 })),
}));

vi.mock('../../api/projectStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/projectStore')>();
  return {
    ...actual,
    getWorkspacePath: vi.fn(() => '/workspace'),
    listSettingsScopeProjects: vi.fn(() => [{ path: '/workspace', name: 'My Workspace' }]),
    projectFolderLabel: vi.fn((p: string) => p),
  };
});

vi.mock('../../api/markdownRender', () => ({
  parseMarkdownToHtml: vi.fn((md) => `<p>${md}</p>`),
}));

vi.mock('../../api/clientApi', () => ({
  clientApi: {
    getSettings: vi.fn(async () => ({ enableSkillCommands: true })),
    saveSettingsEx: vi.fn(async () => ({})),
  },
}));

describe('useSkillsSettingsState', () => {
  it('formats slash command correctly', () => {
    expect(skillSlashCmd('My Skill')).toBe('/skill:my-skill');
  });

  it('formats scope group label', () => {
    expect(scopeGroupLabel('global', 'Proj')).toBe('全局');
    expect(scopeGroupLabel('workspace', 'Proj')).toBe('Proj');
  });

  it('initializes skills and handles activation changes', async () => {
    const { result } = renderHook(() => useSkillsSettingsState());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.skills.length).toBe(1);
    expect(result.current.selectedId).toBe('skill-1');

    await act(async () => {
      await result.current.setActivation(result.current.skills[0]!, 'disabled');
    });

    expect(result.current.skills[0]?.activation).toBe('disabled');
  });
});
